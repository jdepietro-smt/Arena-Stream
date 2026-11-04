#pragma once
//
// TsMuxer — MPEG-TS mux of the encoder's video + audio packets, written through a
// custom AVIO sink so the bytes go to TsFanout instead of a libavformat URL.
// Same latency-relevant settings as SrtOutput (arrival-order writes, per-packet
// PES and I/O flush, no timestamp shifting).

#include "ts_fanout.h"

#include <cstdint>
#include <mutex>
#include <stdexcept>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
}

namespace sdi {

class TsMuxer {
public:
    // actx may be null (video only).
    TsMuxer(TsFanout& out, AVCodecContext* vctx, AVCodecContext* actx = nullptr) : out_(out) {
        if (avformat_alloc_output_context2(&fmt_, nullptr, "mpegts", nullptr) < 0)
            throw std::runtime_error("avformat_alloc_output_context2 failed");

        vstream_ = avformat_new_stream(fmt_, nullptr);
        if (!vstream_) throw std::runtime_error("new video stream failed");
        avcodec_parameters_from_context(vstream_->codecpar, vctx);
        vstream_->time_base = vctx->time_base;
        vtb_ = vctx->time_base;

        if (actx) {
            astream_ = avformat_new_stream(fmt_, nullptr);
            if (!astream_) throw std::runtime_error("new audio stream failed");
            avcodec_parameters_from_context(astream_->codecpar, actx);
            astream_->time_base = actx->time_base;
            atb_ = actx->time_base;
        }

        // 7 TS packets: each flush is at most one SRT message.
        auto* buf = static_cast<uint8_t*>(av_malloc(kBuf));
        if (!buf) throw std::runtime_error("av_malloc failed");
        fmt_->pb = avio_alloc_context(buf, kBuf, 1, this, nullptr, &TsMuxer::write_cb, nullptr);
        if (!fmt_->pb) { av_free(buf); throw std::runtime_error("avio_alloc_context failed"); }
        fmt_->flags |= AVFMT_FLAG_CUSTOM_IO | AVFMT_FLAG_FLUSH_PACKETS;

        // Audio and video share one PTS origin; the muxer must not shift either.
        fmt_->start_time_realtime = AV_NOPTS_VALUE;
        fmt_->avoid_negative_ts   = AVFMT_AVOID_NEG_TS_DISABLED;

        AVDictionary* opts = nullptr;
        av_dict_set(&opts, "pes_payload_size", "0", 0);   // one PES per packet, no accumulation
        const int ret = avformat_write_header(fmt_, &opts);
        av_dict_free(&opts);
        if (ret < 0) throw std::runtime_error("avformat_write_header failed");
        avio_flush(fmt_->pb);
    }

    ~TsMuxer() {
        if (!fmt_) return;
        if (fmt_->pb) {
            av_free(fmt_->pb->buffer);
            avio_context_free(&fmt_->pb);
        }
        avformat_free_context(fmt_);
    }

    TsMuxer(const TsMuxer&)            = delete;
    TsMuxer& operator=(const TsMuxer&) = delete;

    // Video and audio come from different threads; the muxer is not thread-safe.
    int write_video(AVPacket* pkt) { return write(pkt, vstream_, vtb_); }
    int write_audio(AVPacket* pkt) { return astream_ ? write(pkt, astream_, atb_) : 0; }

private:
    static constexpr int kBuf = 7 * 188;

    static int write_cb(void* opaque, const uint8_t* buf, int n) {
        static_cast<TsMuxer*>(opaque)->out_.send(buf, n);
        return n;
    }

    int write(AVPacket* pkt, AVStream* st, AVRational src_tb) {
        std::lock_guard<std::mutex> lk(mtx_);
        pkt->stream_index = st->index;
        av_packet_rescale_ts(pkt, src_tb, st->time_base);   // no-op if the muxer kept our time base
        const int r = av_write_frame(fmt_, pkt);
        // Rescaled in place: undo so the caller's packet is unchanged.
        av_packet_rescale_ts(pkt, st->time_base, src_tb);
        return r;
    }

    TsFanout&        out_;
    AVFormatContext* fmt_     = nullptr;
    AVStream*        vstream_ = nullptr;
    AVStream*        astream_ = nullptr;
    AVRational       vtb_{1, 1}, atb_{1, 1};
    std::mutex       mtx_;
};

} // namespace sdi
