// link_encoder — Arena Link encoder: SDI capture -> NVENC -> MPEG-TS -> SRT.
//
// One mux, sent to
//   * a direct SRT listener (LAN decoders connect straight to this machine), and
//   * the relay as a publisher (internet decoders read it from the server).
// and announced once a second to the directory so any decoder finds it.
//
// Control: stdin line "bitrate <kbps>" or "quit". Status: one JSON line per second on stdout.
#include "capture_device.h"
#include "crash_report.h"
#include "codec_policy.h"
#include "device_list.h"
#include "encoder.h"
#include "frame_queue.h"
#include "http_post.h"
#include "preview_jpeg.h"
#include "quality_test.h"
#include "mdns.h"
#include "rate_adapter.h"
#include "relay_latency.h"
#include "ts_fanout.h"
#include "ts_muxer.h"

#include <atomic>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>

namespace {

std::atomic<bool> g_stop{false};
std::atomic<bool> g_idle{false};   // "idle" on stdin: stop sending, keep the input open and keep the monitor pictures coming
std::atomic<int>  g_bitrate_req{0};
std::atomic<int>  g_user_kbps{0};   // bitrate the user asked for (the adapter's new target)
std::atomic<int>  g_dir_state{0};   // 0 = not announcing, 1 = last announce accepted, 2 = failing
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
    int         relay_latency_ms = 100;       // 0 = size it from the measured RTT to the server (see relay_latency.h)
    bool        mdns = true;                  // advertise on the local network (_arenalink._udp)
    std::string directory;                    // "http://host:port"; empty = no announce
    std::string key;
    bool        preview = false;              // emit {"type":"preview"} JPEG lines for the app's monitor
    bool        monitor = false;              // capture + preview only: no encode, no network
    bool        deinterlace = false;          // old behaviour: interlaced sources sent as field-rate progressive
    bool        adapt = true;                 // lower the bitrate when the network drops packets
    std::string quality = "low";              // low | balanced | max — see encoder.h QualityProfile
    bool        qtest = false;                // measure quality/latency of each profile on a live clip, then exit
    std::string qtest_rates;                  // comma-separated kbps list (default: --bitrate)
    int         qtest_secs = 2;               // length of the test clip
};

