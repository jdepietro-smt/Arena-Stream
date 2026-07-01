#pragma once
//
// SRT output — wraps libavformat in MPEG-TS mux + libsrt caller mode.
// Accepts encoded video and audio AVPackets from the encoder stage and
// writes them to the SRT destination with correct stream indices and PTS.

#include <cstring>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
}

namespace sdi {

struct SrtOutputConfig {
    std::string uri;          // e.g. "srt://10.0.0.5:4200"
    int         latency_ms  = 150;
    std::string passphrase;   // AES-128/256 if non-empty
};

class SrtOutput {
public:
    // actx may be null for video-only streams.
    SrtOutput(const SrtOutputConfig& cfg,
              AVCodecContext* vctx,
              AVCodecContext* actx = nullptr) {
        // SRT URI query string uses microseconds for latency.
        // If the URI already contains mode= (e.g. mode=listener), keep it —
        // only append mode=caller when no mode is specified.
        // For non-SRT URIs (e.g. udp://) skip SRT-specific parameters entirely —
        // the UDP avio handler rejects them and avio_open2 fails silently.
        std::string url = cfg.uri;
        const bool is_srt  = (url.rfind("srt://", 0) == 0);
        const bool is_rtp  = (url.rfind("rtp://", 0) == 0);
        const bool is_rtsp = (url.rfind("rtsp://", 0) == 0);
        if (is_srt) {
            url += (url.find('?') == std::string::npos) ? "?" : "&";
            if (url.find("mode=") == std::string::npos)
                url += "mode=caller&";
            url += "latency=" + std::to_string(cfg.latency_ms * 1000);
            if (!cfg.passphrase.empty())
                url += "&passphrase=" + cfg.passphrase + "&pbkeylen=16";
        }

        // RTP → use the rtp muxer (raw NAL units in RTP packets, payload 96,
        // clock 90000). Compatible with GStreamer rtph264depay and VLC.
        // RTSP → use the rtsp muxer (libavformat performs ANNOUNCE+RECORD and
        // carries each track over its own native-clock-rate RTP session — no
        // MPEG-TS 90kHz PES wrapper, and so no PTS rescale step on the receiver
        // side for non-90kHz-clock codecs like Opus. Used as a workaround for
        // a confirmed mediamtx bug in its SRT/MPEG-TS→WebRTC Opus timestamp path.
        // MPEG-TS → use mpegts (SRT, UDP to ffplay/GStreamer tsdemux).
        const char* mux_fmt = is_rtp ? "rtp" : is_rtsp ? "rtsp" : "mpegts";

        if (avformat_alloc_output_context2(&fmt_, nullptr, mux_fmt, url.c_str()) < 0)
            throw std::runtime_error("avformat_alloc_output_context2 failed");

        vstream_ = avformat_new_stream(fmt_, nullptr);
        if (!vstream_) throw std::runtime_error("avformat_new_stream (video) failed");
        avcodec_parameters_from_context(vstream_->codecpar, vctx);
        vstream_->time_base = vctx->time_base;

        // The libavformat "rtp" muxer is single-stream only — one codec per URL.
        // Adding a second (audio) stream causes the muxer to produce malformed
        // packets that corrupt the H.264 RTP session.  Skip audio entirely for RTP;
        // the Optics PRO GStreamer pipeline doesn't have an audio branch anyway.
        if (actx && !is_rtp) {
            astream_ = avformat_new_stream(fmt_, nullptr);
            if (!astream_) throw std::runtime_error("avformat_new_stream (audio) failed");
            avcodec_parameters_from_context(astream_->codecpar, actx);
            astream_->time_base = actx->time_base;
        }

        // RTSP is unlike SRT/UDP/RTP: the rtsp output muxer manages its own
        // control connection and per-track RTP sessions internally during
        // avformat_write_header() (its AVOutputFormat has AVFMT_NOFILE set), so
        // it must NOT be opened via avio_open2 against the rtsp:// URL — doing
        // so fails immediately since there's no generic "rtsp" file protocol
        // for output. Only SRT/UDP/RTP go through the generic avio_open2 path.
        if (!is_rtsp) {
            // For plain UDP/MPEG-TS: set pkt_size to 7×188 = 1316 bytes so each
            // datagram is a multiple of 188 (GStreamer tsdemux requires this).
            // RTP handles its own packetisation — no pkt_size needed.
            AVDictionary* avio_opts = nullptr;
            if (!is_srt && !is_rtp)
                av_dict_set(&avio_opts, "pkt_size", "1316", 0);

            if (avio_open2(&fmt_->pb, url.c_str(), AVIO_FLAG_WRITE,
                           nullptr, &avio_opts) < 0) {
                av_dict_free(&avio_opts);
                throw std::runtime_error("avio_open2 failed — "
                                         "check destination and network (SRT/UDP)");
            }
            av_dict_free(&avio_opts);
        }

        // For RTP/RTSP: disable muxer buffering so packets are sent the instant
        // the encoder produces them. Each track has its own independent RTP
        // session (no shared byte-stream ordering requirement like MPEG-TS), so
        // there is no benefit to DTS-interleaving across tracks — only latency.
        if (is_rtp || is_rtsp) fmt_->max_delay = 0;

        // Prevent the mpegts muxer from seeding the PCR from the wall clock.
        // By default FFmpeg live-streams set start_time_realtime which offsets
        // video PTS to the current system time while audio pts_ starts at 0,
        // creating a multi-hour A/V offset. Force AV_NOPTS_VALUE so the muxer
        // uses the first packet DTS (0) as its PCR origin instead.
        fmt_->start_time_realtime = AV_NOPTS_VALUE;

        // Reduce max_interleave_delta from the default 10 seconds to 2 seconds.
        // The default causes av_interleaved_write_frame to hold audio packets
        // for up to 10 s waiting for video (NVENC startup). With 2 s, the muxer
        // releases audio and video together once NVENC produces its first packet
        // (typically within 100 ms after prewarm), or flushes after 2 s at most.
        fmt_->max_interleave_delta = 2000000;  // 2 seconds in microseconds

        // CRITICAL: disable libavformat's automatic per-stream timestamp shifting.
        // By default (AVFMT_AVOID_NEG_TS_AUTO), the muxer independently shifts
        // each stream's PTS/DTS to avoid negative timestamps relative to THAT
        // stream's own first packet. Audio and video are fed in with a carefully
        // aligned shared PTS origin (see aja_device.cpp) — independent per-stream
        // shifting destroys that relationship and is the root cause of audio
        // appearing tens of seconds out of sync with video. Confirmed via
        // ffprobe on the raw SRT feed at the mediamtx ingest point: video PTS
        // started near 0 while audio PTS started ~53s in, despite both being
        // fed pts=0 at stream start. Disabling the auto-shift makes the muxer
        // pass our PTS through unmodified.
        fmt_->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;

        AVDictionary* opts = nullptr;
        // RTSP transport: UDP, not TCP. TCP-interleaved RTSP serializes all
        // video+audio through one TCP stream, and TCP's congestion control
        // cannot sustain high-bitrate live video over a WAN link the way
        // SRT's purpose-built UDP transport does — confirmed in practice: at
        // 15 Mbps, RTSP/TCP to this server dropped to ~50% effective throughput
        // and added seconds of queuing latency. UDP RTP (mediamtx's fixed
        // rtpAddress/rtcpAddress ports) matches SRT's UDP-based delivery model
        // while still avoiding the MPEG-TS 90kHz audio PTS rewrite bug that
        // RTSP entirely sidesteps (each track keeps its own native RTP clock).
        // This is a private option of the rtsp muxer, passed to write_header,
        // not to avio_open2 (which isn't used for rtsp — see above).
        if (is_rtsp)
            av_dict_set(&opts, "rtsp_transport", "udp", 0);
        if (avformat_write_header(fmt_, &opts) < 0) {
            av_dict_free(&opts);
            throw std::runtime_error("avformat_write_header failed");
        }
        av_dict_free(&opts);
        is_write_frame_ = is_rtp || is_rtsp;
    }

