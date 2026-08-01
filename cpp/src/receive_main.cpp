// sdi_receive — SMPTE 2022-7 protection-switch gateway.
//
// Receives one or two identical SRT/MPEG-TS streams (produced by sdi_stream
// with --dest2) and outputs a single de-duplicated stream to a downstream
// SRT destination.
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │  [encoder box]                                                   │
//   │  sdi_stream --dest 10.0.1.5:4200 --dest2 10.0.2.5:4200          │
//   │      │                         │                                 │
//   │   path 1 (ISP-A)           path 2 (ISP-B)                       │
//   │      ↓                         ↓                                 │
//   │  [this binary — sdi_receive]                                     │
//   │  2022-7 reassembly / dedup → single merged stream                │
//   │      ↓                                                           │
//   │  [receive.sh or downstream playout server]                       │
//   └─────────────────────────────────────────────────────────────────┘
//
// Usage (single path — acts as an SRT relay):
//     sdi_receive --src srt://:4200?mode=listener \
//                 --dest srt://playout:4300
//
// Usage (2022-7 with two redundant paths):
//     sdi_receive --src  srt://:4200?mode=listener \
//                 --src2 srt://:4201?mode=listener \
//                 --dest srt://playout:4300
//
// The --window flag (default 100ms) controls how long packets are held
// waiting for the duplicate from the second path. Set to 0 to disable
// deduplication (relay mode only).

#include "redundancy.h"
#include "srt_input.h"
#include "srt_output.h"
#include "stats_server.h"

#include <atomic>
#include <csignal>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

#ifdef _WIN32
#  include <windows.h>
#endif

namespace {

struct Args {
    std::string src        = "";             // srt://host:port or srt://:port?mode=listener
    std::string src2       = "";             // optional second path
    std::string dest       = "";             // downstream SRT destination
    int         latency_ms = 150;
    int         window_ms  = 100;            // 2022-7 reassembly window
    std::string passphrase = "";
    int         stats_port = 0;              // 0 = disabled
};

// Minimal JSON string escaping — SRT URIs realistically never contain quotes
// or control characters, but a passphrase might; escape defensively rather
// than assume.
std::string json_str(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

void usage() {
    std::cerr <<
R"(sdi_receive — SMPTE 2022-7 SRT protection-switch gateway
  --src  <srt-uri>    Primary SRT source (listener or caller)
  --src2 <srt-uri>    Secondary SRT source for 2022-7 (optional)
  --dest <srt-uri>    Downstream destination, e.g. srt://10.0.0.5:4300
  --latency <ms>      SRT latency for all connections (default: 150)
  --window  <ms>      2022-7 reassembly window in ms   (default: 100)
  --passphrase <s>    AES passphrase (applied to all connections)
  --stats-port <port> Serve a JSON health probe on this TCP port (optional).
                      GET anything → {"dual_path","path1_up","path2_up",
                      "output_connected","src","src2","dest"}. Meant to be
                      polled by a backend monitor over the network — the
                      existing 5s stderr heartbeat only reaches whoever is
                      watching this process's own console.

Examples:
  # Simple relay
  sdi_receive --src srt://:4200?mode=listener --dest srt://playout:4300

  # 2022-7 dual-path merge
  sdi_receive --src  srt://:4200?mode=listener \
              --src2 srt://:4201?mode=listener \
              --dest srt://playout:4300 --window 100
)";
}

bool parse_args(int argc, char** argv, Args& a) {
    for (int i = 1; i < argc; ++i) {
        auto arg = std::string_view(argv[i]);
        auto next = [&]() -> const char* {
            if (i + 1 >= argc) { usage(); std::exit(2); }
            return argv[++i];
        };
        if      (arg == "--src")        a.src        = next();
        else if (arg == "--src2")       a.src2       = next();
        else if (arg == "--dest")       a.dest       = next();
        else if (arg == "--latency")    a.latency_ms = std::atoi(next());
        else if (arg == "--window")     a.window_ms  = std::atoi(next());
        else if (arg == "--passphrase") a.passphrase = next();
        else if (arg == "--stats-port") a.stats_port = std::atoi(next());
        else if (arg == "-h" || arg == "--help") { usage(); return false; }
        else { std::cerr << "unknown arg: " << arg << "\n"; usage(); return false; }
    }
    if (a.src.empty() || a.dest.empty()) {
        std::cerr << "error: --src and --dest are required\n";
        usage();
        return false;
    }
    return true;
}

std::atomic<bool> g_stop{false};
void on_signal(int) { g_stop = true; }

#ifdef _WIN32
static BOOL WINAPI console_ctrl_handler(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
        g_stop.store(true, std::memory_order_release);
        return TRUE;
    }
    return FALSE;
}
#endif

} // namespace

