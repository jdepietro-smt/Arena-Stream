#pragma once
//
// Video encoder (Encoder) and audio encoder (AudioEncoder).
//
// Encoder wraps libavcodec for H.264/HEVC via NVENC or x264/x265.
// It internally converts the capture-native pixel format (UYVY422 or V210)
// to NV12 via libswscale, so callers feed raw SDI VideoFrames directly.
//
// AudioEncoder wraps libavcodec for Opus or AAC. It converts the
// capture-native S32 interleaved PCM to whatever sample format the codec
// requires, and accumulates samples into full codec frames internally so
// callers feed raw AudioFrames without worrying about framing boundaries.

#include "frame.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace sdi {

// ---------------------------------------------------------------------------
// VideoEncoder
// ---------------------------------------------------------------------------

struct EncoderConfig {
    std::string codec_name   = "h264_nvenc";  // or "libx264", "hevc_nvenc"
    int         bitrate_kbps = 8000;
    int         gop          = 15;            // IDR every 0.25s at 60fps — fast recovery
    bool        zerolatency  = true;
    // Encoders to try, in order — normally built by codec_policy.h. Empty
    // means "codec_name, then libx264", which is what callers that don't use
    // the policy always got.
    std::vector<std::string> chain;
};

class Encoder {
public:
    Encoder(const VideoMode& mode, const EncoderConfig& cfg) {
        // Walk the candidate chain and keep the first encoder that opens.
        // Any candidate can fail two different ways: avcodec_find_encoder_by_
        // name() returns null (not compiled in), or it's found but
        // avcodec_open2() fails (compiled in, but no working driver or
        // hardware behind it right now). Opening is the only test that
        // proves an encoder works, which is why stream start doesn't probe
        // separately — see codec_policy.h. A chain from the policy always
        // ends in libx264, which needs no driver, so a missing GPU never
        // takes the stream down.
        std::string effective_name;
        const AVCodec* codec = open_with_fallback(mode, cfg, effective_name);
        if (!codec) throw std::runtime_error("no working encoder available (tried " + chain_text(cfg) + ")");
        encoder_name_ = effective_name;

        frame_ = av_frame_alloc();
        pkt_   = av_packet_alloc();
        if (!frame_ || !pkt_) throw std::runtime_error("frame/packet alloc failed");
        frame_->format = ctx_->pix_fmt;
        frame_->width  = ctx_->width;
        frame_->height = ctx_->height;
        if (av_frame_get_buffer(frame_, 32) < 0)
            throw std::runtime_error("av_frame_get_buffer failed");

        // Determine swscale source pixel format from the capture format.
        // AV_PIX_FMT_V210 (10-bit packed 4:2:2) is not available in all FFmpeg
        // builds (notably the Windows vcpkg package omits it). When V210 is
        // requested but unavailable, we treat the buffer as UYVY422 — this
        // reinterprets the bytes and loses 2 bits of precision, but keeps the
        // pipeline compiling. Full V210 support requires an FFmpeg build with
        // V210 encoder/decoder support compiled in.
        AVPixelFormat src_fmt = AV_PIX_FMT_UYVY422;
        if (mode.format == PixelFormat::V210_10) {
#if defined(AV_PIX_FMT_V210)
            src_fmt = AV_PIX_FMT_V210;
#else
            // V210 not in this FFmpeg build — fall back to UYVY422.
            // Capture card should be configured for 8-bit output to avoid
            // colour artifacts.
            src_fmt = AV_PIX_FMT_UYVY422;
#endif
        }
        sws_ = sws_getContext(
            ctx_->width, ctx_->height, src_fmt,
            ctx_->width, ctx_->height, ctx_->pix_fmt,
            SWS_FAST_BILINEAR, nullptr, nullptr, nullptr);
        if (!sws_) throw std::runtime_error("sws_getContext failed");

        // Real motion-adaptive deinterlace (yadif) for interlaced sources
        // (e.g. 1080i from AJA) — replaces a prior fixed spatial blend that
        // discarded every odd row unconditionally, even on fully static
        // content where there's no combing to fix at all (confirmed live:
        // static broadcast graphics looked permanently soft/"shadowy").
        // yadif only touches rows where the two fields actually disagree.
        if (mode.interlaced) init_deinterlace_filter();
    }