    ~SrtOutput() {
        if (fmt_) {
            av_write_trailer(fmt_);
            avio_closep(&fmt_->pb);
            avformat_free_context(fmt_);
        }
    }

    SrtOutput(const SrtOutput&)            = delete;
    SrtOutput& operator=(const SrtOutput&) = delete;

    // Returns 0 on success, negative AVERROR on failure.
    // Callers should treat any negative return as a signal to reconnect.
    //
    // THREAD SAFETY: write_video and write_audio are called from separate worker
    // threads.  av_interleaved_write_frame (and the underlying AVIOContext write
    // to the SRT socket) are NOT thread-safe — concurrent calls corrupt the
    // muxer's internal packet buffer and can cause indefinite stalls.  write_mutex_
    // serialises all calls so only one thread touches the AVFormatContext at a time.
    int write_video(AVPacket* pkt) {
        std::lock_guard<std::mutex> lock(write_mutex_);
        pkt->stream_index = vstream_->index;
        return is_write_frame_ ? av_write_frame(fmt_, pkt)
                               : av_interleaved_write_frame(fmt_, pkt);
    }

    int write_audio(AVPacket* pkt) {
        if (!astream_) return 0;
        std::lock_guard<std::mutex> lock(write_mutex_);
        pkt->stream_index = astream_->index;
        return is_write_frame_ ? av_write_frame(fmt_, pkt)
                               : av_interleaved_write_frame(fmt_, pkt);
    }

private:
    AVFormatContext* fmt_            = nullptr;
    AVStream*        vstream_        = nullptr;
    AVStream*        astream_        = nullptr;
    bool             is_write_frame_ = false;  // true for RTP/RTSP (non-interleaved)
    std::mutex       write_mutex_; // serialises av_interleaved_write_frame calls
};

} // namespace sdi
