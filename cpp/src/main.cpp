// Harness — wires a CaptureDevice into the encode + SRT output chain.
//
// Usage:
//     sdi_stream --backend decklink --dest 10.0.0.5:4200
//     sdi_stream --backend aja      --dest 10.0.0.5:4200 --latency 120
//     sdi_stream --backend decklink --dest 10.0.0.5:4200 --codec hevc_nvenc

#include "capture_device.h"
#include "encoder.h"
#include "frame_queue.h"
#include "redundancy.h"
#include "srt_output.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <ctime>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswscale/swscale.h>
}

#ifdef _WIN32
#  include <windows.h>
#  include <fcntl.h>
#  include <io.h>
#endif

// ---------------------------------------------------------------------------
// PendingPacket — owned AVPacket queued for network write on a dedicated
// thread, decoupled from capture/encode. RTSP-over-TCP write calls are
// synchronous and can block on WAN latency; without this decoupling, a stall
// in the network write backs up directly into the capture queue and starts
// dropping CAPTURED FRAMES at the source (observed: ~50% video frame loss,
// roughly halving the achieved bitrate). Dropping a buffered, already-encoded
// packet here instead is far cheaper — it costs one frame's worth of
// transmission, not a frame that can never be re-captured.
// ---------------------------------------------------------------------------
struct PendingPacket {
    AVPacket* pkt      = nullptr;
    bool      is_audio = false;

    PendingPacket() = default;
    PendingPacket(AVPacket* p, bool audio) : pkt(p), is_audio(audio) {}
    PendingPacket(PendingPacket&& o) noexcept : pkt(o.pkt), is_audio(o.is_audio) { o.pkt = nullptr; }
    PendingPacket& operator=(PendingPacket&& o) noexcept {
        if (this != &o) { reset(); pkt = o.pkt; is_audio = o.is_audio; o.pkt = nullptr; }
        return *this;
    }
    PendingPacket(const PendingPacket&)            = delete;
    PendingPacket& operator=(const PendingPacket&) = delete;
    ~PendingPacket() { reset(); }
    void reset() { if (pkt) av_packet_free(&pkt); }
};

// ---------------------------------------------------------------------------
// PreviewEncoder — UYVY422 → YUV420P → stdout (raw, no JPEG compression).
//
// Frame wire format (8-byte header + planes):
//   [uint32 LE] width
//   [uint32 LE] height
//   [w*h  bytes] Y  plane
//   [w/2*h/2 B ] Cb plane
//   [w/2*h/2 B ] Cr plane
//
// The renderer uses WebGL to convert YUV→RGB on the GPU — zero compression,
// zero artifacts, indistinguishable from a hardware SDI monitor.
//
// Deinterlacing: AJA delivers 1080i (two fields, temporally offset).  A
// scrolling ticker advances between field 1 (even lines, time T) and field 2
// (odd lines, time T + 1 field).  Without deinterlacing the alternating rows
// show the ticker at two different positions — visible as misaligned pixels /
// "combing".  We apply a vertical linear-blend pass before sws_scale:
//
//     odd_line[y] = (even_line[y-1] + even_line[y+1]) / 2
//
// This fuses both field positions into every output line.  The memcpy + blend
// costs ~3 MB/frame at 1080i on modern CPUs (~0.3 ms); far below the 16 ms
// frame budget.
// ---------------------------------------------------------------------------
class PreviewEncoder {
public:
    PreviewEncoder(int src_w, int src_h,
                   int dst_w = 1280, int dst_h = 720)
        : src_h_(src_h), dst_w_(dst_w), dst_h_(dst_h) {
        sws_ = sws_getContext(src_w, src_h, AV_PIX_FMT_UYVY422,
                              dst_w, dst_h, AV_PIX_FMT_YUV420P,
                              SWS_BICUBIC, nullptr, nullptr, nullptr);

        const int y_sz  = dst_w * dst_h;
        const int uv_sz = (dst_w / 2) * (dst_h / 2);
        yuv_.resize(y_sz + uv_sz + uv_sz);
        planes_[0] = yuv_.data();
        planes_[1] = planes_[0] + y_sz;
        planes_[2] = planes_[1] + uv_sz;
        planes_[3] = nullptr;
        strides_[0] = dst_w;
        strides_[1] = dst_w / 2;
        strides_[2] = dst_w / 2;
        strides_[3] = 0;

        // Pre-allocate deinterlace working buffer.
        // UYVY422 = 2 bytes/pixel; stride may be padded so allocate generously.
        di_buf_.resize(size_t(src_h) * src_w * 2 + 4096);
    }

