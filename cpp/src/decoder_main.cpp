// sdi_decoder — SRT -> H.264 + Opus decode -> SDI output (via PlayoutDevice)
//
// The receive-side counterpart to arena_stream: runs at a remote facility,
// pulls the stream back from the server, decodes it, and feeds it out to a
// physical SDI connector so downstream broadcast equipment (monitor wall,
// switcher, etc.) sees it as a normal SDI source.
//
// Reuses the same "skip probing, decode from the first packet" approach as
// sdi_player.cpp (this project's SRT-to-preview tool) — the stream is always
// H.264(+Opus)-in-MPEG-TS from arena_stream, so there's no need to pay the
// avformat_find_stream_info() cost of reading ahead through the SRT jitter
// buffer just to learn a codec we already know.
//
// stderr: JSON stats every 200ms + diagnostic messages (same convention as
// arena_stream and sdi_player, so existing log-parsing UI code applies here
// too).

#include "playout_device.h"
#include "frame_queue.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <future>
#include <iostream>
#include <memory>
#include <new>
#include <stop_token>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

#ifdef SDI_WITH_AJA
#  include "ntv2card.h"
#  include "ntv2devicefeatures.h"
#  include "ntv2utils.h"
#endif

#ifdef SDI_WITH_DECKLINK
#  include "decklink_device.h"
#endif

#ifdef _WIN32
#  include <fcntl.h>
#  include <io.h>
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  include <windows.h>   // EXCEPTION_EXECUTE_HANDLER for the AJA-probe SEH guard below
#  pragma comment(lib,"ws2_32.lib")
#endif

#include <srt/srt.h>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
}

// ─── Command-line args ────────────────────────────────────────────────────────
struct Args {
    std::string src        = "";
    std::string backend    = "decklink";   // "decklink" or "aja"
    std::string device_id  = "0";
    std::string connection = "1";
    int         latency    = 40;           // ms — SRT jitter buffer
    uint32_t    audio_channels = 2;
    bool        preview_only = false;      // decode + emit stdout preview, no SDI hardware at all
    bool        force_progressive = false; // diagnostic: report the source as progressive to the
                                            // playout device regardless of its real interlace flag
    std::string reference = "freerun";     // AJA only: "freerun" or "input1".."input8"
};

static bool parse_args(int argc, char** argv, Args& a) {
    for (int i = 1; i < argc; ++i) {
        std::string_view arg = argv[i];
        auto nxt = [&]() { return (i+1<argc) ? argv[++i] : ""; };
        if      (arg=="--src")               a.src        = nxt();
        else if (arg=="--backend")           a.backend    = nxt();
        else if (arg=="--device")            a.device_id  = nxt();
        else if (arg=="--conn")              a.connection = nxt();
        else if (arg=="--latency")           a.latency    = std::atoi(nxt());
        else if (arg=="--achannels")         a.audio_channels = uint32_t(std::atoi(nxt()));
        else if (arg=="--preview-only")      a.preview_only = true;
        else if (arg=="--force-progressive") a.force_progressive = true;
        else if (arg=="--reference")         a.reference  = nxt();
        else if (arg=="-h"||arg=="--help") {
            std::cerr << "sdi_decoder --src srt://HOST:PORT --backend decklink|aja "
                         "--device N --conn N [--latency MS] [--preview-only] [--force-progressive] "
                         "[--reference freerun|input1..8]\n";
            return false;
        }
    }
    if (a.src.empty()) { std::cerr << "error: --src required\n"; return false; }
    return true;
}

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

