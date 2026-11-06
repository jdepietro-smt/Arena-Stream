#pragma once
//
// Quality test: measure what an encoder setting really costs and buys.
//
// A short clip of live input is encoded with each (quality profile x bitrate), the
// result decoded again, and every decoded picture compared with the exact picture the
// encoder was given (tapped inside Encoder, after scaling/deinterlacing). That isolates
// the codec's loss from everything upstream. Reported per run:
//   psnr / ssim      mean luma PSNR (dB) and SSIM over all frames (SSIM 1.0 = identical)
//   ssim_min         the worst single frame — pans and crowd shots show up here
//   psnr_c           mean chroma PSNR (colour smearing)
//   enc_ms / dec_ms  mean per-frame time inside the encoder / software decoder
//   kbps, max_kb     real average bitrate and largest single frame
// SSIM uses 8x8 luma windows offset by 4 so they straddle codec block edges.

#include "encoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
}

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace sdi::qtest {

struct Planes {
    int w = 0, h = 0;
    std::vector<uint8_t> y, u, v;   // planar 4:2:0
};

// Copy an NV12 or YUV420P AVFrame into packed planar buffers.
inline bool grab(const AVFrame* f, Planes& p) {
    if (f->format != AV_PIX_FMT_NV12 && f->format != AV_PIX_FMT_YUV420P) return false;
    p.w = f->width; p.h = f->height;
    const int cw = p.w / 2, ch = p.h / 2;
    p.y.resize(size_t(p.w) * p.h);
    p.u.resize(size_t(cw) * ch);
    p.v.resize(size_t(cw) * ch);
    for (int r = 0; r < p.h; ++r) std::memcpy(&p.y[size_t(r) * p.w], f->data[0] + size_t(r) * f->linesize[0], p.w);
    for (int r = 0; r < ch; ++r) {
        if (f->format == AV_PIX_FMT_NV12) {
            const uint8_t* uv = f->data[1] + size_t(r) * f->linesize[1];
            for (int c = 0; c < cw; ++c) { p.u[size_t(r) * cw + c] = uv[2 * c]; p.v[size_t(r) * cw + c] = uv[2 * c + 1]; }
        } else {
            std::memcpy(&p.u[size_t(r) * cw], f->data[1] + size_t(r) * f->linesize[1], cw);
            std::memcpy(&p.v[size_t(r) * cw], f->data[2] + size_t(r) * f->linesize[2], cw);
        }
    }
    return true;
}

inline double mse(const uint8_t* a, const uint8_t* b, size_t n) {
    double s = 0;
    for (size_t i = 0; i < n; ++i) { const double d = double(a[i]) - double(b[i]); s += d * d; }
    return s / double(n ? n : 1);
}
inline double psnr_from_mse(double m) { return m <= 1e-9 ? 99.0 : std::min(99.0, 10.0 * std::log10(255.0 * 255.0 / m)); }

inline double ssim_luma(const uint8_t* a, const uint8_t* b, int w, int h) {
    const double c1 = (0.01 * 255) * (0.01 * 255), c2 = (0.03 * 255) * (0.03 * 255);
    double total = 0; long cnt = 0;
    for (int y = 4; y + 8 <= h; y += 8) {
        for (int x = 4; x + 8 <= w; x += 8) {
            double sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
            for (int j = 0; j < 8; ++j) {
                const uint8_t* pa = a + size_t(y + j) * w + x;
                const uint8_t* pb = b + size_t(y + j) * w + x;
                for (int i = 0; i < 8; ++i) {
                    const double va = pa[i], vb = pb[i];
                    sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
                }
            }
            const double ma = sa / 64, mb = sb / 64;
            const double va = saa / 64 - ma * ma, vb = sbb / 64 - mb * mb, cov = sab / 64 - ma * mb;
            total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
            ++cnt;
        }
    }
    return cnt ? total / double(cnt) : 1.0;
}

struct Result {
    std::string quality, encoder;
    int    target_kbps = 0, frames = 0;
    double psnr = 0, ssim = 0, ssim_min = 1, psnr_c = 0;
    double kbps = 0, max_kb = 0, enc_ms = 0, enc_ms_p95 = 0, dec_ms = 0;
    bool   ok = false;
};

// Encode `clip` with one setting, decode, and score. Returns false if the encoder won't open.
inline bool run_one(const std::vector<VideoFrame>& clip, const VideoMode& mode,
                    const std::vector<std::string>& chain, const std::string& quality,
                    int kbps, Result& r) {
    using clk = std::chrono::steady_clock;
    auto ms = [](clk::duration d) { return std::chrono::duration<double, std::milli>(d).count(); };

    EncoderConfig cfg;
    cfg.codec_name   = chain.empty() ? "libx264" : chain[0];
    cfg.chain        = chain;
    cfg.quality      = quality;
    cfg.bitrate_kbps = kbps;
    std::unique_ptr<Encoder> enc;
    try { enc = std::make_unique<Encoder>(mode, cfg); } catch (...) { return false; }
    enc->prewarm(20);
    r.quality     = enc->quality();
    r.encoder     = enc->name();
    r.target_kbps = kbps;

    const AVCodec* dcodec = avcodec_find_decoder(enc->video_ctx()->codec_id);
    if (!dcodec) return false;
    AVCodecContext* dctx = avcodec_alloc_context3(dcodec);
    dctx->thread_count = 1;     // no frame threading: no extra decode delay, honest per-frame time
    if (avcodec_open2(dctx, dcodec, nullptr) < 0) { avcodec_free_context(&dctx); return false; }
    AVFrame*  df  = av_frame_alloc();
    AVPacket* dpk = av_packet_alloc();

    std::map<int64_t, Planes> refs;
    enc->set_tap([&](const AVFrame* f) { Planes p; if (grab(f, p)) refs.emplace(f->pts, std::move(p)); });

    double dec_acc = 0, psnr_sum = 0, ssim_sum = 0, psnrc_sum = 0, dec_total = 0;
    int    scored = 0, packets_counted = 0;
    size_t bytes = 0, max_bytes = 0;
    std::vector<double> enc_times;
    r.ssim_min = 1.0;

    auto drain = [&] {
        while (avcodec_receive_frame(dctx, df) == 0) {
            const int64_t pts = df->pts != AV_NOPTS_VALUE ? df->pts : df->best_effort_timestamp;
            auto it = refs.find(pts);
            if (it != refs.end()) {
                Planes d;
                if (grab(df, d) && d.w == it->second.w && d.h == it->second.h) {
                    const Planes& s = it->second;
                    const double m_y = mse(s.y.data(), d.y.data(), s.y.size());
                    const double m_c = 0.5 * (mse(s.u.data(), d.u.data(), s.u.size()) + mse(s.v.data(), d.v.data(), s.v.size()));
                    const double ss  = ssim_luma(s.y.data(), d.y.data(), s.w, s.h);
                    psnr_sum += psnr_from_mse(m_y); psnrc_sum += psnr_from_mse(m_c); ssim_sum += ss;
                    r.ssim_min = std::min(r.ssim_min, ss);
                    ++scored;
                }
                refs.erase(it);
            }
            av_frame_unref(df);
        }
    };

    for (const auto& f : clip) {
        dec_acc = 0;
        const auto t0 = clk::now();
        enc->encode(f, [&](AVPacket* pkt) {
            const auto d0 = clk::now();
            if (pkt->pts >= 0) { bytes += size_t(pkt->size); max_bytes = std::max(max_bytes, size_t(pkt->size)); ++packets_counted; }
            av_packet_ref(dpk, pkt);
            if (avcodec_send_packet(dctx, dpk) >= 0) drain();
            av_packet_unref(dpk);
            const double d = ms(clk::now() - d0);
            dec_acc += d; dec_total += d;
        });
        enc_times.push_back(std::max(0.0, ms(clk::now() - t0) - dec_acc));
    }
    avcodec_send_packet(dctx, nullptr);
    drain();

    av_packet_free(&dpk); av_frame_free(&df); avcodec_free_context(&dctx);
    if (scored == 0) return false;

    const double fps = double(mode.fps_num) / double(std::max<uint32_t>(1, mode.fps_den)) * (mode.interlaced ? 2 : 1);
    r.frames   = scored;
    r.psnr     = psnr_sum / scored;
    r.psnr_c   = psnrc_sum / scored;
    r.ssim     = ssim_sum / scored;
    r.kbps     = packets_counted ? double(bytes) * 8.0 / 1000.0 * fps / packets_counted : 0;
    r.max_kb   = double(max_bytes) / 1000.0;
    r.dec_ms   = packets_counted ? dec_total / packets_counted : 0;
    if (!enc_times.empty()) {
        double s = 0; for (double t : enc_times) s += t;
        r.enc_ms = s / double(enc_times.size());
        std::sort(enc_times.begin(), enc_times.end());
        r.enc_ms_p95 = enc_times[size_t(double(enc_times.size() - 1) * 0.95)];
    }
    r.ok = true;
    return true;
}

inline void print_json(const Result& r) {
    std::printf("{\"type\":\"qtest\",\"quality\":\"%s\",\"encoder\":\"%s\",\"target_kbps\":%d,\"frames\":%d,"
                "\"psnr\":%.2f,\"psnr_c\":%.2f,\"ssim\":%.4f,\"ssim_min\":%.4f,\"kbps\":%.0f,\"max_kb\":%.1f,"
                "\"enc_ms\":%.1f,\"enc_ms_p95\":%.1f,\"dec_ms\":%.1f}\n",
                r.quality.c_str(), r.encoder.c_str(), r.target_kbps, r.frames, r.psnr, r.psnr_c, r.ssim, r.ssim_min,
                r.kbps, r.max_kb, r.enc_ms, r.enc_ms_p95, r.dec_ms);
    std::fflush(stdout);
}

} // namespace sdi::qtest