    ~Encoder() {
        if (filt_frame_) av_frame_free(&filt_frame_);
        if (filt_graph_) avfilter_graph_free(&filt_graph_);  // frees filt_src_/filt_sink_ too
        sws_freeContext(sws_);
        av_packet_free(&pkt_);
        av_frame_free(&frame_);
        avcodec_free_context(&ctx_);
    }

    Encoder(const Encoder&)            = delete;
    Encoder& operator=(const Encoder&) = delete;

    AVCodecContext* video_ctx() const { return ctx_; }
    // The encoder that actually opened — may differ from what was requested.
    const std::string& name() const { return encoder_name_; }
    int current_bitrate_kbps() const { return int(ctx_->bit_rate / 1000); }

    // Change the encoder's target bitrate mid-stream, for adaptive bitrate
    // under changing network conditions. No encoder recreation needed:
    // both ffmpeg's nvenc and libx264 wrappers re-read avctx->bit_rate (and
    // rc_max_rate) on the next avcodec_send_frame and apply it via their own
    // reconfigure path — nvenc's per-frame rate-control update for NVENC,
    // x264_encoder_reconfig() for libx264. rc_buffer_size is recomputed the
    // same way the constructor derives it, so the one-frame VBV constraint
    // (see the constructor's comment on burst size vs. receiver buffers)
    // stays correct at the new bitrate instead of clamping to the original.
    void set_bitrate(int new_kbps) {
        ctx_->bit_rate    = int64_t(new_kbps) * 1000;
        ctx_->rc_max_rate = ctx_->bit_rate;
        const int fps = std::max(1,
            int(ctx_->framerate.num) / std::max(1, int(ctx_->framerate.den)));
        ctx_->rc_buffer_size = int(ctx_->bit_rate / std::max(fps, 30));
    }

    // Submit black NV12 frames with negative PTS to warm up the GPU encoder
    // pipeline before real capture begins.  Without this, NVENC takes several
    // seconds before it starts producing output packets; during that window audio
    // accumulates and then arrives out of sync with video.  After prewarm the
    // first real captured frame (pts=0) produces an output packet immediately.
    // Uses PTS -num_frames … -1 so the real stream can start cleanly at pts=0.
    void prewarm(int num_frames = 60) {
        av_frame_make_writable(frame_);
        // Black in NV12: Y-plane = 16, UV-plane = 128
        for (int y = 0; y < ctx_->height; ++y)
            std::memset(frame_->data[0] + (size_t)y * frame_->linesize[0], 16, ctx_->width);
        for (int y = 0; y < ctx_->height / 2; ++y)
            std::memset(frame_->data[1] + (size_t)y * frame_->linesize[1], 128, ctx_->width);
        int first_output = -1;
        for (int i = num_frames; i > 0; --i) {
            frame_->pts = -(int64_t)i;
            avcodec_send_frame(ctx_, frame_);
            while (avcodec_receive_packet(ctx_, pkt_) == 0) {
                if (first_output < 0) first_output = num_frames - i;
                av_packet_unref(pkt_);
            }
        }
        std::cerr << "encoder: prewarm done"
                  << (first_output >= 0
                      ? " (first output at frame " + std::to_string(first_output) + ")"
                      : " (no output — encoder may still be initialising)")
                  << "\n";
    }