#if defined(SDI_WITH_AJA) && defined(_WIN32)
// Everything risky — constructing CNTV2Card, Open, GetDeviceID,
// GetNumVideoChannels, Close — is inside ONE __try block using a heap
// pointer rather than a stack object, since MSVC forbids __try/__except in
// any function containing a local object with a non-trivial destructor
// (raw pointers don't have one, so this is allowed). An earlier version
// only wrapped card->Open() itself, with the CNTV2Card constructed on the
// caller's stack outside the guard — but on a machine with no ajantv2
// driver installed at all, the crash confirmed in the field can happen
// as early as CONSTRUCTING the object, before Open() is ever called, which
// that version didn't cover. This wraps the whole lifecycle so nothing
// AJA-related can take the process down regardless of exactly where the
// driver-absence fault actually triggers.
static bool aja_probe_index_safe(int index, NTV2DeviceID& devId, ULWord& numCh) {
    // A plain `new`/`delete` CNTV2Card* still tripped MSVC's C2712 — the
    // `new` expression itself needs unwind support to avoid leaking on a
    // throwing constructor, which is exactly the "object unwinding" the
    // restriction means. Placement-new into raw malloc'd memory has no
    // such implicit cleanup, so there's nothing for the compiler to object to.
    void* mem = std::malloc(sizeof(CNTV2Card));
    if (!mem) return false;
    bool ok = false;
    __try {
        CNTV2Card* card = new (mem) CNTV2Card();
        ok = card->Open(UWord(index)) != 0;
        if (ok) {
            devId = card->GetDeviceID();
            numCh = ::NTV2DeviceGetNumVideoChannels(devId);
            card->Close();
        }
        card->~CNTV2Card();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ok = false;   // leaks the placement-constructed card if the fault hit
                      // mid-construction — a one-shot CLI process about to
                      // exit anyway, harmless.
    }
    std::free(mem);
    return ok;
}
#endif

// Enumerate all SDI outputs and print JSON to stdout, then exit — same
// convention and format as arena_stream's --list, so the decoder UI's
// device picker can reuse the exact same rendering code.
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
    // CNTV2Card::Open() is expected to fail fast when no AJA card/driver is
    // present, but on a machine with no ajantv2 driver installed at all
    // (e.g. a DeckLink-only box) it can hang instead of returning quickly —
    // confirmed in the field: --list printed the opening "[" and then never
    // returned at all, blocking DeckLink enumeration from ever running.
    // Running the probe on its own thread with a bounded wait means a stuck
    // AJA driver can never again block finding out about a DeckLink card
    // that's actually present and working. Results are collected into a
    // heap-owned vector (not captured by reference into emit/first/
    // global_idx) so it stays safe to read even if the probing thread never
    // actually finishes and we move on without it.
    auto aja_found = std::make_shared<std::vector<std::tuple<int,int,std::string>>>();
    // Heap-allocated and deliberately leaked in the timeout branch below —
    // std::future's destructor (for a future from std::async) BLOCKS until
    // the thread finishes. Letting a local std::future go out of scope while
    // its thread is still stuck would silently re-introduce the exact hang
    // this code exists to avoid, just delayed to the end of this function
    // instead of at the wait_for call. This is a one-shot --list command
    // that's about to exit anyway, so leaking a still-stuck probe thread is
    // harmless — the OS reclaims it when the process exits.
    auto* aja_task = new std::future<void>(std::async(std::launch::async, [aja_found]() {
        for (int i = 0; i < 8; ++i) {
            NTV2DeviceID devId; ULWord num_ch;
#ifdef _WIN32
            if (!aja_probe_index_safe(i, devId, num_ch)) break;
#else
            CNTV2Card card;
            if (!card.Open(UWord(i))) break;
            devId = card.GetDeviceID();
            num_ch = ::NTV2DeviceGetNumVideoChannels(devId);
            card.Close();
#endif
            const std::string card_name = ::NTV2DeviceIDToString(devId) + " #" + std::to_string(i);
            for (ULWord ch = 1; ch <= num_ch && ch <= 8; ++ch)
                aja_found->emplace_back(i, int(ch), card_name + " SDI " + std::to_string(ch));
        }
    }));
    if (aja_task->wait_for(std::chrono::seconds(3)) == std::future_status::timeout) {
        std::cerr << "sdi_decoder: AJA device probe did not respond within 3s — "
                     "skipping it and continuing with other backends. This usually means "
                     "the ajantv2 driver isn't installed/running on this machine.\n";
        // Leak aja_task on purpose — see comment above.
    } else {
        for (auto& [device, channel, name] : *aja_found)
            emit(device, channel, name, "aja");
        delete aja_task;
    }
#endif

#ifdef SDI_WITH_DECKLINK
    sdi::decklink_list_devices(emit);
#endif

    std::cout << "\n]\n";
}