void usage() {
    std::fprintf(stderr,
        "link_encoder --list   (cards as JSON)\n"
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
        else if (k == "--preview")          a.preview = true;
        else if (k == "--monitor")          a.monitor = true;
        else if (k == "--quality")          a.quality = next();
        else if (k == "--no-adapt")         a.adapt = false;
        else if (k == "--deinterlace")      a.deinterlace = true;
        else if (k == "--no-mdns")          a.mdns = false;
        else if (k == "--qtest")            a.qtest = true;
        else if (k == "--qtest-rates")      a.qtest_rates = next();
        else if (k == "--qtest-secs")       a.qtest_secs = std::max(1, std::min(6, std::atoi(next())));
        else if (k == "-h" || k == "--help") { usage(); return false; }
        else { std::fprintf(stderr, "unknown argument: %s\n", k.c_str()); usage(); return false; }
    }
    // Secrets can come from the environment so they stay out of process listings.
    if (a.key.empty())          if (const char* e = std::getenv("LINK_KEY"))          a.key = e;
    if (a.relay_secret.empty()) if (const char* e = std::getenv("LINK_RELAY_SECRET")) a.relay_secret = e;
    if (a.quality != "low" && a.quality != "balanced" && a.quality != "max") a.quality = "low";
    if (a.name.empty() && a.qtest) a.name = "qtest";
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

// Monitor pictures for the app, at the source's full motion rate: every frame, and for interlaced
// sources every FIELD (59.94 a second for 1080i59.94), the second field half a frame after the
// first. Runs on its own thread so the encoder is never delayed by the pacing.
class PreviewPump {
public:
    PreviewPump() : th_([this] { run(); }) {}
    ~PreviewPump() { { std::lock_guard lk(m_); stop_ = true; } cv_.notify_all(); }
    void offer(const sdi::VideoFrame& f) {
        auto c = std::make_shared<sdi::VideoFrame>(f);
        { std::lock_guard lk(m_); latest_ = std::move(c); }
        cv_.notify_one();
    }
private:
    void emit(sdi::PreviewJpeg& pj, const sdi::VideoFrame& f, int field) {
        const std::string jpg = pj.make(f, 960, field);
        if (jpg.empty()) return;
        std::printf("{\"type\":\"preview\",\"w\":%d,\"h\":%d,\"jpg\":\"%s\"}\n", pj.width(), pj.height(), jpg.c_str());
        std::fflush(stdout);
    }
    void run() {
        sdi::PreviewJpeg pj;
        for (;;) {
            std::shared_ptr<sdi::VideoFrame> f;
            {
                std::unique_lock lk(m_);
                cv_.wait(lk, [&] { return stop_ || latest_; });
                if (stop_) return;
                f = std::move(latest_);
            }
            if (!f->mode.interlaced) { emit(pj, *f, -1); continue; }
            const auto t0 = std::chrono::steady_clock::now();
            const bool tff = f->mode.height >= 720;   // HD is top field first, SD bottom first
            emit(pj, *f, tff ? 0 : 1);
            std::this_thread::sleep_until(t0 + f->mode.frame_duration() / 2);
            { std::lock_guard lk(m_); if (stop_) return; }
            emit(pj, *f, tff ? 1 : 0);
        }
    }
    std::mutex m_;
    std::condition_variable cv_;
    std::shared_ptr<sdi::VideoFrame> latest_;
    bool stop_ = false;
    std::jthread th_;
};

// The relay only accepts letters, digits and _ - . in a stream name, so "Truck 1 - Camera 2" is
// published as "Truck-1-Camera-2". Decoders still show the real name; they read the relay name the
// encoder announces.
static std::string relay_safe_name(const std::string& n) {
    std::string o;
    for (unsigned char c : n) {
        const bool ok = std::isalnum(c) || c == '_' || c == '.' || c == '-';
        if (ok) o += char(c);
        else if (!o.empty() && o.back() != '-') o += '-';
    }
    while (!o.empty() && o.back() == '-') o.pop_back();
    return o.empty() ? "stream" : o;
}

int main(int argc, char** argv) {
    sdi::crash::install("link_encoder");
    for (int i = 1; i < argc; ++i)
        if (std::string(argv[i]) == "--list") { sdi::devlist::list_devices(); return 0; }
    sdi::latency::start_clock_sync();   // stamp frames with real time even if this PC's clock is off
    Args args;
    if (!parse(argc, argv, args)) return 2;
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    // ---- Capture ----
    auto capture = sdi::make_capture(args.backend);
    if (!capture) { std::cerr << "error: backend '" << args.backend << "' not compiled in\n"; return 1; }

    // 3 frames of slack absorb a brief encoder stall. Every queued frame is a frame of delay, and a
    // full queue drops the oldest, so a deeper queue only ever hides latency (8 frames = 133 ms at 60 fps).
    sdi::FrameQueue<sdi::VideoFrame> vq{3};
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

    // ---- Monitor only: show the input in the app before going live. ----
    // Captures and sends small preview pictures; nothing is encoded, sent or announced.
    // The app stops this process (releasing the card) before it starts the real encoder.
    if (args.monitor) {
        std::thread([&] {
            std::string line;
            while (std::getline(std::cin, line)) if (line == "quit") break;
            g_stop = true;
        }).detach();
        std::jthread pw([&] {
            PreviewPump pump;
            auto last_levels = std::chrono::steady_clock::now();
            while (auto f = vq.pop()) {
                const auto now = std::chrono::steady_clock::now();
                // LINK_DIAG_LEVELS=1: print the captured luma range once a second (8-bit UYVY only),
                // to check that SDI levels (black 16, white 235) arrive unchanged.
                if (std::getenv("LINK_DIAG_LEVELS") && f->mode.format == sdi::PixelFormat::UYVY422_8 &&
                    now - last_levels >= std::chrono::seconds(1)) {
                    last_levels = now;
                    unsigned hist[256] = {};
                    size_t n = 0;
                    for (uint32_t y = 0; y < f->mode.height; ++y) {
                        const uint8_t* row = f->data.data() + y * f->stride;
                        for (uint32_t x = 1; x < f->mode.width * 2; x += 2) { ++hist[row[x]]; ++n; }
                    }
                    auto pct = [&](double p) { size_t acc = 0, want = size_t(double(n) * p); for (int v = 0; v < 256; ++v) { acc += hist[v]; if (acc >= want) return v; } return 255; };
                    int lo = 0, hi = 255; while (lo < 255 && !hist[lo]) ++lo; while (hi > 0 && !hist[hi]) --hi;
                    std::fprintf(stderr, "levels: capture Y min=%d p0.1=%d p99.9=%d max=%d\n", lo, pct(0.001), pct(0.999), hi);
                }
                pump.offer(*f);
            }
        });
        std::jthread aw([&] { while (aq.pop()) {} });   // keep the audio queue from backing up
        while (!g_stop) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        capture->stop();
        vq.close();
        aq.close();
        return 0;
    }

    // ---- Quality test: encode a live clip with every profile x bitrate, report the scores. ----
    if (args.qtest) {
        std::thread([&] {
            std::string line;
            while (std::getline(std::cin, line)) if (line == "quit") break;
            g_stop = true;
        }).detach();
        std::jthread aw([&] { while (aq.pop()) {} });
        const double fps = double(mode.fps_num) / double(std::max<uint32_t>(1, mode.fps_den));
        const size_t want = size_t(fps * args.qtest_secs + 0.5);
        std::vector<sdi::VideoFrame> clip;
        const auto t_end = std::chrono::steady_clock::now() + std::chrono::seconds(args.qtest_secs + 8);
        while (clip.size() < want && !g_stop && std::chrono::steady_clock::now() < t_end) {
            auto f = vq.pop();
            if (!f) break;
            clip.push_back(std::move(*f));
        }
        capture->stop();
        vq.close();
        aq.close();
        if (clip.size() < 10) { std::fprintf(stderr, "error: only %zu frames captured\n", clip.size()); return 1; }
        std::vector<int> rates;
        { std::stringstream ss(args.qtest_rates); std::string t; while (std::getline(ss, t, ',')) if (const int v = std::atoi(t.c_str()); v >= 500) rates.push_back(v); }
        if (rates.empty()) rates.push_back(args.bitrate_kbps);
        const auto chain = sdi::codec_policy::candidate_chain(args.codec, sdi::codec_policy::dest_kind("srt://x"));
        const char* profiles[] = {"low", "balanced", "max"};
        const int total = int(rates.size()) * 3;
        int done = 0;
        std::printf("{\"type\":\"qtest-start\",\"w\":%u,\"h\":%u,\"fps\":%s,\"interlaced\":%s,\"clip_frames\":%zu,\"runs\":%d}\n",
                    mode.width, mode.height, fmt_fps(fps).c_str(), mode.interlaced ? "true" : "false", clip.size(), total);
        std::fflush(stdout);
        for (int kbps : rates) for (const char* q : profiles) {
            if (g_stop) break;
            sdi::qtest::Result r;
            if (sdi::qtest::run_one(clip, mode, chain, q, kbps, r)) sdi::qtest::print_json(r);
            else { std::printf("{\"type\":\"qtest-fail\",\"quality\":\"%s\",\"target_kbps\":%d}\n", q, kbps); std::fflush(stdout); }
            std::printf("{\"type\":\"qtest-progress\",\"done\":%d,\"of\":%d}\n", ++done, total);
            std::fflush(stdout);
        }
        std::printf("{\"type\":\"qtest-done\"}\n");
        std::fflush(stdout);
        return 0;
    }

    // ---- Encode ----
    sdi::EncoderConfig enc_cfg;
    enc_cfg.quality      = args.quality;
    enc_cfg.codec_name   = args.codec;
    enc_cfg.bitrate_kbps = args.bitrate_kbps;
    enc_cfg.deinterlace  = args.deinterlace;
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
    int relay_latency = args.relay_latency_ms;
    bool relay_auto = false;
    double relay_probe_ms = -1;
    if (!args.relay.empty()) {
        const auto c = args.relay.rfind(':');
        fc.relay_host = args.relay.substr(0, c);
        if (c != std::string::npos) relay_port = std::atoi(args.relay.c_str() + c + 1);
        fc.relay_port       = relay_port;
        fc.relay_name       = relay_safe_name(args.name);
        fc.relay_secret     = args.relay_secret;
        // This leg (encoder -> relay) is sized from this PC's own RTT to the server.
        relay_latency = args.relay_latency_ms;
        if (relay_latency <= 0) {
            relay_auto = true;
            sdi::net::Url pu;
            if (!args.directory.empty() && sdi::net::parse_url(args.directory, pu))
                relay_probe_ms = sdi::net::tcp_rtt_ms(pu.host, pu.port);
            relay_latency = sdi::link::auto_relay_latency_ms(relay_probe_ms);
            std::cerr << "relay: encoder->relay leg " << relay_latency << " ms (auto, "
                      << (relay_probe_ms > 0 ? std::to_string(int(relay_probe_ms)) + " ms RTT to the server" : std::string("RTT not measurable, default")) << ")\n";
        }
        fc.relay_latency_ms = relay_latency;
    }
    // SRT pacing: video + audio + TS/SRT overhead, times headroom for bursts and retransmits.
    // A wider rate-control buffer (balanced/max) lets one frame be several times the average, so
    // those profiles get more headroom; a tighter cap would just move the burst into the SRT delay.
    const double pace_headroom = enc.quality() == "max" ? 2.5 : enc.quality() == "balanced" ? 2.0 : 1.25;
    auto pace_for = [&](int video_kbps) {
        return int64_t((video_kbps + (audio_on ? args.audio_kbps : 0)) * 1000.0 / 8.0 * 1.12 * pace_headroom);
    };
    fc.pace_bytes_per_sec = pace_for(enc.current_bitrate_kbps());
    auto fanout = std::make_unique<sdi::TsFanout>(fc);
    auto mux    = std::make_unique<sdi::TsMuxer>(*fanout, enc.video_ctx(), aenc ? aenc->audio_ctx() : nullptr);
    std::mutex enc_mu;   // held while encoding and while the sending side is torn down for "idle"

    // ---- Workers: queue -> encode -> mux. Fanout never blocks, so no extra network queue. ----
    std::unique_ptr<PreviewPump> pump;
    if (args.preview) pump = std::make_unique<PreviewPump>();
    std::jthread vworker([&] {
        while (auto f = vq.pop()) {
            {
                std::lock_guard lk(enc_mu);
                if (!g_idle) {
                    if (const int want = g_bitrate_req.exchange(0)) { enc.set_bitrate(want); fanout->set_pacing(pace_for(want)); }
                    enc.encode(*f, [&](AVPacket* pkt) { mux->write_video(pkt); });
                }
            }
            // Monitor pictures for the app (every frame / every field), after the real encode.
            if (pump) pump->offer(*f);
        }
    });
    std::jthread aworker([&] {
        while (auto f = aq.pop()) {
            std::lock_guard lk(enc_mu);
            if (aenc && !g_idle) aenc->encode(*f, [&](AVPacket* pkt) { mux->write_audio(pkt); });
        }
    });

    // ---- Control: "bitrate N" / "quit" on stdin; EOF (parent died) also stops us. ----
    std::thread([&] {
        std::string line;
        while (std::getline(std::cin, line)) {
            std::istringstream ss(line);
            std::string cmd; int v = 0;
            ss >> cmd >> v;
            if (cmd == "bitrate" && v >= 500 && v <= 100000) { g_bitrate_req = v; g_user_kbps = v; }
            else if (cmd == "idle") g_idle = true;
            else if (cmd == "quit") break;
        }
        g_stop = true;
    }).detach();

    // ---- Announce ----
    // Format as delivered to decoders: interlaced sources are sent interlaced (field rate named), or progressive with --deinterlace.
    const double src_fps = double(mode.fps_num) / double(mode.fps_den);
    const double out_fps = mode.interlaced ? src_fps * 2.0 : src_fps;
    const bool native_il = mode.interlaced && !args.deinterlace;
    const std::string format = std::to_string(mode.width) + "x" + std::to_string(mode.height) + (native_il ? "i@" : "p@") + fmt_fps(out_fps);
    const std::string source = std::to_string(mode.width) + "x" + std::to_string(mode.height) +
                               (mode.interlaced ? "i@" : "p@") + fmt_fps(mode.interlaced ? out_fps : src_fps);
    const std::string id = host_name() + "-" + args.device_id + "-" + args.connection;
    const std::string lan_ip = sdi::net::primary_lan_ip();
    sdi::net::Url dir_url;
    const bool announce = !args.directory.empty() && sdi::net::parse_url(args.directory, dir_url);
    if (!args.directory.empty() && !announce) std::cerr << "warning: bad --directory, not announcing\n";

    std::cerr << "link_encoder: " << args.name << " | source " << source << " | sending " << format << " | "
              << enc.name() << " " << enc.current_bitrate_kbps() << " kbps (" << enc.quality() << " quality)"
              << " | direct " << (args.direct_port ? "udp/" + std::to_string(args.direct_port) : "off")
              << " | relay " << (args.relay.empty() ? "off" : args.relay) << "\n";

    // LAN discovery with no directory: decoders on this network find us by mDNS (_arenalink._udp).
    std::unique_ptr<sdi::mdns::Responder> mdns;
    if (args.mdns && args.direct_port > 0) {
        mdns = std::make_unique<sdi::mdns::Responder>(host_name(), [&] {
            sdi::mdns::Service m;
            m.id = id; m.name = args.name; m.format = format; m.source = source; m.codec = enc.name();
            m.kbps = enc.current_bitrate_kbps(); m.port = args.direct_port;
            if (!args.relay.empty()) { m.relay_host = fc.relay_host; m.relay_port = relay_port; m.relay_name = relay_safe_name(args.name); }
            return m;
        });
        if (mdns->start()) std::cerr << "mdns: advertising " << args.name << " on the local network\n";
    }

    std::jthread announcer;
    if (announce) announcer = std::jthread([&] {
        int fails = 0;
        while (!g_stop && !g_idle) {
            std::ostringstream b;
            b << "{\"id\":" << json_str(id) << ",\"name\":" << json_str(args.name)
              << ",\"format\":" << json_str(format) << ",\"source\":" << json_str(source)
              << ",\"codec\":" << json_str(enc.name()) << ",\"kbps\":" << enc.current_bitrate_kbps()
              << ",\"lanIps\":[" << (lan_ip.empty() ? "" : json_str(lan_ip)) << "]"
              << ",\"directPort\":" << args.direct_port
              << ",\"relay\":" << (args.relay.empty() ? "null" :
                    "{\"host\":" + json_str(fc.relay_host) + ",\"port\":" + std::to_string(relay_port) + ",\"name\":" + json_str(relay_safe_name(args.name)) + "}")
              << ",\"version\":\"link-1\"}";
            const int st = sdi::net::http_request(dir_url, "POST", "/v1/announce", args.key, b.str());
            g_dir_state = st == 200 ? 1 : 2;
            if (st != 200 && fails++ % 10 == 0)
                std::cerr << "directory: announce failed (" << (st < 0 ? "unreachable" : "HTTP " + std::to_string(st)) << ")\n";
            if (st == 200) fails = 0;
            for (int i = 0; i < 10 && !g_stop && !g_idle; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    });

    // ---- Status ----
    uint64_t last_v = 0, last_bytes = 0;
    auto last = std::chrono::steady_clock::now();
    sdi::RateAdapter adapter(enc.current_bitrate_kbps(), args.adapt && enc.supports_live_bitrate());
    std::string last_warn;
    while (!g_stop && !g_idle) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        const auto now = std::chrono::steady_clock::now();
        const double dt = std::chrono::duration<double>(now - last).count();
        last = now;
        const uint64_t v = video_count.load(), by = fanout->bytes();

        // Network feedback: SRT's own counters decide whether the link can carry the bitrate.
        if (const int u = g_user_kbps.exchange(0)) adapter.set_target(u);
        const auto rh = fanout->relay_health(), vh = fanout->viewer_health();
        if (const int nb = adapter.tick(rh.sent + vh.sent, rh.retrans + vh.retrans, rh.drops + vh.drops)) {
            g_bitrate_req = nb;   // the video worker applies it (and the pacing) on its next frame
            std::cerr << "adapt: " << (adapter.loss_pct() > 2.0 || adapter.drops_recent() ? "network is dropping packets" : "network recovering")
                      << " (" << adapter.loss_pct() << "% re-sent) - bitrate now " << nb << " kbps (requested "
                      << adapter.target() << ")\n";
        }
        std::string warn;
        // A lost packet needs a full round trip to be re-sent, so while packets are being lost the
        // leg needs ~2 RTT + jitter; the auto size (1.25 RTT) is for a mostly clean path.
        if (rh.conns && rh.rtt_ms > 0 && adapter.loss_avg() > 0.5 && relay_latency < 2 * rh.rtt_ms + 40)
            warn = "Internet buffer " + std::to_string(relay_latency) + " ms is short for a " +
                   std::to_string(int(rh.rtt_ms)) + " ms round trip while packets are being lost. Raise it to " +
                   std::to_string(int(std::ceil((2 * rh.rtt_ms + 40) / 20.0)) * 20) + " ms (adds that much delay).";
        else if (adapter.drops_recent())
            warn = "The network could not deliver packets in time and some were dropped. Raise the buffer or lower the bitrate.";
        else if (adapter.reduced())
            warn = std::string(adapter.loss_avg() > 0.5 ? "Network is dropping packets: bitrate lowered to "
                                                        : "Recovering after packet loss: bitrate back up to ") + std::to_string(adapter.current() / 1000) + "." +
                   std::to_string(adapter.current() / 100 % 10) + " Mbps (requested " +
                   std::to_string(adapter.target() / 1000) + "." + std::to_string(adapter.target() / 100 % 10) + ").";
        else if (!adapter.enabled() && args.adapt && !enc.supports_live_bitrate() && adapter.loss_avg() > 2.0)
            warn = "Packets are being lost and this encoder cannot change bitrate live. Lower the bitrate.";
        if (warn != last_warn) { if (!warn.empty()) std::cerr << "warning: " << warn << "\n"; last_warn = warn; }
        std::printf("{\"type\":\"link_stats\",\"name\":%s,\"format\":%s,\"source\":%s,\"fps\":%.1f,\"kbps\":%.0f,"
                    "\"viewers\":%d,\"relayUp\":%s,\"relayRttMs\":%.1f,\"capDrops\":%llu,\"directory\":\"%s\","
                    "\"lossPct\":%.1f,\"targetKbps\":%d,\"adapt\":%s,\"warn\":%s,"
                    "\"relayLatencyMs\":%d,\"relayAuto\":%s,\"relayProbeMs\":%.0f}\n",
                    json_str(args.name).c_str(), json_str(format).c_str(), json_str(source).c_str(),
                    double(v - last_v) / dt * (mode.interlaced ? 2.0 : 1.0), double(by - last_bytes) * 8.0 / dt / 1000.0,
                    fanout->clients(), fanout->relay_up() ? "true" : "false", fanout->relay_rtt_ms(),
                    (unsigned long long)vq.dropped(),
                    g_dir_state == 1 ? "ok" : g_dir_state == 2 ? "failed" : "off",
                    adapter.loss_avg(), adapter.current(), adapter.enabled() ? "true" : "false", json_str(warn).c_str(),
                    args.relay.empty() ? 0 : relay_latency, relay_auto ? "true" : "false", relay_probe_ms);
        std::fflush(stdout);
        last_v = v; last_bytes = by;
    }

    // ---- Idle: the app pressed STOP. Stop sending (relay, LAN viewers, directory, mDNS) but keep the
    // input open: the video worker carries on as a monitor, so the picture never drops out. ----
    if (g_idle && !g_stop) {
        if (announcer.joinable()) announcer.join();
        mdns.reset();
        {
            std::lock_guard lk(enc_mu);   // no frame is mid-encode while the sending side goes away
            mux.reset();
            fanout.reset();
        }
        std::cerr << "link_encoder: idle (input kept open for the monitor)\n";
        while (!g_stop) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // ---- Shutdown: stop the source first, then drain the workers. ----
    capture->stop();
    vq.close();
    aq.close();
    vworker.join();
    aworker.join();
    return 0;
}
