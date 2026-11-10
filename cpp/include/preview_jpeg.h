// JPEG snapshots of the captured picture for the app's encoder monitor.
// Kept cheap: downscaled to <= 960 px wide, ~10 snapshots a second, and made on the
// video worker thread after the frame has been handed to the real encoder, so it cannot
// delay the stream.
#pragma once
#include "frame.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

#include <string>

namespace sdi {

class PreviewJpeg {
public:
    PreviewJpeg() = default;
    PreviewJpeg(const PreviewJpeg&) = delete;
    PreviewJpeg& operator=(const PreviewJpeg&) = delete;
    ~PreviewJpeg() { release(); }

    // Returns the JPEG as base64 text, or "" if this frame can't be previewed.
    // field = 0 (top) or 1 (bottom): preview just that field of an interlaced frame, at the frame's
    // picture size; -1 = the whole frame.
    std::string make(const VideoFrame& f, int max_width = 960, int field = -1) {
        AVPixelFormat src = AV_PIX_FMT_NONE;
        if (f.mode.format == PixelFormat::UYVY422_8) src = AV_PIX_FMT_UYVY422;
#if defined(AV_PIX_FMT_V210)
        else if (f.mode.format == PixelFormat::V210_10) src = AV_PIX_FMT_V210;
#endif
        else if (f.mode.format == PixelFormat::NV12_8) src = AV_PIX_FMT_NV12;
        else if (f.mode.format == PixelFormat::I420_8) src = AV_PIX_FMT_YUV420P;
        if (src == AV_PIX_FMT_NONE || f.mode.width < 16 || f.mode.height < 16 || f.data.empty()) return {};

        const bool by_field = field >= 0;
        if (!ctx_ || src != src_fmt_ || int(f.mode.width) != src_w_ || int(f.mode.height) != src_h_ || by_field != by_field_)
            if (!open(src, int(f.mode.width), int(f.mode.height), max_width, by_field)) return {};

        const uint8_t* planes[4] = { f.data.data(), nullptr, nullptr, nullptr };
        int strides[4] = { int(f.stride), 0, 0, 0 };
        if (src == AV_PIX_FMT_NV12) {
            planes[1] = f.data.data() + f.stride * f.mode.height; strides[1] = int(f.stride);
        } else if (src == AV_PIX_FMT_YUV420P) {
            planes[1] = f.data.data() + f.stride * f.mode.height;
            planes[2] = planes[1] + (f.stride / 2) * (f.mode.height / 2);
            strides[1] = strides[2] = int(f.stride / 2);
        }
        if (av_frame_make_writable(frame_) < 0) return {};
        int rows = src_h_;
        if (by_field) {   // every second line, starting at the wanted field
            for (int i = 0; i < 3; ++i) if (planes[i]) { planes[i] += size_t(field) * size_t(strides[i]); strides[i] *= 2; }
            rows = src_h_ / 2;
        }
        sws_scale(sws_, planes, strides, 0, rows, frame_->data, frame_->linesize);
        if (field == 1) {   // the bottom field sits half a line lower: shift it up to the top field's grid so detail does not bounce
            for (int i = 0; i < 3; ++i) {
                const int ph = i == 0 ? h_ : h_ / 2, pw = i == 0 ? w_ : w_ / 2;
                for (int y = ph - 1; y >= 1; --y) {
                    uint8_t* r = frame_->data[i] + size_t(y) * frame_->linesize[i];
                    const uint8_t* q = r - frame_->linesize[i];
                    for (int x = 0; x < pw; ++x) r[x] = uint8_t((r[x] + q[x] + 1) >> 1);
                }
            }
        }

        std::string out;
        if (avcodec_send_frame(ctx_, frame_) < 0) return {};
        if (avcodec_receive_packet(ctx_, pkt_) == 0) {
            out = base64(pkt_->data, size_t(pkt_->size));
            av_packet_unref(pkt_);
        }
        return out;
    }

    int width()  const { return w_; }
    int height() const { return h_; }

private:
    bool open(AVPixelFormat src, int sw, int sh, int max_width, bool by_field) {
        release();
        w_ = sw < max_width ? sw & ~1 : max_width;
        h_ = int((int64_t(sh) * w_ / sw)) & ~1;
        const AVCodec* c = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
        if (!c) return false;
        ctx_ = avcodec_alloc_context3(c);
        ctx_->width = w_; ctx_->height = h_;
        ctx_->pix_fmt = AV_PIX_FMT_YUVJ420P;
        ctx_->time_base = AVRational{1, 25};
        ctx_->flags |= AV_CODEC_FLAG_QSCALE;
        ctx_->global_quality = FF_QP2LAMBDA * 5;     // high quality: this is what the operator judges the picture by
        if (avcodec_open2(ctx_, c, nullptr) < 0) { release(); return false; }
        sws_ = sws_getContext(sw, by_field ? sh / 2 : sh, src, w_, h_, AV_PIX_FMT_YUVJ420P, SWS_BICUBIC, nullptr, nullptr, nullptr);
        frame_ = av_frame_alloc();
        frame_->format = AV_PIX_FMT_YUVJ420P; frame_->width = w_; frame_->height = h_;
        pkt_ = av_packet_alloc();
        if (!sws_ || av_frame_get_buffer(frame_, 0) < 0) { release(); return false; }
        src_fmt_ = src; src_w_ = sw; src_h_ = sh; by_field_ = by_field;
        return true;
    }

    void release() {
        if (sws_)   { sws_freeContext(sws_); sws_ = nullptr; }
        if (frame_) av_frame_free(&frame_);
        if (pkt_)   av_packet_free(&pkt_);
        if (ctx_)   avcodec_free_context(&ctx_);
        src_fmt_ = AV_PIX_FMT_NONE; src_w_ = src_h_ = 0;
    }

    static std::string base64(const uint8_t* d, size_t n) {
        static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string s; s.reserve((n + 2) / 3 * 4);
        for (size_t i = 0; i < n; i += 3) {
            const uint32_t v = (uint32_t(d[i]) << 16) | (i + 1 < n ? uint32_t(d[i + 1]) << 8 : 0) | (i + 2 < n ? d[i + 2] : 0);
            s += t[(v >> 18) & 63]; s += t[(v >> 12) & 63];
            s += i + 1 < n ? t[(v >> 6) & 63] : '=';
            s += i + 2 < n ? t[v & 63] : '=';
        }
        return s;
    }

    AVCodecContext* ctx_   = nullptr;
    SwsContext*     sws_   = nullptr;
    bool            by_field_ = false;
    AVFrame*        frame_ = nullptr;
    AVPacket*       pkt_   = nullptr;
    AVPixelFormat   src_fmt_ = AV_PIX_FMT_NONE;
    int src_w_ = 0, src_h_ = 0, w_ = 0, h_ = 0;
};

}  // namespace sdi
