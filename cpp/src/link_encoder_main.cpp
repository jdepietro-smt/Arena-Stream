// link_encoder — Arena Link encoder: SDI capture -> NVENC -> MPEG-TS -> SRT.
//
// One mux, sent to
//   * a direct SRT listener (LAN decoders connect straight to this machine), and
//   * the relay as a publisher (internet decoders read it from the server).
// and announced once a second to the directory so any decoder finds it.
//
// Control: stdin line "bitrate <kbps>" or "quit". Status: one JSON line per second on stdout.
#include "capture_device.h"
#include "codec_policy.h"
#include "encoder.h"
#include "frame_queue.h"
#include "http_post.h"
#include "ts_fanout.h"
#include "ts_muxer.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>

namespace {

std::atomic<bool> g_stop{false};
std::atomic<int>  g_bitrate_req{0};
void on_signal(int) { g_stop = true; }

struct Args {
    std::string backend     = "aja";
    std::string device_id   = "0";
    std::string connection  = "sdi";
    std::string reference   = "freerun";
    std::string name;                         // shown to decoders; required
    std::string codec       = "gpu";
    std::string audio_codec = "libopus";
    int         bitrate_kbps  = 10000;
    int         audio_kbps    = 128;
    int         audio_channels = 2;
    int         direct_port   = 4200;         // 0 disables the LAN listener
    int         direct_latency_ms = 40;
    std::string relay;                        // "IPv4[:port]" (default port 8895); empty = LAN only
    std::string relay_secret;
    int         relay_latency_ms = 100;
    std::string directory;                    // "http://host:port"; empty = no announce
    std::string key;
};

void usage() {
    std::fprintf(stderr,
        "link_encoder --name NAME [--backend aja|decklink] [--device N] [--conn sdi|N] [--reference freerun|inputN]\n"
        "             [--codec gpu|cpu|ENC] [--bitrate KBPS] [--acodec libopus|none] [--abitrate KBPS] [--achannels N]\n"
        "             [--direct-port P] [--direct-latency MS]\n"
        "             [--relay IPV4[:PORT] --relay-secret S [--relay-latency MS]]\n"
        "             [--directory http://HOST:PORT --key KEY]\n");
}

bool parse(int argc, char** argv, Args& a) {
    for (int i = 1; i < argc; ++i) {
        const std::string k = argv[i];
        auto next = [&]() -> const char* {
            if (i + 1 >= argc) { std::fprintf(stderr, "missing value for %s\n", k.c_str()); std::exit(2); }
            return argv[++i];
        };
        if      (k == "--name")             a.name = next();
        else if (k == "--backend")          a.backend = next();
        else if (k == "--device")           a.device_id = next();
        else if (k == "--conn")             a.connection = next();
        else if (k == "--reference")        a.reference = next();
        else if (k == "--codec")            a.codec = next();
        else if (k == "--bitrate")          a.bitrate_kbps = std::atoi(next());
        else if (k == "--acodec")           a.audio_codec = next();
        else if (k == "--abitrate")         a.audio_kbps = std::atoi(next());
        else if (k == "--achannels")        a.audio_channels = std::atoi(next());
        else if (k == "--direct-port")      a.direct_port = std::atoi(next());
        else if (k == "--direct-latency")   a.direct_latency_ms = std::atoi(next());
        else if (k == "--relay")            a.relay = next();
        else if (k == "--relay-secret")     a.relay_secret = next();
        else if (k == "--relay-latency")    a.relay_latency_ms = std::atoi(next());
        else if (k == "--directory")        a.directory = next();
        else if (k == "--key")              a.key = next();
        else if (k == "-h" || k == "--help") { usage(); return false; }
        else { std::fprintf(stderr, "unknown argument: %s\n", k.c_str()); usage(); return false; }
    }
    if (a.name.empty()) { std::fprintf(stderr, "--name is required\n"); usage(); return false; }
    return true;
}

std::string json_str(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += char(c); }
        else if (c < 0x20)         { o += ' '; }
        else                       { o += char(c); }
    }
    return o + "\"";
}