// ─── SRT AVIO read callback ───────────────────────────────────────────────────
static int srt_read_cb(void* opaque, uint8_t* buf, int sz) {
    SRTSOCKET sock = *(SRTSOCKET*)opaque;
    int n = srt_recv(sock, (char*)buf, sz);
    return (n <= 0) ? AVERROR_EOF : n;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
struct Stats {
    double  rtt_ms       = 0;
    double  bitrate_kbps = 0;
    int64_t pkt_loss     = 0;
    int64_t pkt_drop     = 0;
    int     decoded_fps  = 0;
    std::string format;
};

static void emit_stats(const Stats& s) {
    std::cerr << "{\"type\":\"decoder_stats\""
              << ",\"rttMs\":"       << s.rtt_ms
              << ",\"bitrateKbps\":" << s.bitrate_kbps
              << ",\"pktLoss\":"     << s.pkt_loss
              << ",\"pktDrop\":"     << s.pkt_drop
              << ",\"decodedFps\":"  << s.decoded_fps
              << ",\"format\":\""    << s.format << "\""
              << "}\n";
}

// A converted-but-not-yet-emitted preview frame (YUV420P payload only, no
// wire-format header — that's added at emission time). Queued by the decode
// loop and drained by preview_pacer_loop() below.
struct PreviewFrame {
    uint32_t width = 0, height = 0;
    std::vector<uint8_t> yuv;
};

// Emits queued preview frames to stdout at a fixed cadence matching the
// stream's real frame rate, repeating the last frame on underrun instead of
// skipping — the same technique the AJA/DeckLink playout threads use for the
// actual SDI output. Previously the decode loop wrote each converted frame
// to stdout the instant it was ready, so the preview directly reflected raw
// decode/network arrival jitter (bursty) while the real SDI output looked
// smooth (hardware-paced) — this makes the preview represent what the
// output actually looks like instead of the decoder's raw delivery timing.
static void preview_pacer_loop(std::stop_token st,
                                sdi::FrameQueue<PreviewFrame>& queue,
                                std::atomic<bool>& mode_ready,
                                const sdi::VideoMode& mode) {
    while (!st.stop_requested() && !mode_ready.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    if (st.stop_requested()) return;

    const auto frame_dur = mode.frame_duration();
    PreviewFrame last;
    bool have_last = false;
    auto next_tick = std::chrono::steady_clock::now();

    while (!st.stop_requested()) {
        auto next = queue.try_pop();
        if (next) { last = std::move(*next); have_last = true; }
        if (have_last) {
            uint32_t header[2] = { last.width, last.height };
            std::fwrite(header, sizeof(header), 1, stdout);
            std::fwrite(last.yuv.data(), 1, last.yuv.size(), stdout);
            std::fflush(stdout);
        }
        next_tick += std::chrono::duration_cast<std::chrono::steady_clock::duration>(frame_dur);
        std::this_thread::sleep_until(next_tick);
    }
}

int main(int argc, char** argv) {
    // Handle --list before anything else (no network/device setup needed).
    for (int i = 1; i < argc; ++i) {
        if (std::string_view(argv[i]) == "--list") { list_devices(); return 0; }
    }

    Args args;
    if (!parse_args(argc, argv, args)) return 2;

#ifdef _WIN32
    // stdout carries binary raw-YUV preview frames for the Electron UI — must
    // be in binary mode, same reasoning as arena_stream's MJPEG preview
    // (text mode translates \n -> \r\n, corrupting binary frame data).
    _setmode(_fileno(stdout), _O_BINARY);
    WSADATA wsa; WSAStartup(MAKEWORD(2,2), &wsa);
#endif

    srt_startup();
    avformat_network_init();

    // ── 1. Playout device — opened before the network connection so any
    //    hardware failure surfaces immediately instead of after a stream
    //    handshake. Its actual mode gets set once we know the decoded
    //    stream's real dimensions/framerate, below. Skipped entirely in
    //    --preview-only mode: the user should be able to watch a stream
    //    before committing to (or even having) SDI output hardware. ──────
    std::unique_ptr<sdi::PlayoutDevice> playout;
    if (!args.preview_only) {
        playout = sdi::make_playout(args.backend);
        if (!playout) {
            std::cerr << "sdi_decoder: backend '" << args.backend
                      << "' not available (not compiled in?)\n";
            return 1;
        }
    }

    // ── 2. Parse SRT URI ────────────────────────────────────────────────
    // mediamtx's SRT listener is a single socket shared by every path —
    // it uses the streamid (the ?streamid=read:<path> query param) to pick
    // which path to serve. Query params were previously stripped out to
    // find host/port and then discarded entirely, so mediamtx received a
    // connection with no streamid and rejected it (ERROR:PEER) no matter
    // which stream was selected.
    std::string raw = args.src;
    std::string hp = raw; if (hp.substr(0,6)=="srt://") hp=hp.substr(6);
    auto q = hp.find('?');
    std::string query = (q!=std::string::npos) ? hp.substr(q+1) : "";
    if (q!=std::string::npos) hp=hp.substr(0,q);
    auto col = hp.rfind(':');
    std::string host = (col!=std::string::npos) ? hp.substr(0,col) : hp;
    int  port        = (col!=std::string::npos) ? std::atoi(hp.substr(col+1).c_str()) : 4200;

    std::string streamid;
    {
        const std::string key = "streamid=";
        auto pos = query.find(key);
        if (pos != std::string::npos) {
            auto start = pos + key.size();
            auto end   = query.find('&', start);
            streamid   = query.substr(start, end == std::string::npos ? std::string::npos : end - start);
        }
    }

    // ── 3. Open SRT socket ──────────────────────────────────────────────
    // SRTO_RCVLATENCY takes MILLISECONDS via the C API (unlike the srt://
    // URI's ?latency= query param, which is microseconds) — passing
    // args.latency*1000 here was requesting e.g. 40000ms (40s) instead of
    // 40ms, so every connection over-buffered until the 8192-packet receive
    // window overflowed before anything became playable.
    SRTSOCKET sock = srt_create_socket();
    {
        int lat_ms = args.latency;
        srt_setsockopt(sock, 0, SRTO_RCVLATENCY, &lat_ms, sizeof(lat_ms));
        if (!streamid.empty()) {
            srt_setsockopt(sock, 0, SRTO_STREAMID, streamid.c_str(), int(streamid.size()));
        }
    }
    struct sockaddr_in sa{};
    sa.sin_family = AF_INET; sa.sin_port = htons((uint16_t)port);
    inet_pton(AF_INET, host.c_str(), &sa.sin_addr);

    std::cerr << "sdi_decoder: connecting to " << host << ":" << port << "\n";
    if (srt_connect(sock, (struct sockaddr*)&sa, sizeof(sa)) < 0) {
        std::cerr << "sdi_decoder: connect failed: " << srt_getlasterror_str() << "\n";
        srt_cleanup(); return 1;
    }
    std::cerr << "sdi_decoder: connected\n";

    // ── 4. Wrap SRT in AVIO, force MPEG-TS format (skip probing). ──────
    const int AVIO_SZ = 188 * 16;
    uint8_t* avio_buf = (uint8_t*)av_malloc(AVIO_SZ);
    AVIOContext* avio = avio_alloc_context(avio_buf, AVIO_SZ, 0, &sock,
                                           srt_read_cb, nullptr, nullptr);
    const AVInputFormat* mpegts_fmt = av_find_input_format("mpegts");

    AVFormatContext* fmt = avformat_alloc_context();
    fmt->pb                   = avio;
    fmt->probesize            = 0;
    fmt->max_analyze_duration = 0;

    if (avformat_open_input(&fmt, nullptr, mpegts_fmt, nullptr) < 0) {
        std::cerr << "sdi_decoder: avformat_open_input failed\n"; return 1;
    }

    // ── 5. Find video + audio streams (read a few packets if not already
    //    known from PAT/PMT — same approach as sdi_player.cpp). ─────────
    int vsi = -1, asi = -1;
    for (unsigned i = 0; i < fmt->nb_streams; ++i) {
        const auto type = fmt->streams[i]->codecpar->codec_type;
        if (type == AVMEDIA_TYPE_VIDEO && vsi < 0) vsi = int(i);
        if (type == AVMEDIA_TYPE_AUDIO && asi < 0) asi = int(i);
    }
    if (vsi < 0) {
        AVPacket* probe = av_packet_alloc();
        for (int n = 0; n < 128 && vsi < 0; ++n) {
            if (av_read_frame(fmt, probe) < 0) break;
            av_packet_unref(probe);
            for (unsigned i = 0; i < fmt->nb_streams; ++i) {
                const auto type = fmt->streams[i]->codecpar->codec_type;
                if (type == AVMEDIA_TYPE_VIDEO && vsi < 0) vsi = int(i);
                if (type == AVMEDIA_TYPE_AUDIO && asi < 0) asi = int(i);
            }
        }
        av_packet_free(&probe);
    }
    if (vsi < 0) { std::cerr << "sdi_decoder: could not find video stream\n"; return 1; }
    std::cerr << "sdi_decoder: video on stream " << vsi
              << (asi >= 0 ? (", audio on stream " + std::to_string(asi)) : ", no audio") << "\n";

    // ── 6. Video decoder. ────────────────────────────────────────────────
    AVCodecParameters* vpar = fmt->streams[vsi]->codecpar;
    const AVCodec* vdec = avcodec_find_decoder(vpar->codec_id);
    AVCodecContext* vdec_ctx = avcodec_alloc_context3(vdec);
    avcodec_parameters_to_context(vdec_ctx, vpar);
    vdec_ctx->thread_count = 4;
    avcodec_open2(vdec_ctx, vdec, nullptr);

    // ── 7. Audio decoder (Opus, if present). ────────────────────────────
    AVCodecContext* adec_ctx = nullptr;
    SwrContext*     swr      = nullptr;
    if (asi >= 0) {
        AVCodecParameters* apar = fmt->streams[asi]->codecpar;
        const AVCodec* adec = avcodec_find_decoder(apar->codec_id);
        if (adec) {
            adec_ctx = avcodec_alloc_context3(adec);
            avcodec_parameters_to_context(adec_ctx, apar);
            if (avcodec_open2(adec_ctx, adec, nullptr) < 0) {
                avcodec_free_context(&adec_ctx);
                adec_ctx = nullptr;
            }
        }
    }

    // ── 8. Frame conversion buffers (built once the first frame reveals
    //    the actual decoded pixel format/size). ─────────────────────────
    AVFrame* vframe = av_frame_alloc();
    AVFrame* aframe = av_frame_alloc();
    AVPacket* pkt   = av_packet_alloc();
    SwsContext*   sws          = nullptr;
    AVPixelFormat sws_src_fmt  = AV_PIX_FMT_NONE;
    bool          have_out_mode   = false;   // out_mode known, buffers sized
    bool          playout_started = false;   // SDI hardware actually running (false in --preview-only)
    sdi::VideoMode out_mode{};
    std::vector<uint8_t> uyvy_buf;

    // Preview path: same raw-YUV420P-over-stdout wire format arena_stream's
    // Electron UI already knows how to render (see streamMjpegFrames in that
    // app's main.ts) — [uint32 LE width][uint32 LE height][Y][Cb][Cr]. Kept
    // entirely separate from the UYVY conversion above since SDI output and
    // on-screen preview need different pixel formats.
    SwsContext*   preview_sws         = nullptr;
    AVPixelFormat preview_sws_src_fmt = AV_PIX_FMT_NONE;
    std::vector<uint8_t> preview_buf;

    Stats stats;
    auto t_last_stats = std::chrono::steady_clock::now();
    auto t_last_fps   = std::chrono::steady_clock::now();
    int  fps_count    = 0;
    int64_t bytes_recv = 0, bytes_prev = 0;
    auto t_bytes = std::chrono::steady_clock::now();
    uint64_t video_seq = 0, audio_seq = 0;

    // Preview pacing thread — see preview_pacer_loop() above. preview_mode
    // is written once (when out_mode becomes known) and only read by the
    // pacer thread after observing preview_mode_ready, so no additional
    // synchronization beyond the atomic flag is needed.
    sdi::FrameQueue<PreviewFrame> preview_queue(4);
    std::atomic<bool> preview_mode_ready{false};
    sdi::VideoMode preview_mode{};
    std::jthread preview_pacer([&](std::stop_token st) {
        preview_pacer_loop(st, preview_queue, preview_mode_ready, preview_mode);
    });

    // ── 9. Decode loop. ──────────────────────────────────────────────────
    while (av_read_frame(fmt, pkt) >= 0) {
        bytes_recv += pkt->size;

        if (pkt->stream_index == vsi) {
            if (avcodec_send_packet(vdec_ctx, pkt) >= 0) {
                while (avcodec_receive_frame(vdec_ctx, vframe) == 0) {
                    fps_count++;

                    if (!have_out_mode && vframe->width > 0) {
                        const double fps_d = vdec_ctx->framerate.num > 0
                            ? double(vdec_ctx->framerate.num) / vdec_ctx->framerate.den
                            : 59.94;
                        out_mode.width   = uint32_t(vframe->width);
                        out_mode.height  = uint32_t(vframe->height);
                        out_mode.fps_num = vdec_ctx->framerate.num > 0 ? uint32_t(vdec_ctx->framerate.num) : 60000;
                        out_mode.fps_den = vdec_ctx->framerate.den > 0 ? uint32_t(vdec_ctx->framerate.den) : 1001;
                        out_mode.format  = sdi::PixelFormat::UYVY422_8;
                        // Never set before — out_mode.interlaced defaulted to
                        // false unconditionally, so an interlaced source (e.g.
                        // 1080i59.94) always got configured on the AJA output
                        // as progressive. That standard mismatch is exactly
                        // the kind of thing that shows up as the picture
                        // jumping/rolling on the monitor.
                        out_mode.interlaced = !args.force_progressive &&
                            (vframe->flags & AV_FRAME_FLAG_INTERLACED) != 0;

                        // Match arena_stream's own "WxHi@FIELDRATE" / "WxHp@FRAMERATE"
                        // convention (see formatMode() in the encoder app's main.ts) so
                        // the decoder UI reads the same way — interlaced formats are
                        // conventionally described by field rate (e.g. "1080i@59.94"),
                        // not the frame rate (29.97) fps_d holds. Previously this had no
                        // i/p designator at all and always printed the frame rate, so an
                        // actually-interlaced 1080i59.94 source displayed as "1080p29".
                        char buf[64];
                        if (out_mode.interlaced) {
                            std::snprintf(buf, sizeof(buf), "%dx%di@%.2f",
                                          vframe->width, vframe->height, fps_d * 2);
                        } else {
                            std::snprintf(buf, sizeof(buf), "%dx%dp@%.2f",
                                          vframe->width, vframe->height, fps_d);
                        }
                        stats.format = buf;
                        have_out_mode = true;
                        // Published for preview_pacer_loop (running on its own
                        // thread) — write the mode fully, THEN flip the atomic
                        // flag, so the pacer thread never observes a partially
                        // written VideoMode.
                        preview_mode = out_mode;
                        preview_mode_ready.store(true);

                        if (!args.preview_only) {
                            sdi::PlayoutConfig pcfg;
                            pcfg.device_id      = args.device_id;
                            pcfg.connection     = args.connection;
                            pcfg.mode           = out_mode;
                            pcfg.audio_channels = args.audio_channels;
                            pcfg.reference      = args.reference;
                            if (!playout->start(pcfg)) {
                                std::cerr << "sdi_decoder: playout->start() failed\n";
                                return 1;
                            }
                            playout_started = true;
                            uyvy_buf.resize(size_t(out_mode.width) * out_mode.height * 2);
                        }
                    }

                    // Rebuild swscale if the decoded pixel format changes.
                    AVPixelFormat ffmt = AVPixelFormat(vframe->format);
                    if (ffmt != sws_src_fmt) {
                        if (sws) sws_freeContext(sws);
                        sws_src_fmt = ffmt;
                        sws = sws_getContext(
                            vframe->width, vframe->height, sws_src_fmt,
                            int(out_mode.width), int(out_mode.height), AV_PIX_FMT_UYVY422,
                            SWS_BILINEAR, nullptr, nullptr, nullptr);
                    }

                    if (sws && playout_started) {
                        uint8_t* dst[4]     = { uyvy_buf.data(), nullptr, nullptr, nullptr };
                        int      dst_ls[4]  = { int(out_mode.width) * 2, 0, 0, 0 };
                        sws_scale(sws, vframe->data, vframe->linesize, 0, vframe->height,
                                  dst, dst_ls);

                        sdi::VideoFrame vf;
                        vf.data.assign(uyvy_buf.begin(), uyvy_buf.end());
                        vf.stride   = size_t(out_mode.width) * 2;
                        vf.mode     = out_mode;
                        vf.pts      = sdi::Nanos{
                            int64_t(video_seq) * out_mode.frame_duration().count()};
                        vf.sequence = video_seq++;
                        playout->write_video(std::move(vf));
                    }

                    // Preview: separate YUV420P conversion, written to stdout
                    // for the Electron UI's on-screen preview canvas. Runs
                    // whenever the output mode is known, independent of
                    // whether SDI hardware is attached — the user should be
                    // able to watch a stream without owning/selecting a card.
                    if (have_out_mode) {
                        if (ffmt != preview_sws_src_fmt) {
                            if (preview_sws) sws_freeContext(preview_sws);
                            preview_sws_src_fmt = ffmt;
                            preview_sws = sws_getContext(
                                vframe->width, vframe->height, preview_sws_src_fmt,
                                int(out_mode.width), int(out_mode.height), AV_PIX_FMT_YUV420P,
                                SWS_BILINEAR, nullptr, nullptr, nullptr);
                            const size_t ySz  = size_t(out_mode.width) * out_mode.height;
                            const size_t uvSz = (size_t(out_mode.width) / 2) * (out_mode.height / 2);
                            preview_buf.resize(8 + ySz + 2 * uvSz);
                        }
                        if (preview_sws) {
                            const int y_ls  = int(out_mode.width);
                            const int uv_ls = int(out_mode.width) / 2;
                            const size_t ySz = size_t(out_mode.width) * out_mode.height;
                            const size_t uvSz = size_t(uv_ls) * (out_mode.height / 2);
                            uint8_t* dst[4]    = {
                                preview_buf.data() + 8,
                                preview_buf.data() + 8 + ySz,
                                preview_buf.data() + 8 + ySz + uvSz,
                                nullptr,
                            };
                            int dst_ls[4] = { y_ls, uv_ls, uv_ls, 0 };
                            sws_scale(preview_sws, vframe->data, vframe->linesize, 0, vframe->height,
                                      dst, dst_ls);

                            static int diag_frames = 0;
                            if (diag_frames < 5) {
                                uint64_t sum = 0;
                                for (size_t i = 0; i < ySz; i += 97) sum += preview_buf[8 + i];
                                double avg_y = double(sum) / (ySz / 97 + 1);
                                std::cerr << "sdi_decoder: diag frame " << diag_frames
                                          << " decoder_fmt=" << av_get_pix_fmt_name(ffmt)
                                          << " " << out_mode.width << "x" << out_mode.height
                                          << " avgY=" << avg_y << "\n";
                                diag_frames++;
                            }

                            // Hand off to preview_pacer_loop instead of writing
                            // to stdout directly — pushing here as fast as
                            // frames decode (unpaced) is exactly what made the
                            // on-screen preview stutter with raw decode/network
                            // jitter while the actual SDI output looked smooth.
                            PreviewFrame pf;
                            pf.width  = out_mode.width;
                            pf.height = out_mode.height;
                            pf.yuv.assign(preview_buf.begin() + 8, preview_buf.end());
                            preview_queue.push(std::move(pf));
                        }
                    }

                    auto now = std::chrono::steady_clock::now();
                    auto fps_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        now - t_last_fps).count();
                    if (fps_ms >= 1000) {
                        stats.decoded_fps = int(std::lround(fps_count * 1000.0 / fps_ms));
                        fps_count = 0;
                        t_last_fps = now;
                    }
                }
            }
        } else if (asi >= 0 && pkt->stream_index == asi && adec_ctx) {
            if (avcodec_send_packet(adec_ctx, pkt) >= 0) {
                while (avcodec_receive_frame(adec_ctx, aframe) == 0) {
                    if (!swr) {
                        AVChannelLayout out_layout = AV_CHANNEL_LAYOUT_STEREO;
                        swr_alloc_set_opts2(&swr,
                            &out_layout, AV_SAMPLE_FMT_S32, 48000,
                            &aframe->ch_layout, AVSampleFormat(aframe->format), aframe->sample_rate,
                            0, nullptr);
                        swr_init(swr);
                    }
                    // Runs whenever swr is ready, NOT gated on playout_started —
                    // previously preview-only mode never executed this block at
                    // all, meaning the Opus decode + resample stage (identical
                    // code either way) had never actually been exercised or
                    // monitorable without going through real AJA/DeckLink
                    // hardware output. Feeding the card is still conditional on
                    // playout_started below; the audio-preview emission over
                    // stdout is not, so audio can be checked in-app the same
                    // way video preview already works — no hardware required.
                    if (swr) {
                        const int max_out = aframe->nb_samples * 48000 / aframe->sample_rate + 256;
                        std::vector<int32_t> out_samples(size_t(max_out) * args.audio_channels);
                        uint8_t* out_ptr = reinterpret_cast<uint8_t*>(out_samples.data());
                        const int converted = swr_convert(swr, &out_ptr, max_out,
                            const_cast<const uint8_t**>(aframe->data), aframe->nb_samples);
                        if (converted > 0) {
                            // Preview: same stdout pipe as video, distinguished by a
                            // sentinel header (width field == 0xFFFFFFFF, which no
                            // real video frame can ever have) so the existing
                            // Electron-side parser can demux both without a second
                            // pipe. Header: [0xFFFFFFFF][sampleRate][channels]
                            // [frameCount], followed by that many interleaved S32LE
                            // samples per channel.
                            std::vector<uint8_t> abuf(16 + size_t(converted) * args.audio_channels * sizeof(int32_t));
                            uint32_t* ahdr = reinterpret_cast<uint32_t*>(abuf.data());
                            ahdr[0] = 0xFFFFFFFFu;
                            ahdr[1] = 48000;
                            ahdr[2] = args.audio_channels;
                            ahdr[3] = uint32_t(converted);
                            std::memcpy(abuf.data() + 16, out_samples.data(),
                                        size_t(converted) * args.audio_channels * sizeof(int32_t));
                            std::fwrite(abuf.data(), 1, abuf.size(), stdout);
                            std::fflush(stdout);

                            if (playout_started && playout) {
                                sdi::AudioFrame af;
                                af.channels    = args.audio_channels;
                                af.sample_rate = 48000;
                                af.samples.assign(out_samples.begin(),
                                                  out_samples.begin() + size_t(converted) * args.audio_channels);
                                af.sequence = audio_seq++;
                                playout->write_audio(std::move(af));
                            }
                        }
                    }
                }
            }
        }
        av_packet_unref(pkt);

        auto now = std::chrono::steady_clock::now();
        auto stats_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now - t_last_stats).count();
        if (stats_ms >= 200) {
            t_last_stats = now;
            SRT_TRACEBSTATS s{};
            if (srt_bistats(sock, &s, 1, 1) == 0) {
                stats.rtt_ms   = s.msRTT;
                stats.pkt_loss = s.pktRcvLossTotal;
                stats.pkt_drop = s.pktRcvDropTotal;
            }
            auto bw_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - t_bytes).count();
            if (bw_ms >= 1000) {
                stats.bitrate_kbps = double(bytes_recv - bytes_prev) * 8.0 / bw_ms;
                bytes_prev = bytes_recv;
                t_bytes = now;
            }
            emit_stats(stats);
        }
    }

    if (playout) playout->stop();
    srt_close(sock);
    srt_cleanup();
    av_packet_free(&pkt);
    av_frame_free(&vframe);
    av_frame_free(&aframe);
    avcodec_free_context(&vdec_ctx);
    if (adec_ctx) avcodec_free_context(&adec_ctx);
    if (swr) swr_free(&swr);
    if (sws) sws_freeContext(sws);
    if (preview_sws) sws_freeContext(preview_sws);
    avformat_close_input(&fmt);
    return 0;
}