int main(int argc, char** argv) {
    Args args;
    if (!parse_args(argc, argv, args)) return 2;

#ifdef _WIN32
    SetConsoleCtrlHandler(console_ctrl_handler, TRUE);
    std::signal(SIGINT, on_signal);
#else
    std::signal(SIGINT,  on_signal);
    std::signal(SIGTERM, on_signal);
#endif

    const bool dual_path = !args.src2.empty() && args.window_ms > 0;

    // Build a dest URI with srt:// prefix if needed.
    const std::string dest_uri = (args.dest.find("://") != std::string::npos)
        ? args.dest : "srt://" + args.dest;

    // We relay raw MPEG-TS AVPackets from SrtInput straight through to a
    // downstream SRT destination — no re-encode, just avcodec_parameters_copy
    // from the input stream(s) onto a matching output muxer built on first
    // packet (once we know the input's codec params — see init_output below).
    std::atomic<bool> output_ready{false};

    // Assigned right after each SrtInput is constructed, below, in whichever
    // branch runs (the same pointers already used there to safely read
    // format_context()) — reused here so the stats JSON provider can report
    // is_running() over the network. nullptr until then, and stays nullptr
    // for path 2 in single-path mode.
    std::atomic<sdi::SrtInput*> live_src1{nullptr};
    std::atomic<sdi::SrtInput*> live_src2{nullptr};

    auto build_stats_json = [&]() -> std::string {
        auto* p1 = live_src1.load();
        auto* p2 = live_src2.load();
        std::string j = "{";
        j += "\"dual_path\":";        j += dual_path ? "true" : "false";
        j += ",\"path1_up\":";        j += (p1 && p1->is_running()) ? "true" : "false";
        j += ",\"path2_up\":";        j += (p2 && p2->is_running()) ? "true" : "false";
        j += ",\"output_connected\":"; j += output_ready.load() ? "true" : "false";
        j += ",\"src\":\""  + json_str(args.src)  + "\"";
        j += ",\"src2\":\"" + json_str(args.src2) + "\"";
        j += ",\"dest\":\"" + json_str(dest_uri)  + "\"";
        j += "}";
        return j;
    };

    std::unique_ptr<sdi::StatsServer> stats_server;
    if (args.stats_port > 0) {
        stats_server = std::make_unique<sdi::StatsServer>(args.stats_port, build_stats_json);
        stats_server->start();
    }

    AVFormatContext* out_fmt = nullptr;
    AVStream*        out_vstream = nullptr;
    AVStream*        out_astream = nullptr;

    auto init_output = [&](const AVFormatContext* in_fmt) -> bool {
        if (output_ready.load()) return true;

        std::string url = dest_uri;
        url += (url.find('?') == std::string::npos) ? "?" : "&";
        url += "mode=caller&latency=" + std::to_string(args.latency_ms * 1000);
        if (!args.passphrase.empty())
            url += "&passphrase=" + args.passphrase + "&pbkeylen=16";

        if (avformat_alloc_output_context2(&out_fmt, nullptr, "mpegts", url.c_str()) < 0) {
            std::cerr << "sdi_receive: alloc output context failed\n";
            return false;
        }

        for (unsigned i = 0; i < in_fmt->nb_streams; ++i) {
            AVStream* out_s = avformat_new_stream(out_fmt, nullptr);
            avcodec_parameters_copy(out_s->codecpar, in_fmt->streams[i]->codecpar);
            out_s->time_base = in_fmt->streams[i]->time_base;
            if (in_fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO)
                out_vstream = out_s;
            else if (in_fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO)
                out_astream = out_s;
        }

        if (avio_open2(&out_fmt->pb, url.c_str(), AVIO_FLAG_WRITE, nullptr, nullptr) < 0) {
            std::cerr << "sdi_receive: SRT connect to " << dest_uri << " failed\n";
            avformat_free_context(out_fmt);
            out_fmt = nullptr;
            return false;
        }

        if (avformat_write_header(out_fmt, nullptr) < 0) {
            std::cerr << "sdi_receive: write_header failed\n";
            avio_closep(&out_fmt->pb);
            avformat_free_context(out_fmt);
            out_fmt = nullptr;
            return false;
        }

        output_ready.store(true);
        std::cerr << "sdi_receive: output connected → " << dest_uri << "\n";
        return true;
    };

    auto relay_packet = [&](AVPacket* pkt) {
        if (!out_fmt) return;
        // Preserve stream index mapping (input and output stream indices match
        // since we copy streams in order).
        av_interleaved_write_frame(out_fmt, pkt);
    };

    // ------------------------------------------------------------------
    // Single-path relay
    // ------------------------------------------------------------------
    if (!dual_path) {
        sdi::SrtInput::Config src_cfg{args.src, args.latency_ms, args.passphrase};

        // We need the input's stream layout (codecpar, time_base) to build a
        // matching output muxer. The reader thread and this callback are the
        // same thread, so format_context() is safe to read here — see its
        // doc comment in srt_input.h. live_src1 is assigned right after
        // construction, below; packets can't arrive before start() is called.
        sdi::SrtInput src(src_cfg, [&](AVPacket* pkt, int /*si*/) {
            if (!output_ready.load()) {
                if (auto* p = live_src1.load()) {
                    if (const AVFormatContext* in_fmt = p->format_context())
                        init_output(in_fmt);
                }
            }
            relay_packet(pkt);
        });
        live_src1.store(&src);

        std::cerr << "sdi_receive: single-path relay " << args.src
                  << " → " << dest_uri << "\n";
        src.start();

        while (!g_stop) std::this_thread::sleep_for(std::chrono::milliseconds(200));

        src.stop();
    }

    // ------------------------------------------------------------------
    // Dual-path 2022-7 merge
    // ------------------------------------------------------------------
    else {
        std::cerr << "sdi_receive: 2022-7 dual-path merge\n"
                  << "  path1: " << args.src  << "\n"
                  << "  path2: " << args.src2 << "\n"
                  << "  dest:  " << dest_uri  << "\n"
                  << "  window: " << args.window_ms << "ms\n";

        // The RedundancyReceiver needs to know stream indices. We learn them
        // on first packet arrival from SrtInput.
        // Until output is ready, packets are buffered by the receiver's window.

        sdi::RedundancyReceiver receiver(
            std::chrono::milliseconds{args.window_ms},
            /* video_stream_index */ 0,   // MPEG-TS: video is typically stream 0
            /* audio_stream_index */ 1,
            /* emit_video */ relay_packet,
            /* emit_audio */ relay_packet);

        sdi::SrtInput::Config cfg1{args.src,  args.latency_ms, args.passphrase};
        sdi::SrtInput::Config cfg2{args.src2, args.latency_ms, args.passphrase};

        // Whichever path delivers a packet first initialises the output —
        // 2022-7 is meant to keep the stream alive even if one path never
        // comes up at all, so we don't wait for both. See the single-path
        // branch above for why reading format_context() here is safe.
        auto maybe_init_from = [&](sdi::SrtInput* ptr) {
            if (output_ready.load() || !ptr) return;
            if (const AVFormatContext* in_fmt = ptr->format_context())
                init_output(in_fmt);
        };

        sdi::SrtInput src1(cfg1, [&](AVPacket* pkt, int /*si*/) {
            maybe_init_from(live_src1.load());
            receiver.push(0, pkt);
        });
        sdi::SrtInput src2(cfg2, [&](AVPacket* pkt, int /*si*/) {
            maybe_init_from(live_src2.load());
            receiver.push(1, pkt);
        });
        live_src1.store(&src1);
        live_src2.store(&src2);

        src1.start();
        src2.start();

        // Stats heartbeat.
        while (!g_stop) {
            std::this_thread::sleep_for(std::chrono::seconds(5));
            std::cerr << "[sdi_receive] path1=" << (src1.is_running() ? "up" : "down")
                      << " path2=" << (src2.is_running() ? "up" : "down") << "\n";
        }

        src1.stop();
        src2.stop();
    }

    // Flush and close output.
    if (out_fmt) {
        av_write_trailer(out_fmt);
        avio_closep(&out_fmt->pb);
        avformat_free_context(out_fmt);
    }

    std::cerr << "sdi_receive: shutdown complete\n";
    return 0;
}