std::string fmt_fps(double fps) {
    char b[16];
    if (std::abs(fps - std::round(fps)) < 0.02) std::snprintf(b, sizeof(b), "%.0f", std::round(fps));
    else                                        std::snprintf(b, sizeof(b), "%.2f", fps);
    return b;
}

std::string host_name() {
    sdi::net::net_init();
    char b[256] = {};
    if (gethostname(b, sizeof(b) - 1) != 0) return "encoder";
    return b;
}

} // namespace

int main(int argc, char** argv) {
    Args args;
    if (!parse(argc, argv, args)) return 2;
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    // ---- Capture ----
    auto capture = sdi::make_capture(args.backend);
    if (!capture) { std::cerr << "error: backend '" << args.backend << "' not compiled in\n"; return 1; }

    // 8 video frames of slack absorb brief encoder stalls; more would only add delay.
    sdi::FrameQueue<sdi::VideoFrame> vq{8};
    sdi::FrameQueue<sdi::AudioFrame> aq{64};

    sdi::CaptureConfig cfg{
        .device_id      = args.device_id,
        .connection     = args.connection,
        .requested_mode = {},
        .auto_detect    = true,
        .audio_channels = uint32_t(args.audio_channels),
        .reference      = args.reference,
    };
    std::atomic<uint64_t> video_count{0};
    const bool cap_ok = capture->start(
        cfg,
        [&](sdi::VideoFrame&& f) { ++video_count; vq.push(std::move(f)); },
        [&](sdi::AudioFrame&& f) { aq.push(std::move(f)); });
    if (!cap_ok) { std::cerr << "error: capture start failed\n"; return 1; }
    const sdi::VideoMode mode = capture->current_mode();

    // ---- Encode ----
    sdi::EncoderConfig enc_cfg;
    enc_cfg.codec_name   = args.codec;
    enc_cfg.bitrate_kbps = args.bitrate_kbps;
    enc_cfg.chain        = sdi::codec_policy::candidate_chain(args.codec, sdi::codec_policy::dest_kind("srt://x"));
    sdi::Encoder enc(mode, enc_cfg);
    enc.prewarm();

    const bool audio_on = args.audio_codec != "none";
    std::unique_ptr<sdi::AudioEncoder> aenc;
    if (audio_on)
        aenc = std::make_unique<sdi::AudioEncoder>(args.audio_channels, 48000,
                                                   sdi::AudioEncoderConfig{args.audio_codec, args.audio_kbps});

    // ---- Transport ----
    sdi::FanoutConfig fc;
    fc.listen_port       = args.direct_port;
    fc.listen_latency_ms = args.direct_latency_ms;
    int relay_port = 8895;
    if (!args.relay.empty()) {
        const auto c = args.relay.rfind(':');
        fc.relay_host = args.relay.substr(0, c);
        if (c != std::string::npos) relay_port = std::atoi(args.relay.c_str() + c + 1);
        fc.relay_port       = relay_port;
        fc.relay_name       = args.name;
        fc.relay_secret     = args.relay_secret;
        fc.relay_latency_ms = args.relay_latency_ms;
    }
    sdi::TsFanout fanout(fc);
    sdi::TsMuxer  mux(fanout, enc.video_ctx(), aenc ? aenc->audio_ctx() : nullptr);

    // ---- Workers: queue -> encode -> mux. Fanout never blocks, so no extra network queue. ----
    std::jthread vworker([&] {
        while (auto f = vq.pop()) {
            if (const int want = g_bitrate_req.exchange(0)) enc.set_bitrate(want);
            enc.encode(*f, [&](AVPacket* pkt) { mux.write_video(pkt); });
        }
    });
    std::jthread aworker([&] {
        while (auto f = aq.pop())
            if (aenc) aenc->encode(*f, [&](AVPacket* pkt) { mux.write_audio(pkt); });
    });

    // ---- Control: "bitrate N" / "quit" on stdin; EOF (parent died) also stops us. ----
    std::thread([&] {
        std::string line;
        while (std::getline(std::cin, line)) {
            std::istringstream ss(line);
            std::string cmd; int v = 0;
            ss >> cmd >> v;
            if (cmd == "bitrate" && v >= 500 && v <= 100000) g_bitrate_req = v;
            else if (cmd == "quit") break;
        }
        g_stop = true;
    }).detach();

    // ---- Announce ----
    // Format as delivered to decoders: interlaced sources are sent progressive at field rate.
    const double src_fps = double(mode.fps_num) / double(mode.fps_den);
    const double out_fps = mode.interlaced ? src_fps * 2.0 : src_fps;
    const std::string format = std::to_string(mode.width) + "x" + std::to_string(mode.height) + "p@" + fmt_fps(out_fps);
    const std::string source = std::to_string(mode.width) + "x" + std::to_string(mode.height) +
                               (mode.interlaced ? "i@" : "p@") + fmt_fps(mode.interlaced ? out_fps : src_fps);
    const std::string id = host_name() + "-" + args.device_id + "-" + args.connection;
    const std::string lan_ip = sdi::net::primary_lan_ip();
    sdi::net::Url dir_url;
    const bool announce = !args.directory.empty() && sdi::net::parse_url(args.directory, dir_url);
    if (!args.directory.empty() && !announce) std::cerr << "warning: bad --directory, not announcing\n";

    std::cerr << "link_encoder: " << args.name << " | source " << source << " | sending " << format << " | "
              << enc.name() << " " << enc.current_bitrate_kbps() << " kbps"
              << " | direct " << (args.direct_port ? "udp/" + std::to_string(args.direct_port) : "off")
              << " | relay " << (args.relay.empty() ? "off" : args.relay) << "\n";

    std::jthread announcer;
    if (announce) announcer = std::jthread([&] {
        int fails = 0;
        while (!g_stop) {
            std::ostringstream b;
            b << "{\"id\":" << json_str(id) << ",\"name\":" << json_str(args.name)
              << ",\"format\":" << json_str(format) << ",\"source\":" << json_str(source)
              << ",\"codec\":" << json_str(enc.name()) << ",\"kbps\":" << enc.current_bitrate_kbps()
              << ",\"lanIps\":[" << (lan_ip.empty() ? "" : json_str(lan_ip)) << "]"
              << ",\"directPort\":" << args.direct_port
              << ",\"relay\":" << (args.relay.empty() ? "null" :
                    "{\"port\":" + std::to_string(relay_port) + ",\"name\":" + json_str(args.name) + "}")
              << ",\"version\":\"link-1\"}";
            const int st = sdi::net::http_request(dir_url, "POST", "/v1/announce", args.key, b.str());
            if (st != 200 && fails++ % 10 == 0)
                std::cerr << "directory: announce failed (" << (st < 0 ? "unreachable" : "HTTP " + std::to_string(st)) << ")\n";
            if (st == 200) fails = 0;
            for (int i = 0; i < 10 && !g_stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    });

    // ---- Status ----
    uint64_t last_v = 0, last_bytes = 0;
    auto last = std::chrono::steady_clock::now();
    while (!g_stop) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        const auto now = std::chrono::steady_clock::now();
        const double dt = std::chrono::duration<double>(now - last).count();
        last = now;
        const uint64_t v = video_count.load(), by = fanout.bytes();
        std::printf("{\"type\":\"link_stats\",\"name\":%s,\"format\":%s,\"source\":%s,\"fps\":%.1f,\"kbps\":%.0f,"
                    "\"viewers\":%d,\"relayUp\":%s,\"relayRttMs\":%.1f,\"capDrops\":%llu}\n",
                    json_str(args.name).c_str(), json_str(format).c_str(), json_str(source).c_str(),
                    double(v - last_v) / dt * (mode.interlaced ? 2.0 : 1.0), double(by - last_bytes) * 8.0 / dt / 1000.0,
                    fanout.clients(), fanout.relay_up() ? "true" : "false", fanout.relay_rtt_ms(),
                    (unsigned long long)vq.dropped());
        std::fflush(stdout);
        last_v = v; last_bytes = by;
    }

    // ---- Shutdown: stop the source first, then drain the workers. ----
    capture->stop();
    vq.close();
    aq.close();
    vworker.join();
    aworker.join();
    return 0;
}
