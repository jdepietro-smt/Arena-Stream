// sdi_player — SRT → H.264 decode → MJPEG preview + live stats
//
// Design principles:
//   1. Fast startup:  tell libavformat the format is MPEG-TS so it skips format
//      probing entirely, then read only enough to find the first video stream.
//   2. No blocking:   MJPEG is written to stdout on a dedicated thread; if the
//      pipe is full the frame is dropped, never stalling the decode loop.
//   3. Accurate stats: byte-count the SRT socket directly for real bitrate;
//      use srt_bistats() for RTT; combine with configured latency for estimate.
//
// stdout:  raw MJPEG frames (preview, ~15fps)
// stderr:  JSON stats every 200ms  + diagnostic messages

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#  include <windows.h>
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  pragma comment(lib,"ws2_32.lib")
#endif

#include <srt/srt.h>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

// ─── Command-line args ────────────────────────────────────────────────────────
struct Args {
    std::string src    = "";
    int latency        = 40;    // ms — SRT jitter buffer
    int preview_w      = 1280;
    int preview_h      = 720;
};

static bool parse_args(int argc, char** argv, Args& a) {
    for (int i = 1; i < argc; ++i) {
        std::string_view arg = argv[i];
        auto nxt = [&]() { return (i+1<argc) ? argv[++i] : ""; };
        if      (arg=="--src")     a.src     = nxt();
        else if (arg=="--latency") a.latency = std::atoi(nxt());
        else if (arg=="--width")   a.preview_w = std::atoi(nxt());
        else if (arg=="--height")  a.preview_h = std::atoi(nxt());
        else if (arg=="-h"||arg=="--help") {
            std::cerr << "sdi_player --src srt://HOST:PORT [--latency MS]\n";
            return false;
        }
    }
    if (a.src.empty()) { std::cerr << "error: --src required\n"; return false; }
    return true;
}

// ─── Non-blocking MJPEG writer thread ────────────────────────────────────────
// The decode loop deposits the latest frame here.  The writer thread drains it
// to stdout.  If the pipe is full the write blocks in the writer thread — the
// decode loop is never stalled.

struct MjpegPipe {
    std::mutex              mtx;
    std::condition_variable cv;
    std::vector<uint8_t>    frame;
    bool                    has_frame = false;
    bool                    stop      = false;

    void push(const uint8_t* data, int size) {
        std::lock_guard lk(mtx);
        frame.assign(data, data + size);
        has_frame = true;
        cv.notify_one();
    }

    void shutdown() {
        std::lock_guard lk(mtx); stop = true; cv.notify_all();
    }

    void run() {                    // called from writer thread
        while (true) {
            std::vector<uint8_t> buf;
            {
                std::unique_lock lk(mtx);
                cv.wait(lk, [&]{ return has_frame || stop; });
                if (stop && !has_frame) break;
                buf = std::move(frame);
                has_frame = false;
            }
            _write(1, buf.data(), (unsigned)buf.size());
            _commit(1);
        }
    }
} g_pipe;