    ~PreviewEncoder() { sws_freeContext(sws_); }

    void write(const sdi::VideoFrame& vf) {
        const int stride = int(vf.stride);

        // Grow deinterlace buffer on the rare first-frame stride-mismatch.
        if (di_buf_.size() < vf.data.size())
            di_buf_.resize(vf.data.size());

        // Copy frame into working buffer so we don't touch the encoder's copy.
        std::memcpy(di_buf_.data(), vf.data.data(), vf.data.size());

        // Vertical linear-blend deinterlace: fuse the two temporally-offset
        // fields so motion (tickers, crawls, action) appears smooth.
        // Only odd lines are rewritten; even lines (field 1) are kept intact.
        for (int y = 1; y < src_h_ - 1; y += 2) {
            const uint8_t* prev = di_buf_.data() + (y - 1) * stride;
            uint8_t*       curr = di_buf_.data() +  y      * stride;
            const uint8_t* next = di_buf_.data() + (y + 1) * stride;
            for (int x = 0; x < stride; ++x)
                curr[x] = uint8_t((uint16_t(prev[x]) + uint16_t(next[x])) >> 1);
        }
        // Bottom edge: if the last line is odd, replicate its predecessor.
        if (src_h_ > 1 && (src_h_ & 1) == 0) {
            std::memcpy(di_buf_.data() + (src_h_ - 1) * stride,
                        di_buf_.data() + (src_h_ - 2) * stride,
                        stride);
        }

        const uint8_t* src[4]   = { di_buf_.data(), nullptr, nullptr, nullptr };
        const int      src_str[4] = { stride, 0, 0, 0 };
        sws_scale(sws_, src, src_str, 0, src_h_, planes_, strides_);

        uint32_t hdr[2] = { (uint32_t)dst_w_, (uint32_t)dst_h_ };
#ifdef _WIN32
        _write(1, hdr,        8);
        _write(1, yuv_.data(), (unsigned)yuv_.size());
        _commit(1);
#else
        fwrite(hdr,        1, 8,           stdout);
        fwrite(yuv_.data(), 1, yuv_.size(), stdout);
        fflush(stdout);
#endif
    }

private:
    SwsContext*          sws_;
    int                  src_h_, dst_w_, dst_h_;
    std::vector<uint8_t> yuv_;
    std::vector<uint8_t> di_buf_;   // deinterlace working buffer (pre-allocated)
    uint8_t*             planes_[4]{};
    int                  strides_[4]{};
};

#ifdef SDI_WITH_AJA
#  include "ntv2card.h"
#  include "ntv2devicefeatures.h"
#  include "ntv2utils.h"
#endif

#ifdef SDI_WITH_DECKLINK
#  include "decklink_device.h"
#endif

#ifdef SDI_WITH_NDI
#  include "ndi_output.h"
#  include "ndi_device.h"
#endif

namespace {

struct Args {
    std::string backend        = "decklink";       // decklink | aja | ndi
    std::string device_id      = "0";
    std::string connection     = "sdi";            // passed to CaptureConfig
    std::string dest           = "127.0.0.1:4200"; // host:port — primary path
    std::string dest2          = "";               // host:port — secondary (2022-7)
    int         latency_ms     = 150;
    int         bitrate_kbps   = 8000;
    std::string codec          = "h264_nvenc";     // or libx264, hevc_nvenc
    std::string audio_codec    = "libopus";        // or aac
    int         audio_kbps     = 192;
    int         audio_channels = 2;
    // NDI simultaneous output — when true, the captured signal is also sent as
    // an NDI source on the LAN regardless of the SRT destination.
    bool        ndi_out        = false;
    std::string ndi_name       = "SDI Stream";     // NDI source name visible on LAN