    template <typename EmitFn>
    void encode(const VideoFrame& in, EmitFn&& emit) {
        av_frame_make_writable(frame_);

        const uint8_t* src[4]     = { in.data.data(), nullptr, nullptr, nullptr };
        const int      strides[4] = { int(in.stride), 0, 0, 0 };
        sws_scale(sws_, src, strides, 0, ctx_->height,
                  frame_->data, frame_->linesize);

        frame_->pts = av_rescale_q(
            in.pts.count(),
            AVRational{1, 1'000'000'000},
            ctx_->time_base);

        if (!logged_first_) {
            logged_first_ = true;
            std::cerr << "diag: video encoder first frame, in_pts_ns="
                      << in.pts.count() << " frame_pts_ticks=" << frame_->pts << "\n";
        }

        AVFrame* out_frame = frame_;
        if (in.mode.interlaced) {
            // mode=0 (send_frame) yields exactly one deinterlaced frame per
            // input frame — frame rate is unchanged, unlike send_field (which
            // would double it). KEEP_REF leaves frame_ valid for reuse next
            // call instead of buffersrc taking ownership of it.
            if (av_buffersrc_add_frame_flags(filt_src_, frame_, AV_BUFFERSRC_FLAG_KEEP_REF) < 0)
                return;
            av_frame_unref(filt_frame_);
            if (av_buffersink_get_frame(filt_sink_, filt_frame_) < 0)
                return;
            out_frame = filt_frame_;
        }

        if (avcodec_send_frame(ctx_, out_frame) < 0) {
            if (out_frame == filt_frame_) av_frame_unref(filt_frame_);
            return;
        }
        while (avcodec_receive_packet(ctx_, pkt_) == 0) {
            emit(pkt_);
            av_packet_unref(pkt_);
        }
        if (out_frame == filt_frame_) av_frame_unref(filt_frame_);
    }

private:
    // The candidates to try: the configured chain, or (for callers that
    // don't use the policy) codec_name followed by libx264.
    static std::vector<std::string> chain_of(const EncoderConfig& cfg) {
        if (!cfg.chain.empty()) return cfg.chain;
        if (cfg.codec_name == "libx264") return { "libx264" };
        return { cfg.codec_name, "libx264" };
    }

    static std::string chain_text(const EncoderConfig& cfg) {
        std::string s;
        for (const auto& n : chain_of(cfg)) s += (s.empty() ? "" : ", ") + n;
        return s;
    }

    // Opens ctx_ with the first encoder in the chain that works. Each failed
    // candidate (not found, or avcodec_open2 rejects it) is torn down by
    // try_open and logged, then the next is tried. `effective_name` is set to
    // whichever encoder actually opened. Returns nullptr only if every
    // candidate failed — for a chain ending in libx264 that means a broken
    // FFmpeg build, not a missing GPU.
    const AVCodec* open_with_fallback(const VideoMode& mode, const EncoderConfig& cfg,
                                       std::string& effective_name) {
        const auto chain = chain_of(cfg);
        for (size_t i = 0; i < chain.size(); ++i) {
            const std::string& name = chain[i];
            const AVCodec* codec = avcodec_find_encoder_by_name(name.c_str());
            if (codec && try_open(mode, cfg, codec, name)) {
                effective_name = name;
                if (i > 0)
                    std::cerr << "encoder: using " << name << " (first choice "
                              << chain[0] << " was not usable)\n";
                return codec;
            }
            std::cerr << "encoder: " << name
                      << (codec ? " found but failed to open (driver/hardware not present?)"
                                : " not available");
            if (i + 1 < chain.size()) std::cerr << ", trying " << chain[i + 1] << "\n";
            else                      std::cerr << " — no candidates left\n";
        }
        return nullptr;
    }

    // Allocates ctx_ and configures it for `codec`/`name`, then opens it.
    // On failure, tears ctx_ back down to nullptr so the caller can retry
    // cleanly with a different codec.
    bool try_open(const VideoMode& mode, const EncoderConfig& cfg,
                  const AVCodec* codec, const std::string& name) {
        ctx_ = avcodec_alloc_context3(codec);
        if (!ctx_) throw std::runtime_error("avcodec_alloc_context3 failed");

        ctx_->width          = int(mode.width);
        ctx_->height         = int(mode.height);
        // Progressive sources go straight from sws_scale to the encoder,
        // where NV12 is well-proven (NVENC's native format, no issues seen
        // across months of progressive streams). Interlaced sources instead
        // route through the yadif deinterlace filter graph below, and in
        // this FFmpeg build yadif doesn't accept NV12 — the graph silently
        // auto-inserts a conversion to YUV420P (the pix_fmts restriction
        // meant to prevent that fails to apply; see init_deinterlace_filter).
        // Declaring NV12 here while the graph actually hands back YUV420P
        // produced a real, confirmed-live bug: libavcodec's own plane-size
        // check compared width (1920) against YUV420P's half-width chroma
        // stride (960) as if it were NV12's full-width one ("Input picture
        // width (1920) is greater than stride (960)"), corrupting every
        // frame — the NHL Network (1920x1080i) stream played back as solid
        // black because of exactly this. Matching what the filter graph
        // actually produces removes the mismatch instead of fighting it.
        ctx_->pix_fmt        = mode.interlaced ? AV_PIX_FMT_YUV420P : AV_PIX_FMT_NV12;
        // A time_base with one tick per frame period (fps_den/fps_num) leaves
        // zero rounding headroom: av_rescale_q from the capture's nanosecond
        // PTS collapses onto the same integer tick whenever two frames' real
        // capture timestamps are closer together than one full frame period —
        // which happens routinely with hardware capture jitter — producing
        // duplicate PTS/DTS that the muxer then rejects outright. A
        // microsecond time_base gives ~16,683 distinct ticks per frame at
        // 59.94fps, far more than any real jitter can collide on, while
        // `framerate` (used for encoder rate control) stays frame-accurate.
        ctx_->time_base      = AVRational{1, 1'000'000};
        ctx_->framerate      = AVRational{int(mode.fps_num), int(mode.fps_den)};
        ctx_->bit_rate       = int64_t(cfg.bitrate_kbps) * 1000;
        ctx_->rc_max_rate    = ctx_->bit_rate;
        // One-frame VBV: constrains the encoder to no more than one frame's
        // worth of bits per burst.  With intra-refresh there are no IDR spikes,
        // so this is achievable at any bitrate.  Critically, this keeps the UDP
        // burst per frame ≤ ~21 KB at 10 Mbps / 60 fps — well inside the OS
        // default socket receive buffer (64–256 KB) at all supported bitrates.
        // Previous value was bit_rate/8 (1/8 s), which grew to 156 KB at 10 Mbps
        // and overflowed the receiver buffer, causing breakups above 5 Mbps.
        {
            const int fps = std::max(1,
                int(mode.fps_num) / std::max(1, int(mode.fps_den)));
            ctx_->rc_buffer_size = ctx_->bit_rate / std::max(fps, 30);
        }
        ctx_->gop_size       = cfg.gop;
        ctx_->max_b_frames   = 0;               // required for low latency

        // Tag every encoded stream as BT.709 explicitly, regardless of
        // resolution. Without this, encoders leave colorspace/primaries/trc
        // as "unspecified" in the bitstream, and downstream tools (e.g. a
        // relay's own re-transcode) are left to guess — usually by
        // resolution, which is exactly wrong the moment two different
        // formats are live at once (confirmed live: an SD-tuned downstream
        // default applied to an HD 1080i source produced visibly wrong
        // colors after that stream's re-encode, while lower-resolution
        // streams the guess happened to match looked fine). SDI sources
        // here are always HD or effectively HD-graded, so BT.709 is correct
        // universally — no per-resolution branching needed. Limited
        // (studio/broadcast) range, matching SDI's native signal levels.
        ctx_->colorspace     = AVCOL_SPC_BT709;
        ctx_->color_primaries= AVCOL_PRI_BT709;
        ctx_->color_trc      = AVCOL_TRC_BT709;
        ctx_->color_range    = AVCOL_RANGE_MPEG;

        // Hardware-vendor low-latency CBR knobs. Each block only applies its
        // own option names, which is safe because avcodec_alloc_context3
        // already gave us the AVCodec-specific priv_data for `codec` — an
        // AMF option set on an NVENC context (etc.) simply wouldn't exist to
        // set. Unrecognized-name failures from av_opt_set are intentionally
        // ignored here (best-effort tuning, not correctness-critical); a
        // wrong option value would surface as avcodec_open2 failing below,
        // which is already handled by the fallback in open_with_fallback.
        if (name == "h264_nvenc" || name == "hevc_nvenc" || name == "av1_nvenc") {
            av_opt_set(ctx_->priv_data, "preset",         "p3",  0);
            av_opt_set(ctx_->priv_data, "tune",           "ll",  0);
            av_opt_set(ctx_->priv_data, "rc",             "cbr", 0);
            av_opt_set(ctx_->priv_data, "zerolatency",    "1",   0);
            av_opt_set_int(ctx_->priv_data, "delay",      0,     0);
            // SPS/PPS on every IDR — mid-stream join / packet-loss recovery.
            av_opt_set_int(ctx_->priv_data, "repeat_headers", 1, 0);
            // Dynamic slice count: target one slice per RTP packet (1300 B).
            // Fixed at 8 previously — fine at 5 Mbps but at 10+ Mbps each slice
            // grew beyond one MTU, causing multi-packet bursts that overflowed
            // the receiver UDP buffer.  Now slices = bytes_per_frame / 1300,
            // so each slice always fits in one UDP packet at any bitrate.
            {
                const int fps = std::max(1,
                    int(mode.fps_num) / std::max(1, int(mode.fps_den)));
                const int bytes_per_frame =
                    int(int64_t(cfg.bitrate_kbps) * 1000 / 8 / std::max(fps, 1));
                const int n_slices = std::max(4, bytes_per_frame / 1300);
                av_opt_set_int(ctx_->priv_data, "slices", n_slices, 0);
            }
        } else if (name == "h264_qsv" || name == "hevc_qsv" || name == "av1_qsv") {
            av_opt_set(ctx_->priv_data, "preset",      "veryfast", 0);
            av_opt_set(ctx_->priv_data, "low_delay_brc", "1",      0);
            av_opt_set_int(ctx_->priv_data, "look_ahead", 0,       0);
        } else if (name == "h264_amf" || name == "hevc_amf" || name == "av1_amf") {
            av_opt_set(ctx_->priv_data, "usage",       "ultralowlatency", 0);
            av_opt_set(ctx_->priv_data, "rc",          "cbr",             0);
            av_opt_set_int(ctx_->priv_data, "quality", 0 /* speed */,     0);
        } else if (name == "h264_mf" || name == "hevc_mf") {
            av_opt_set_int(ctx_->priv_data, "rate_control", 1 /* CBR */, 0);
            av_opt_set_int(ctx_->priv_data, "low_latency",  1,           0);
        } else if (name == "libx264") {
            av_opt_set(ctx_->priv_data, "preset",    "veryfast",    0);
            av_opt_set(ctx_->priv_data, "tune",      "zerolatency", 0);
            // repeat-headers=1 — SPS/PPS before every IDR so mediamtx and other
            // relay servers can begin forwarding to new readers at keyframe boundaries.
            // intra-refresh intentionally absent: cyclic intra-refresh produces no
            // IDR frames, which prevents mediamtx from serving new readers.
            // slice-max-size intentionally absent: MTU-sized slices create 40+ NALUs
            // per frame; mediamtx v1.9.x hard-caps at 25 and drops every frame.
            // SRT handles its own MTU fragmentation — encoder-level slicing is unnecessary.
            av_opt_set(ctx_->priv_data, "x264-params",
                       "nal-hrd=cbr:force-cfr=1:sync-lookahead=0"
                       ":repeat-headers=1", 0);
        } else if (name == "libx265") {
            av_opt_set(ctx_->priv_data, "preset", "veryfast", 0);
            av_opt_set(ctx_->priv_data, "x265-params",
                       "repeat-headers=1:no-info=1", 0);
        }

        if (avcodec_open2(ctx_, codec, nullptr) < 0) {
            avcodec_free_context(&ctx_);  // sets ctx_ back to nullptr
            return false;
        }
        return true;
    }

    void init_deinterlace_filter() {
        filt_graph_ = avfilter_graph_alloc();
        if (!filt_graph_) throw std::runtime_error("avfilter_graph_alloc failed");

        char args[512];
        std::snprintf(args, sizeof(args),
            "video_size=%dx%d:pix_fmt=%d:time_base=%d/%d:pixel_aspect=1/1",
            ctx_->width, ctx_->height, int(ctx_->pix_fmt),
            ctx_->time_base.num, ctx_->time_base.den);

        const AVFilter* buffersrc  = avfilter_get_by_name("buffer");
        const AVFilter* buffersink = avfilter_get_by_name("buffersink");
        if (!buffersrc || !buffersink)
            throw std::runtime_error("buffer/buffersink filters unavailable — libavfilter missing?");

        if (avfilter_graph_create_filter(&filt_src_, buffersrc, "in", args, nullptr, filt_graph_) < 0)
            throw std::runtime_error("failed to create buffer source filter");
        if (avfilter_graph_create_filter(&filt_sink_, buffersink, "out", nullptr, nullptr, filt_graph_) < 0)
            throw std::runtime_error("failed to create buffer sink filter");

        // Best-effort only — NOT fatal. On this FFmpeg build, buffersink is
        // already initialized by the time avfilter_graph_create_filter()
        // returns (no init args needed, unlike buffersrc), so this always
        // fails with EINVAL ("pix_fmts is not a runtime option..."). This
        // used to throw on that failure, which is why EVERY interlaced
        // capture crashed the whole process on startup, unconditionally —
        // confirmed live: this line is exactly where a real AJA 1080i input
        // died every single time, regardless of video codec or whether
        // audio encoding was also active (both looked like plausible
        // culprits before this was actually instrumented and isolated).
        // NOT actually harmless to skip, despite what this used to assume:
        // on this FFmpeg build, yadif doesn't accept NV12 at all, so when
        // buffersrc declared NV12 (this filter graph's old default), the
        // graph silently auto-inserted a conversion to YUV420P — a real,
        // confirmed-live mismatch against the encoder, which still expected
        // NV12; see the comment on ctx_->pix_fmt above for what that broke.
        // ctx_->pix_fmt is YUV420P here now (this function only runs when
        // mode.interlaced is true), matching what yadif actually processes
        // in this build, so buffersrc's declared format and yadif's native
        // format already agree — this restriction call failing is genuinely
        // harmless now, since there's nothing left for it to need to force.
        const enum AVPixelFormat pix_fmts[] = { ctx_->pix_fmt, AV_PIX_FMT_NONE };
        av_opt_set_int_list(filt_sink_, "pix_fmts", pix_fmts, AV_PIX_FMT_NONE, AV_OPT_SEARCH_CHILDREN);

        AVFilterInOut* outputs = avfilter_inout_alloc();
        AVFilterInOut* inputs  = avfilter_inout_alloc();
        if (!outputs || !inputs) throw std::runtime_error("avfilter_inout_alloc failed");
        outputs->name       = av_strdup("in");
        outputs->filter_ctx = filt_src_;
        outputs->pad_idx    = 0;
        outputs->next       = nullptr;
        inputs->name        = av_strdup("out");
        inputs->filter_ctx  = filt_sink_;
        inputs->pad_idx     = 0;
        inputs->next        = nullptr;

        // parity=-1: auto-detect field order per frame instead of assuming a
        // fixed one — the old blend always treated odd rows as "wrong"
        // regardless of actual field dominance, which would smear the wrong
        // field on sources where that assumption didn't hold.
        const char* filter_descr = "yadif=mode=0:parity=-1:deint=0";
        int ret = avfilter_graph_parse_ptr(filt_graph_, filter_descr, &inputs, &outputs, nullptr);
        avfilter_inout_free(&inputs);
        avfilter_inout_free(&outputs);
        if (ret < 0) throw std::runtime_error("avfilter_graph_parse_ptr failed for yadif");

        if (avfilter_graph_config(filt_graph_, nullptr) < 0)
            throw std::runtime_error("avfilter_graph_config failed");

        filt_frame_ = av_frame_alloc();
        if (!filt_frame_) throw std::runtime_error("av_frame_alloc (filt_frame_) failed");
    }

    std::string      encoder_name_;
    AVCodecContext*  ctx_        = nullptr;
    AVFrame*         frame_      = nullptr;
    AVPacket*        pkt_        = nullptr;
    SwsContext*      sws_        = nullptr;
    bool             logged_first_ = false;
    AVFilterGraph*   filt_graph_ = nullptr;
    AVFilterContext* filt_src_   = nullptr;
    AVFilterContext* filt_sink_  = nullptr;
    AVFrame*         filt_frame_ = nullptr;
};

// ---------------------------------------------------------------------------
// AudioEncoder
// ---------------------------------------------------------------------------

struct AudioEncoderConfig {
    std::string codec_name   = "libopus";  // or "aac"
    int         bitrate_kbps = 192;
};

class AudioEncoder {
public:
    AudioEncoder(int channels, int sample_rate, const AudioEncoderConfig& cfg)
        : channels_(channels) {
        const AVCodec* codec = avcodec_find_encoder_by_name(cfg.codec_name.c_str());
        if (!codec) throw std::runtime_error("audio encoder not found: " + cfg.codec_name);

        ctx_ = avcodec_alloc_context3(codec);
        if (!ctx_) throw std::runtime_error("avcodec_alloc_context3 (audio) failed");

        ctx_->sample_rate = sample_rate;
        av_channel_layout_default(&ctx_->ch_layout, channels);
        ctx_->bit_rate    = int64_t(cfg.bitrate_kbps) * 1000;
        ctx_->sample_fmt     = codec->sample_fmts ? codec->sample_fmts[0]
                                                  : AV_SAMPLE_FMT_FLTP;
        ctx_->time_base      = AVRational{1, sample_rate};

        if (avcodec_open2(ctx_, codec, nullptr) < 0)
            throw std::runtime_error("avcodec_open2 (audio) failed");

        // Use the codec's required frame size; fall back to 1024 for
        // variable-frame-size codecs (PCM encoders return 0).
        frame_size_ = ctx_->frame_size > 0 ? ctx_->frame_size : 1024;

        // Resampler: S32 interleaved (capture native) → codec sample format.
        // FFmpeg 6.0+ uses AVChannelLayout API; old channels/channel_layout
        // fields and av_get_default_channel_layout() were removed in FFmpeg 8.
        swr_ = swr_alloc();
        av_opt_set_chlayout(swr_, "in_chlayout",  &ctx_->ch_layout, 0);
        av_opt_set_chlayout(swr_, "out_chlayout", &ctx_->ch_layout, 0);
        av_opt_set_int(swr_, "in_sample_rate",  sample_rate, 0);
        av_opt_set_int(swr_, "out_sample_rate", sample_rate, 0);
        av_opt_set_sample_fmt(swr_, "in_sample_fmt",  AV_SAMPLE_FMT_S32,   0);
        av_opt_set_sample_fmt(swr_, "out_sample_fmt", ctx_->sample_fmt,     0);
        if (swr_init(swr_) < 0) throw std::runtime_error("swr_init failed");

        frame_ = av_frame_alloc();
        frame_->format      = ctx_->sample_fmt;
        frame_->sample_rate = sample_rate;
        av_channel_layout_copy(&frame_->ch_layout, &ctx_->ch_layout);
        frame_->nb_samples     = frame_size_;
        if (av_frame_get_buffer(frame_, 0) < 0)
            throw std::runtime_error("av_frame_get_buffer (audio) failed");

        pkt_ = av_packet_alloc();
    }