// ─── SRT AVIO read callback ───────────────────────────────────────────────────
static int srt_read_cb(void* opaque, uint8_t* buf, int sz) {
    SRTSOCKET sock = *(SRTSOCKET*)opaque;
    int n = srt_recv(sock, (char*)buf, sz);
    return (n <= 0) ? AVERROR_EOF : n;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
struct Stats {
    double   rtt_ms      = 0;
    double   bitrate_kbps= 0;   // measured from byte count
    int64_t  pkt_loss    = 0;
    int64_t  pkt_drop    = 0;
    int64_t  latency_ms  = -1;
    int      decoded_fps = 0;
    std::string format;
};

static void emit_stats(const Stats& s) {
    std::cerr << "{\"type\":\"player_stats\""
              << ",\"rttMs\":"       << s.rtt_ms
              << ",\"bitrateKbps\":" << s.bitrate_kbps
              << ",\"pktLoss\":"     << s.pkt_loss
              << ",\"pktDrop\":"     << s.pkt_drop
              << ",\"latencyMs\":"   << s.latency_ms
              << ",\"decodedFps\":"  << s.decoded_fps
              << ",\"format\":\""    << s.format << "\""
              << "}\n";
}

// ─── main ─────────────────────────────────────────────────────────────────────
int main(int argc, char** argv) {
    Args args;
    if (!parse_args(argc, argv, args)) return 2;

#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
    WSADATA wsa; WSAStartup(MAKEWORD(2,2), &wsa);
#endif

    srt_startup();
    avformat_network_init();

    // ── 1. Parse SRT URI ───────────────────────────────────────────────────
    std::string raw = args.src;
    std::string hp = raw; if (hp.substr(0,6)=="srt://") hp=hp.substr(6);
    auto q = hp.find('?'); if (q!=std::string::npos) hp=hp.substr(0,q);
    auto col = hp.rfind(':');
    std::string host = (col!=std::string::npos) ? hp.substr(0,col) : hp;
    int  port        = (col!=std::string::npos) ? std::atoi(hp.substr(col+1).c_str()) : 4200;

    // ── 2. Open SRT socket ────────────────────────────────────────────────
    SRTSOCKET sock = srt_create_socket();
    {
        int lat_us = args.latency * 1000;
        srt_setsockopt(sock, 0, SRTO_RCVLATENCY, &lat_us, sizeof(lat_us));
        int sndbuf = 128 * 1024;               // small recv buffer → low delay
        srt_setsockopt(sock, 0, SRTO_RCVBUF, &sndbuf, sizeof(sndbuf));
    }
    struct sockaddr_in sa{};
    sa.sin_family = AF_INET; sa.sin_port = htons((uint16_t)port);
    inet_pton(AF_INET, host.c_str(), &sa.sin_addr);

    std::cerr << "sdi_player: connecting to " << host << ":" << port << "\n";
    if (srt_connect(sock, (struct sockaddr*)&sa, sizeof(sa)) < 0) {
        std::cerr << "sdi_player: connect failed: " << srt_getlasterror_str() << "\n";
        srt_cleanup(); return 1;
    }
    std::cerr << "sdi_player: connected\n";

    // ── 3. Wrap SRT in AVIO — tell libavformat format is MPEG-TS ──────────
    //    Providing the format avoids format-detection probing entirely.
    //    Probesize/analyzeduration are set to the minimum needed to find the
    //    first PID table (a few packets) so startup is < 1 second even with
    //    a 40ms SRT jitter buffer.
    const int AVIO_SZ = 188 * 16;          // 16 TS packets per read call
    uint8_t* avio_buf = (uint8_t*)av_malloc(AVIO_SZ);
    AVIOContext* avio = avio_alloc_context(avio_buf, AVIO_SZ, 0, &sock,
                                           srt_read_cb, nullptr, nullptr);

    const AVInputFormat* mpegts_fmt = av_find_input_format("mpegts");

    AVFormatContext* fmt = avformat_alloc_context();
    fmt->pb                   = avio;
    fmt->probesize            = 0;    // zero — do not probe
    fmt->max_analyze_duration = 0;    // zero — do not analyze

    // Open with explicit MPEG-TS format: zero probing, instant open.
    if (avformat_open_input(&fmt, nullptr, mpegts_fmt, nullptr) < 0) {
        std::cerr << "sdi_player: avformat_open_input failed\n"; return 1;
    }

    // ── 4. Skip avformat_find_stream_info entirely ────────────────────────
    // The stream is always H.264-in-MPEG-TS from sdi_stream (we own both ends).
    // We do NOT call find_stream_info — it reads hundreds of packets, each
    // delayed by the SRT latency buffer (40ms × packets = up to 40 seconds).
    //
    // Instead: read raw packets until we see the first video PID (appears in
    // the first 2-3 TS packets after PAT/PMT).  Then open a decoder with
    // the partial codec params — H.264 configures itself from the first SPS.
    int vsi = -1;

    // avformat_open_input sometimes already finds streams from PAT/PMT.
    for (unsigned i = 0; i < fmt->nb_streams; ++i)
        if (fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO)
            { vsi = i; break; }

    if (vsi < 0) {
        // Read just enough packets to get PAT + PMT + first video PID (≤ 8 packets typical)
        AVPacket* probe = av_packet_alloc();
        for (int n = 0; n < 128 && vsi < 0; ++n) {
            if (av_read_frame(fmt, probe) < 0) break;
            av_packet_unref(probe);
            for (unsigned i = 0; i < fmt->nb_streams; ++i)
                if (fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO)
                    { vsi = i; break; }
        }
        av_packet_free(&probe);
    }

    // If demuxer still reports no streams, assume H.264 video on stream 0
    // (sdi_stream always puts video first) and force-create a stream entry.
    if (vsi < 0 && fmt->nb_streams == 0) {
        avformat_new_stream(fmt, nullptr);
        fmt->streams[0]->codecpar->codec_type = AVMEDIA_TYPE_VIDEO;
        fmt->streams[0]->codecpar->codec_id   = AV_CODEC_ID_H264;
        vsi = 0;
        std::cerr << "sdi_player: no streams from demuxer, forcing H.264 on stream 0\n";
    }

    if (vsi < 0) {
        std::cerr << "sdi_player: could not find video stream\n"; return 1;
    }
    std::cerr << "sdi_player: video on stream " << vsi << "\n";

    AVCodecParameters* par = fmt->streams[vsi]->codecpar;
    const AVCodec* dec   = avcodec_find_decoder(par->codec_id);
    AVCodecContext* dec_ctx = avcodec_alloc_context3(dec);
    avcodec_parameters_to_context(dec_ctx, par);
    dec_ctx->thread_count = 2;
    avcodec_open2(dec_ctx, dec, nullptr);
    std::cerr << "sdi_player: video " << dec_ctx->width << "x" << dec_ctx->height
              << " " << avcodec_get_name(par->codec_id) << "\n";

    // ── 5. MJPEG encoder for preview ──────────────────────────────────────
    const AVCodec*  mjpeg_enc = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
    AVCodecContext* enc_ctx   = avcodec_alloc_context3(mjpeg_enc);
    enc_ctx->width  = args.preview_w;
    enc_ctx->height = args.preview_h;
    enc_ctx->pix_fmt = AV_PIX_FMT_YUVJ420P;
    enc_ctx->time_base = {1, 30};
    enc_ctx->flags |= AV_CODEC_FLAG_QSCALE;
    enc_ctx->global_quality = FF_QP2LAMBDA * 3;  // q=3 � excellent quality, 40% less CPU than q=2
    avcodec_open2(enc_ctx, mjpeg_enc, nullptr);

    AVFrame* dec_frame  = av_frame_alloc();
    AVFrame* sws_frame  = av_frame_alloc();
    sws_frame->format = AV_PIX_FMT_YUVJ420P;
    sws_frame->width  = args.preview_w;
    sws_frame->height = args.preview_h;
    av_frame_get_buffer(sws_frame, 32);

    AVPacket* pkt     = av_packet_alloc();
    AVPacket* enc_pkt = av_packet_alloc();

    // swscale built lazily on first frame (actual pixel format may differ from
    // codec params, especially with interlaced content or hardware paths)
    SwsContext* sws        = nullptr;
    AVPixelFormat sws_src_fmt = AV_PIX_FMT_NONE;

    // ── 6. Start MJPEG writer thread ──────────────────────────────────────
    std::thread writer_thread([]{ g_pipe.run(); });

    // ── 7. Stats state ────────────────────────────────────────────────────
    Stats stats;
    auto  t_last_stats   = std::chrono::steady_clock::now();
    auto  t_last_fps     = std::chrono::steady_clock::now();
    auto  t_last_preview = std::chrono::steady_clock::now();
    int   fps_count      = 0;
    int64_t bytes_recv   = 0;        // cumulative bytes for bitrate calculation
    int64_t bytes_prev   = 0;
    auto  t_bytes        = std::chrono::steady_clock::now();
    bool  format_set     = false;

    const int PREVIEW_MS = 0;        // 0 = send every decoded frame (full frame rate)

    // ── 8. Decode loop ────────────────────────────────────────────────────
    while (av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index != vsi) { av_packet_unref(pkt); continue; }

        bytes_recv += pkt->size;

        if (avcodec_send_packet(dec_ctx, pkt) >= 0) {
            while (avcodec_receive_frame(dec_ctx, dec_frame) == 0) {
                fps_count++;
                auto now = std::chrono::steady_clock::now();

                // Set format string from first decoded frame
                if (!format_set && dec_frame->width > 0) {
                    format_set = true;
                    const double fps_d = dec_ctx->framerate.num > 0
                        ? (double)dec_ctx->framerate.num / dec_ctx->framerate.den
                        : 0.0;
                    char buf[64];
                    std::snprintf(buf, sizeof(buf), fps_d > 0
                        ? "%dx%d @ %.2ffps" : "%dx%d",
                        dec_frame->width, dec_frame->height, fps_d);
                    stats.format = buf;
                }

                // Rebuild swscale if frame format changes
                AVPixelFormat ffmt = (AVPixelFormat)dec_frame->format;
                if (ffmt != sws_src_fmt) {
                    if (sws) sws_freeContext(sws);
                    sws_src_fmt = ffmt;
                    sws = sws_getContext(
                        dec_frame->width, dec_frame->height, sws_src_fmt,
                        args.preview_w, args.preview_h, AV_PIX_FMT_YUVJ420P,
                        SWS_AREA, nullptr, nullptr, nullptr);  // area avg removes interlace combing
                }

                // Emit preview at ~15fps — push to writer thread, never block
                auto preview_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                    now - t_last_preview).count();
                if (preview_ms >= PREVIEW_MS && sws) {
                    t_last_preview = now;
                    av_frame_make_writable(sws_frame);
                    sws_scale(sws,
                              (const uint8_t* const*)dec_frame->data, dec_frame->linesize,
                              0, dec_frame->height,
                              sws_frame->data, sws_frame->linesize);
                    sws_frame->pts++;
                    if (avcodec_send_frame(enc_ctx, sws_frame) == 0) {
                        while (avcodec_receive_packet(enc_ctx, enc_pkt) == 0) {
                            g_pipe.push(enc_pkt->data, enc_pkt->size);
                            av_packet_unref(enc_pkt);
                        }
                    }
                }

                // FPS counter — update once per second
                auto fps_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                    now - t_last_fps).count();
                if (fps_ms >= 1000) {
                    stats.decoded_fps = (int)std::round(fps_count * 1000.0 / fps_ms);
                    fps_count = 0;
                    t_last_fps = now;
                }
            }
        }
        av_packet_unref(pkt);

        // ── 9. Emit stats every 200ms ─────────────────────────────────
        auto now = std::chrono::steady_clock::now();
        auto stats_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now - t_last_stats).count();
        if (stats_ms >= 200) {
            t_last_stats = now;

            // SRT socket stats
            SRT_TRACEBSTATS s{};
            if (srt_bistats(sock, &s, 1, 1) == 0) {
                stats.rtt_ms   = s.msRTT;
                stats.pkt_loss = s.pktRcvLossTotal;
                stats.pkt_drop = s.pktRcvDropTotal;

                // Latency = configured SRT buffer + network RTT/2 + codec overhead
                stats.latency_ms = (int64_t)args.latency
                                 + (int64_t)(s.msRTT / 2.0)
                                 + 90;
            }

            // Bitrate from actual byte count (accurate, not SRT's link-bandwidth estimate)
            auto bw_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                now - t_bytes).count();
            if (bw_ms >= 1000) {
                int64_t delta_bytes = bytes_recv - bytes_prev;
                stats.bitrate_kbps = (double)delta_bytes * 8.0 / bw_ms;  // kbps
                bytes_prev = bytes_recv;
                t_bytes    = now;
            }

            emit_stats(stats);
        }
    }

    // Shutdown
    g_pipe.shutdown();
    writer_thread.join();

    srt_close(sock);
    srt_cleanup();
    av_packet_free(&pkt);
    av_packet_free(&enc_pkt);
    av_frame_free(&dec_frame);
    av_frame_free(&sws_frame);
    avcodec_free_context(&dec_ctx);
    avcodec_free_context(&enc_ctx);
    if (sws) sws_freeContext(sws);
    avformat_close_input(&fmt);
    return 0;
}