    // Adaptive bitrate — off by default so existing fixed-bitrate behavior
    // is unchanged unless explicitly opted into. --bitrate becomes the
    // ceiling (starting point); the encoder steps down under real network
    // congestion (netq starting to drop packets — see the ABR loop in the
    // stats heartbeat) and back up gradually once conditions are clean.
    bool        abr            = false;
    int         abr_floor_pct  = 40;   // floor as % of --bitrate; won't step below this
};

void usage() {
    std::cerr <<
R"USAGE(sdi_stream -- SDI/NDI-in -> encode -> SRT
  --backend   <decklink|aja|ndi>  Capture backend (default: decklink)
  --device    <id>                Device index or NDI source name (default: 0)
  --conn      <sdi|hdmi>          Input connection type (default: sdi)
  --dest      <host:port>         SRT primary destination (default: 127.0.0.1:4200)
  --dest2     <host:port>         SRT secondary destination for SMPTE 2022-7 (optional)
  --latency   <ms>                SRT latency window in ms (default: 150)
  --bitrate   <kbps>              Video bitrate kbps (default: 8000)
  --codec     <name>              Video encoder name (default: h264_nvenc)
  --acodec    <name>              Audio encoder name (default: libopus)
  --abitrate  <kbps>              Audio bitrate kbps (default: 192)
  --achannels <n>                 SDI embedded audio channels (default: 2)
  --ndi-out                       Also send to NDI LAN output simultaneously
  --ndi-name  <name>              NDI source name visible on LAN (default: SDI Stream)
  --abr                           Adaptive bitrate: --bitrate becomes a ceiling;
                                  steps down under real network congestion, back
                                  up gradually once clean (default: off, fixed bitrate)
  --abr-floor-pct <n>             Won't step bitrate below this % of --bitrate (default: 40)

NDI notes:
  --backend ndi        Receive from an NDI source and bridge it to SRT.
                       Pass the full NDI source name as --device, e.g.
                         --device "WORKSTATION (NDI Cam 1)"
  --ndi-out            Works with any backend. While streaming to SRT the
                       signal is simultaneously published as an NDI source so
                       NDI-capable monitors, recorders, and software can subscribe.

When --dest2 is given, identical packets are sent to both destinations via two
independent ReconnectingSrtOutput instances (SMPTE 2022-7 sender protection).
Run sdi_receive on the other end to merge the paths back into one stream.
)USAGE";
}

bool parse_args(int argc, char** argv, Args& a) {
    for (int i = 1; i < argc; ++i) {
        auto arg = std::string_view(argv[i]);
        auto next = [&]() -> const char* {
            if (i + 1 >= argc) { usage(); std::exit(2); }
            return argv[++i];
        };
        if      (arg == "--backend")   a.backend        = next();
        else if (arg == "--device")    a.device_id      = next();
        else if (arg == "--conn")      a.connection     = next();
        else if (arg == "--dest")      a.dest           = next();
        else if (arg == "--latency")   a.latency_ms     = std::atoi(next());
        else if (arg == "--bitrate")   a.bitrate_kbps   = std::atoi(next());
        else if (arg == "--codec")     a.codec          = next();
        else if (arg == "--acodec")    a.audio_codec    = next();
        else if (arg == "--abitrate")  a.audio_kbps     = std::atoi(next());
        else if (arg == "--achannels") a.audio_channels = std::atoi(next());
        else if (arg == "--dest2")     a.dest2          = next();
        else if (arg == "--ndi-out")   a.ndi_out        = true;
        else if (arg == "--ndi-name")  a.ndi_name       = next();
        else if (arg == "--abr")           a.abr           = true;
        else if (arg == "--abr-floor-pct") a.abr_floor_pct = std::atoi(next());
        else if (arg == "--list")        { /* handled before capture loop */ }
        else if (arg == "--list-codecs") { /* handled before capture loop */ }
        else if (arg == "-h" || arg == "--help") { usage(); return false; }
        else { std::cerr << "unknown arg: " << arg << "\n"; usage(); return false; }
    }
    return true;
}

std::atomic<bool> g_stop{false};
void on_signal(int) { g_stop = true; }

#ifdef _WIN32
// Windows console control handler — fires for CTRL+C, CTRL+BREAK, and window close.
// SIGTERM is never delivered by the OS on Windows, so this is the canonical way
// to handle graceful shutdown from an external signal or Task Manager.
static BOOL WINAPI console_ctrl_handler(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
        g_stop.store(true, std::memory_order_release);
        return TRUE;  // claim the event — don't let Windows kill us immediately
    }
    return FALSE;
}
#endif

} // namespace

// Escape a string for embedding in a JSON string literal.
static std::string json_str(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) { /* skip control chars */ }
                else          { out += char(c); }
                break;
        }
    }
    return out;
}