    ~AudioEncoder() {
        // Flush encoder.
        avcodec_send_frame(ctx_, nullptr);
        av_packet_free(&pkt_);
        av_frame_free(&frame_);
        swr_free(&swr_);
        avcodec_free_context(&ctx_);
    }

    AudioEncoder(const AudioEncoder&)            = delete;
    AudioEncoder& operator=(const AudioEncoder&) = delete;

    AVCodecContext* audio_ctx() const { return ctx_; }


    // Accepts any number of samples per call; buffers internally until a full
    // codec frame is available, then encodes and emits.
    template <typename EmitFn>
    void encode(const AudioFrame& in, EmitFn&& emit) {
        // On the first call, initialize pts_ from the capture frame's wall-clock PTS
        // (nanoseconds from steady_clock). This aligns audio to the same reference
        // clock as the video encoder, eliminating the NVENC warm-up offset.
        const int64_t wall_clock_pts = av_rescale_q(in.pts.count(),
                                                     AVRational{1, 1'000'000'000},
                                                     ctx_->time_base);
        int64_t per_frame_correction = 0;

        if (!pts_initialized_) {
            pts_ = wall_clock_pts;
            pts_initialized_ = true;
            std::cerr << "diag: audio encoder first frame, in_pts_ns="
                      << in.pts.count() << " pts_ticks=" << pts_ << "\n";
        } else {
            // pts_ normally free-runs by exactly frame_size_ per emitted frame,
            // which assumes the capture hardware delivers audio at exactly the
            // declared sample rate. Real hardware clocks never match the host's
            // steady_clock exactly (even a few PPM of difference), so a pure
            // sample-counted pts_ slowly drifts from true wall-clock time at a
            // roughly CONSTANT RATE. A one-shot correction (jump pts_ forward
            // once it's fallen a full frame behind) bounds the error but does
            // nothing about that steady-state rate mismatch — audio keeps
            // drifting at the same rate right after each jump. WebRTC treats
            // audio as the sync master, so the receiver compensates by
            // continuously growing VIDEO's jitter buffer to keep pace with
            // audio's effectively-slow clock — exactly the "latency creeps up
            // over the whole stream" symptom seen in testing.
            //
            // Fix the RATE, not just the position: apply a small continuous
            // correction every frame, proportional to the current drift, so
            // pts_ converges toward wall-clock time smoothly (like a simple
            // PLL) instead of needing periodic jumps. drift_correction_accum_
            // carries the fractional part across calls so small errors (a
            // fraction of a sample per frame) aren't lost to truncation —
            // they build up until they cross a whole sample and get applied.
            const int64_t error = wall_clock_pts - pts_;

            // A large error (many frames' worth) means a genuine discontinuity
            // — a reconnect or startup gap — not steady clock drift. The slow
            // proportional correction below would take far too long to
            // recover from that, so jump directly (forward only: pts_/dts
            // must stay strictly increasing, and jumping backward when pts_
            // is briefly ahead of wall-clock from normal jitter breaks that).
            constexpr int64_t kDiscontinuityThreshold = 10; // frames
            if (error > frame_size_ * kDiscontinuityThreshold) {
                pts_ = wall_clock_pts;
                drift_correction_accum_ = 0.0;
            } else {
                constexpr double kDriftCorrectionGain = 0.002;
                drift_correction_accum_ += double(error) * kDriftCorrectionGain;
                per_frame_correction = int64_t(drift_correction_accum_);
                drift_correction_accum_ -= double(per_frame_correction);
                // Keep frame_size_ + per_frame_correction safely positive so
                // pts_ can never go backward or stall even under a large
                // sustained correction.
                const int64_t min_correction = -(frame_size_ / 2);
                const int64_t max_correction = frame_size_ / 2;
                if (per_frame_correction < min_correction) per_frame_correction = min_correction;
                if (per_frame_correction > max_correction) per_frame_correction = max_correction;
            }
        }
        pending_.insert(pending_.end(), in.samples.begin(), in.samples.end());

        while (int(pending_.size()) >= frame_size_ * channels_) {
            av_frame_make_writable(frame_);

            const uint8_t* src = reinterpret_cast<const uint8_t*>(pending_.data());
            swr_convert(swr_,
                        frame_->data, frame_size_,
                        &src,         frame_size_);

            pending_.erase(pending_.begin(),
                           pending_.begin() + frame_size_ * channels_);

            frame_->pts = pts_;
            pts_ += frame_size_ + per_frame_correction;

            if (avcodec_send_frame(ctx_, frame_) < 0) continue;
            while (avcodec_receive_packet(ctx_, pkt_) == 0) {
                emit(pkt_);
                av_packet_unref(pkt_);
            }
        }
    }

private:
    AVCodecContext*      ctx_        = nullptr;
    AVFrame*             frame_      = nullptr;
    AVPacket*            pkt_        = nullptr;
    SwrContext*          swr_        = nullptr;
    int                  frame_size_ = 1024;
    int                  channels_   = 2;
    int64_t              pts_           = 0;
    bool                 pts_initialized_ = false;
    double               drift_correction_accum_ = 0.0;
    std::vector<int32_t> pending_;   // interleaved S32 samples waiting for a full frame
};

} // namespace sdi