// Enumerate all capture inputs and print JSON to stdout, then exit.
// Each SDI port is emitted as a separate entry with device + channel fields.
// NDI sources include a "source_name" field with the full NDI source name.
// Output: [{"index":0,"device":0,"channel":1,"name":"Corvid44 #0 SDI 1","backend":"aja"}, ...]
static void list_devices() {
    std::cout << "[\n";
    bool first = true;
    int global_idx = 0;

    auto emit = [&](int device, int channel, const std::string& name, const std::string& backend) {
        if (!first) std::cout << ",\n";
        first = false;
        std::cout << "  {\"index\":"    << global_idx++
                  << ",\"device\":"    << device
                  << ",\"channel\":"   << channel
                  << ",\"name\":\""    << json_str(name) << "\""
                  << ",\"backend\":\"" << backend << "\"}";
    };

#ifdef SDI_WITH_AJA
    for (int i = 0; i < 8; ++i) {
        CNTV2Card card;
        if (!card.Open(UWord(i))) break;
        NTV2DeviceID devId = card.GetDeviceID();
        const std::string card_name = ::NTV2DeviceIDToString(devId) + " #" + std::to_string(i);

        // NTV2DeviceGetNumVideoChannels gives the total bidirectional channel count.
        // Each channel corresponds to one physical SDI connector on the card.
        const ULWord num_ch = ::NTV2DeviceGetNumVideoChannels(devId);
        card.Close();

        for (ULWord ch = 1; ch <= num_ch && ch <= 8; ++ch) {
            emit(i, int(ch), card_name + " SDI " + std::to_string(ch), "aja");
        }
    }
#endif

#ifdef SDI_WITH_DECKLINK
    sdi::decklink_list_devices(emit);
#endif

#ifdef SDI_WITH_NDI
    // NDI sources visible on the LAN (500 ms discovery window — fast enough
    // for already-running sources which respond via cached mDNS records).
    {
        auto ndi_sources = sdi::ndi_list_sources(500);
        for (int i = 0; i < int(ndi_sources.size()); ++i) {
            const std::string& src = ndi_sources[i];
            if (!first) std::cout << ",\n";
            first = false;
            // NDI sources emit an extra "source_name" field so the Electron
            // layer can pass the full name to --device without encoding it
            // into a device/channel integer pair.
            std::cout << "  {\"index\":"        << global_idx++
                      << ",\"device\":"         << i
                      << ",\"channel\":"        << 0
                      << ",\"name\":\""         << json_str(src) << "\""
                      << ",\"source_name\":\""  << json_str(src) << "\""
                      << ",\"backend\":\"ndi\"}";
        }
    }
#endif

    std::cout << "\n]\n";
}

// Probe available video encoders and print JSON to stdout, then exit.
// Each entry: {"name":"h264_nvenc","label":"H.264 (NVIDIA GPU)","available":true}
// GPU codecs are tested by actually opening a minimal encode context so that
// codecs compiled in but missing driver support report available=false.
static void list_codecs() {
    av_log_set_level(AV_LOG_QUIET);
    struct Candidate {
        const char* name;
        const char* label;
    };
    static const Candidate candidates[] = {
        { "h264_nvenc",  "H.264 (NVIDIA GPU)" },
        { "hevc_nvenc",  "H.265 (NVIDIA GPU)" },
        { "libx264",     "H.264 (CPU)"        },
        { "libx265",     "H.265 (CPU)"        },
    };

    std::cout << "[\n";
    bool first = true;
    for (const auto& c : candidates) {
        const AVCodec* codec = avcodec_find_encoder_by_name(c.name);
        bool available = false;
        if (codec) {
            // For hardware codecs, open a minimal context to confirm the
            // driver/hardware is actually present and working.
            AVCodecContext* ctx = avcodec_alloc_context3(codec);
            if (ctx) {
                ctx->width     = 320; ctx->height    = 240;
                // Use the codec's first supported pixel format so software
                // codecs (x265 = yuv420p) and hardware (nvenc = nv12) both probe cleanly.
                ctx->pix_fmt   = (codec->pix_fmts && codec->pix_fmts[0] != AV_PIX_FMT_NONE)
                                  ? codec->pix_fmts[0] : AV_PIX_FMT_NV12;
                ctx->time_base = AVRational{1, 30};
                ctx->framerate = AVRational{30, 1};
                ctx->bit_rate  = 500000;
                ctx->gop_size  = 30;
                available = (avcodec_open2(ctx, codec, nullptr) >= 0);
                avcodec_free_context(&ctx);
            }
        }
        if (!first) std::cout << ",\n";
        first = false;
        std::cout << "  {\"name\":\""  << json_str(c.name)
                  << "\",\"label\":\"" << json_str(c.label)
                  << "\",\"available\":" << (available ? "true" : "false") << "}";
    }
    std::cout << "\n]\n";
}

int main(int argc, char** argv) {
    // Handle --list / --list-codecs before anything else (no signal handler needed).
    for (int i = 1; i < argc; ++i) {
        if (std::string_view(argv[i]) == "--list")        { list_devices(); return 0; }
        if (std::string_view(argv[i]) == "--list-codecs") { list_codecs();  return 0; }
    }

    // stdout carries binary MJPEG frames for the Electron preview.
    // Must be in binary mode on Windows — text mode translates \n → \r\n
    // which corrupts JPEG data.
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    // Required before using any libavformat network protocol (SRT, RTP, etc.).
    // On Windows this calls WSAStartup; without it SRT socket creation crashes.
    avformat_network_init();

    Args args;
    if (!parse_args(argc, argv, args)) return 2;

#ifdef _WIN32
    // Windows: SIGTERM is never raised by the OS; use SetConsoleCtrlHandler instead.
    SetConsoleCtrlHandler(console_ctrl_handler, TRUE);
    std::signal(SIGINT, on_signal);   // still handle raise(SIGINT) from test harnesses
#else
    std::signal(SIGINT,  on_signal);
    std::signal(SIGTERM, on_signal);
#endif

    // --- Capture ---
    auto capture = sdi::make_capture(args.backend);
    if (!capture) {
        std::cerr << "error: backend '" << args.backend
                  << "' not compiled in (rebuild with ENABLE_DECKLINK or ENABLE_AJA)\n";
        return 1;
    }

    // Video queue: 8 frames ≈ 133ms @ 59.94 — absorbs brief encoder stalls
    // without growing the end-to-end latency budget.
    sdi::FrameQueue<sdi::VideoFrame> vq{8};
    sdi::FrameQueue<sdi::AudioFrame> aq{64};

    sdi::CaptureConfig cfg{
        .device_id      = args.device_id,
        .connection     = args.connection,
        .requested_mode = {},    // auto-detect
        .auto_detect    = true,
        .audio_channels = uint32_t(args.audio_channels),
    };

    std::atomic<uint64_t> video_count{0}, audio_count{0};

    const bool ok = capture->start(
        cfg,
        [&](sdi::VideoFrame&& f) { ++video_count; vq.push(std::move(f)); },
        [&](sdi::AudioFrame&& f) { ++audio_count; aq.push(std::move(f)); });
    if (!ok) { std::cerr << "capture start failed\n"; return 1; }

    std::cerr << "capture started on backend=" << capture->backend_name()
              << " mode=" << capture->current_mode().width
              << "x" << capture->current_mode().height
              << " dest=" << args.dest
              << " latency=" << args.latency_ms << "ms\n";

    // --- Encode + transport chain ---
    // Encoder is constructed with the mode reported by the capture device.
    // On DeckLink with auto-detect, this is the initial fallback; the actual
    // format arrives in VideoInputFormatChanged before the first frame.
    // If there is a mode mismatch, stop and restart with --codec matching the
    // actual signal.
    const sdi::VideoMode mode = capture->current_mode();

    sdi::Encoder enc(mode, sdi::EncoderConfig{args.codec, args.bitrate_kbps});

    // Prewarm the GPU encoder pipeline.  NVENC has a startup window of several
    // seconds before it produces its first output packet; audio accumulates
    // during that window and arrives desynchronised relative to video.
    // Prewarming with black frames at negative PTS puts NVENC in steady state
    // so the first real captured frame (pts=0) produces a packet immediately.
    enc.prewarm();

    // audio_codec "none" = disabled (no audio stream in the output)
    const bool audio_enabled = (args.audio_codec != "none");
    std::unique_ptr<sdi::AudioEncoder> aenc_ptr;
    if (audio_enabled) {
        aenc_ptr = std::make_unique<sdi::AudioEncoder>(
            args.audio_channels, 48000,
            sdi::AudioEncoderConfig{args.audio_codec, args.audio_kbps});
        std::cerr << "audio: " << args.audio_codec
                  << " " << args.audio_kbps << "kbps"
                  << " channels=" << args.audio_channels << "\n";
    } else {
        std::cerr << "audio: disabled\n";
    }

    // Helper: normalise bare host:port to srt://host:port.
    auto to_srt_uri = [](const std::string& s) {
        return (s.find("://") != std::string::npos) ? s : "srt://" + s;
    };

    // "none" or empty dest = preview-only mode: MJPEG goes to stdout,
    // no SRT output is started.  This avoids connection-retry log spam
    // when the user hasn't configured a streaming destination yet.
    const bool srt_enabled = !args.dest.empty() && args.dest != "none";

    const std::string srt_uri1 = srt_enabled ? to_srt_uri(args.dest) : "";
    const bool dual_path = srt_enabled && !args.dest2.empty();
    const std::string srt_uri2 = dual_path ? to_srt_uri(args.dest2) : "";

    if (srt_enabled) {
        if (dual_path)
            std::cerr << "SMPTE 2022-7: path1=" << srt_uri1 << " path2=" << srt_uri2 << "\n";
        else
            std::cerr << "SRT output: " << srt_uri1 << "\n";
    } else {
        std::cerr << "SRT output: disabled (preview-only mode)\n";
    }

    // --- SRT output (with auto-reconnect on both paths) ---
    // Objects declared before workers so they outlive them (C++ LIFO destruction).
    sdi::SrtOutputConfig out_cfg1{srt_uri1, args.latency_ms};
    sdi::SrtOutputConfig out_cfg2{srt_uri2, args.latency_ms};

    std::unique_ptr<sdi::ReconnectingSrtOutput> single_out;
    std::unique_ptr<sdi::DualSrtOutput>         dual_out;

    AVCodecContext* actx = audio_enabled && aenc_ptr ? aenc_ptr->audio_ctx() : nullptr;
    if (srt_enabled) {
        if (dual_path)
            dual_out = std::make_unique<sdi::DualSrtOutput>(
                out_cfg1, out_cfg2, enc.video_ctx(), actx);
        else
            single_out = std::make_unique<sdi::ReconnectingSrtOutput>(
                out_cfg1, enc.video_ctx(), actx);
    }

    // Network writes happen on a DEDICATED thread, decoupled from capture/encode
    // via netq. A synchronous network write (notably RTSP-over-TCP, which can
    // block on WAN round-trip time) must never stall the capture/encode path —
    // doing so backs up directly into the AJA capture queue and starts dropping
    // CAPTURED FRAMES at the source. Dropping an already-encoded packet here
    // under sustained network slowness is far cheaper than losing source frames.
    sdi::FrameQueue<PendingPacket> netq{256};

    // Diagnostic: measure wall-clock time (since this point) at which the first
    // video and first audio packet actually reach the network write call, plus
    // their encoded pts. If both packets carry pts≈0 but write_audio is called
    // noticeably later in wall-clock time than write_video, the delay is being
    // introduced by muxer/network buffering (av_interleaved_write_frame holding
    // audio), not by timestamp computation (already verified correct upstream).
    const auto diag_t0 = std::chrono::steady_clock::now();
    bool diag_logged_v = false, diag_logged_a = false;

    auto do_write_video = [&](AVPacket* pkt) {
        AVPacket* copy = av_packet_alloc();
        if (copy && av_packet_ref(copy, pkt) == 0)
            netq.push(PendingPacket{copy, false});
        else if (copy)
            av_packet_free(&copy);
    };
    auto do_write_audio = [&](AVPacket* pkt) {
        AVPacket* copy = av_packet_alloc();
        if (copy && av_packet_ref(copy, pkt) == 0)
            netq.push(PendingPacket{copy, true});
        else if (copy)
            av_packet_free(&copy);
    };

    std::jthread netout([&](std::stop_token st) {
        while (!st.stop_requested()) {
            auto item = netq.pop();
            if (!item) break;
            if (!item->is_audio && !diag_logged_v) {
                diag_logged_v = true;
                const double wall_ms = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - diag_t0).count();
                std::cerr << "diag: first video packet WRITE wall_ms=" << wall_ms
                          << " pkt_pts=" << item->pkt->pts << "\n";
            }
            if (item->is_audio && !diag_logged_a) {
                diag_logged_a = true;
                const double wall_ms = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - diag_t0).count();
                std::cerr << "diag: first audio packet WRITE wall_ms=" << wall_ms
                          << " pkt_pts=" << item->pkt->pts << "\n";
            }
            if (item->is_audio) {
                if (dual_out)        dual_out->write_audio(item->pkt);
                else if (single_out) single_out->write_audio(item->pkt);
            } else {
                if (dual_out)        dual_out->write_video(item->pkt);
                else if (single_out) single_out->write_video(item->pkt);
            }
        }
    });

    // --- NDI simultaneous output (optional) ---
    // Instantiated here so it outlives the worker threads that call into it.
#ifdef SDI_WITH_NDI
    std::unique_ptr<sdi::NDIOutput> ndi_output;
    if (args.ndi_out) {
        try {
            ndi_output = std::make_unique<sdi::NDIOutput>(args.ndi_name);
            std::cerr << "NDI output: \"" << args.ndi_name << "\"\n";
        } catch (const std::exception& ex) {
            std::cerr << "NDI output disabled: " << ex.what() << "\n";
        }
    }
#endif

    // Discard any frames that piled up in the queues while the main thread was
    // blocked inside enc.prewarm() — capture starts producing frames the moment
    // capture->start() returns, well before the workers below exist to consume
    // them. Without this, the audio queue (capacity 64) in particular holds a
    // multi-second backlog that the audio worker then drains faster than
    // real-time, making playback sound like audio is replaying stale content
    // seconds behind where video already is. Clearing both queues here means
    // both workers start consuming frames captured at "now", not "prewarm ago".
    vq.clear();
    aq.clear();

    // --- Video worker: queue → H.264 encode → SRT  +  YUV → stdout ---
    std::jthread vworker([&](std::stop_token st) {
        // Pass native resolution to the preview — no downscale, no quality loss.
        // The old 1280×720 target caused SWS_AREA box-blurring of text/graphics.
        PreviewEncoder preview(mode.width, mode.height, mode.width, mode.height);

        while (!st.stop_requested()) {
            auto f = vq.pop();
            if (!f) break;

            // Deinterlace once, in-place, before both the encoder and the
            // preview see the frame.  The same vertical linear-blend pass that
            // PreviewEncoder used to do is now applied to the raw UYVY buffer
            // so the H.264 output (SRT / RTP / UDP) is also progressive.
            // PreviewEncoder still has its own blend code as a safety net, but
            // with already-blended input the second pass is a cheap no-op.
            if (mode.interlaced) {
                const int stride = int(f->stride);
                const int h      = int(mode.height);
                uint8_t*  base   = f->data.data();
                for (int y = 1; y < h - 1; y += 2) {
                    const uint8_t* prev = base + (y - 1) * stride;
                    uint8_t*       curr = base +  y      * stride;
                    const uint8_t* next = base + (y + 1) * stride;
                    for (int x = 0; x < stride; ++x)
                        curr[x] = uint8_t((uint16_t(prev[x]) + uint16_t(next[x])) >> 1);
                }
                // Last odd line (even-height frames): copy from the line above.
                if (h > 1 && (h & 1) == 0)
                    std::memcpy(base + (h - 1) * stride, base + (h - 2) * stride, stride);
            }

            // NDI gets the raw frame first — before the encoder runs.
            // This eliminates the encode latency from the NDI signal path.
#ifdef SDI_WITH_NDI
            if (ndi_output) ndi_output->send_video(*f);
#endif
            preview.write(*f);

            // Skip encoding entirely when there is no SRT destination
            // (NDI-only mode or preview-only mode).  Encoding at full bitrate
            // with no output is pure CPU waste and adds frame latency.
            if (srt_enabled)
                enc.encode(*f, [&](AVPacket* pkt) { do_write_video(pkt); });
        }
    });

    // --- Audio worker ---
    std::jthread aworker([&](std::stop_token st) {
        while (!st.stop_requested()) {
            auto f = aq.pop();
            if (!f) break;
#ifdef SDI_WITH_NDI
            if (ndi_output) ndi_output->send_audio(*f);
#endif
            if (srt_enabled && audio_enabled && aenc_ptr)
                aenc_ptr->encode(*f, [&](AVPacket* pkt) { do_write_audio(pkt); });
        }
    });

    // --- Heartbeat / stats loop ---
    // Structured JSON is written to stdout every second so the supervisor
    // process can parse it without scraping logs. Error/diagnostic messages
    // go to stderr so they don't corrupt the JSON stream.
    uint64_t last_v = 0, last_a = 0;
    // Format: WxHi@fps (interlaced field rate) or WxHp@fps (progressive frame rate).
    // Interlaced uses the field rate (fps_num/fps_den × 2) so "1080i59.94" matches
    // the broadcast naming convention operators expect.
    {
        // (build happens below — declared in enclosing scope so the stats loop can see it)
    }
    const double base_fps = double(mode.fps_num) / mode.fps_den;
    const double display_fps = mode.interlaced ? base_fps * 2.0 : base_fps;
    // Round to standard broadcast frame rates (59.94, 29.97, 25, 23.976, etc.)
    char fps_buf[16];
    if (std::abs(display_fps - std::round(display_fps)) < 0.02)
        std::snprintf(fps_buf, sizeof(fps_buf), "%.0f", std::round(display_fps));
    else
        std::snprintf(fps_buf, sizeof(fps_buf), "%.2f", display_fps);
    const std::string mode_str =
        std::to_string(mode.width) + "x" +
        std::to_string(mode.height) +
        (mode.interlaced ? "i" : "p") + "@" +
        fps_buf;
    // Adaptive bitrate state. netq (declared above) is the queue between
    // encode and the network-write thread, sized specifically so a slow
    // network write never stalls capture — see its declaration comment.
    // That means when the network genuinely can't keep up, packets pile up
    // and get dropped THERE, not lost at the source. It's already computed
    // every heartbeat for the JSON stats below, so it doubles as a real,
    // no-extra-cost congestion signal without needing raw SRT socket stats
    // (this sender goes through libavformat's SRT muxer, not raw libsrt, so
    // srt_bistats() isn't available here the way it is in sdi_player.cpp's
    // receive path).
    int      abr_current_kbps  = args.bitrate_kbps;
    uint64_t abr_last_netq_drop = 0;
    int      abr_clean_streak   = 0;
    const int abr_floor_kbps = std::max(1, args.bitrate_kbps * args.abr_floor_pct / 100);
    constexpr double kAbrStepDownFactor        = 0.80;  // -20% per congested second
    constexpr double kAbrStepUpFactor          = 1.05;  // +5% per clean second, once streak is long enough
    constexpr int    kAbrCleanSecondsBeforeUp  = 5;

    while (!g_stop) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
        const auto v   = video_count.load();
        const auto a   = audio_count.load();
        const auto vd  = vq.dropped();
        const auto ad  = aq.dropped();
        const auto nd  = netq.dropped();
        const auto now = std::time(nullptr);

        // JSON stats — written to stderr so stdout stays as pure MJPEG binary.
        // audio_captured = frames received from the capture card (always non-zero
        // when SDI audio is present, regardless of whether encoding is enabled).
        std::cerr
            << "{\"type\":\"stats\""
            << ",\"ts\":"              << now
            << ",\"video_fps\":"       << (v - last_v)
            << ",\"audio_captured\":"  << (a - last_a)
            << ",\"audio_enc\":\""      << (audio_enabled ? "on" : "off") << "\""
            << ",\"vq_drop\":"         << vd
            << ",\"aq_drop\":"         << ad
            << ",\"vq_size\":"         << vq.size()
            << ",\"aq_size\":"         << aq.size()
            << ",\"netq_drop\":"       << nd
            << ",\"netq_size\":"       << netq.size()
            << ",\"backend\":\""       << args.backend << "\""
            << ",\"mode\":\""          << mode_str << "\""
            << ",\"dest\":\""          << args.dest << "\""
            << (args.abr ? ",\"abr_kbps\":" + std::to_string(abr_current_kbps) : std::string())
            << "}\n";

        last_v = v; last_a = a;

        if (args.abr) {
            const bool congested = nd > abr_last_netq_drop;
            abr_last_netq_drop = nd;

            if (congested) {
                abr_clean_streak = 0;
                const int stepped = std::max(abr_floor_kbps,
                    int(abr_current_kbps * kAbrStepDownFactor));
                if (stepped < abr_current_kbps) {
                    abr_current_kbps = stepped;
                    enc.set_bitrate(abr_current_kbps);
                    std::cerr << "abr: network congestion (netq dropping) — stepping down to "
                              << abr_current_kbps << " kbps\n";
                }
            } else {
                ++abr_clean_streak;
                if (abr_clean_streak >= kAbrCleanSecondsBeforeUp &&
                    abr_current_kbps < args.bitrate_kbps) {
                    abr_clean_streak = 0;
                    const int stepped = std::min(args.bitrate_kbps,
                        int(abr_current_kbps * kAbrStepUpFactor));
                    if (stepped > abr_current_kbps) {
                        abr_current_kbps = stepped;
                        enc.set_bitrate(abr_current_kbps);
                        std::cerr << "abr: network clean for " << kAbrCleanSecondsBeforeUp
                                  << "s — stepping up to " << abr_current_kbps << " kbps\n";
                    }
                }
            }
        }
    }

    // Shutdown sequence:
    //  1. Stop capture (no new frames produced).
    //  2. Close capture queues (vworker/aworker see nullopt and exit their loops).
    //  3. Explicitly join vworker/aworker — they must fully stop pushing into
    //     netq BEFORE netq is closed, or netout could close while a push is
    //     still in flight.
    //  4. Close netq (netout sees nullopt and exits after draining).
    //  5. netout's jthread destructor joins it (already exited, so immediate).
    //  6. SrtOutput destructor: write trailer, close SRT/RTSP connection.
    capture->stop();
    vq.close();
    aq.close();
    vworker.request_stop();
    vworker.join();
    aworker.request_stop();
    aworker.join();
    netq.close();
    // netout, out destroyed in reverse order when scope exits.
    return 0;
}
