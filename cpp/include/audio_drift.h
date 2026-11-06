#pragma once
//
// AudioDriftTrim: keeps an output device's audio buffer at a steady depth.
//
// The audio arrives at the *source's* clock, and the output card plays it at its *own* clock.
// Two free-running clocks differ by tens of ppm, so the card's audio buffer either slowly
// fills (audio drifts later and later against the picture, whose queue is capped at a few
// frames) or slowly drains (periodic clicks). This trims the stream the other way: it measures
// how deep the output buffer is, and stretches or squeezes each incoming chunk by a tiny
// amount (at most 0.5%, inaudible) so the depth stays where it started.
//
//   * The target depth is learned, not configured: the average depth over the first seconds,
//     which is whatever offset the output path already has. Lip-sync is therefore left as it
//     is and only the drift is removed.
//   * Resampling is linear interpolation with the chunk's end points fixed, so there is no
//     step at chunk boundaries; a 10 ms chunk changes length by at most a couple of samples.
//   * A buffer more than 150 ms over target (a stall that released a backlog) is cut by
//     dropping the chunk, once, instead of waiting minutes for the trim to work it off.
//
// Single-threaded: call process() from the one thread that feeds the device.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace sdi {

class AudioDriftTrim {
public:
    explicit AudioDriftTrim(int channels, int sample_rate = 48000)
        : ch_(std::max(1, channels)), sr_(sample_rate) {}

    // `in`: `frames` interleaved S32 frames. `buffered_frames`: frames already queued in the
    // output device ahead of this chunk. Returns the chunk to hand to the device (empty = drop).
    std::vector<int32_t> process(const int32_t* in, size_t frames, int64_t buffered_frames) {
        if (frames == 0) return {};
        if (!calibrated_) {
            seen_ += frames;
            if (seen_ > size_t(sr_)) {                      // skip the first second: preroll transient
                cal_sum_  += double(buffered_frames) * double(frames);
                cal_w_    += double(frames);
            }
            if (seen_ >= size_t(sr_) * 3 && cal_w_ > 0) {   // average over the next two seconds
                target_ = cal_sum_ / cal_w_;
                smooth_ = target_;
                calibrated_ = true;
            }
            return std::vector<int32_t>(in, in + frames * size_t(ch_));
        }

        // Average the depth over ~0.5 s: it saw-tooths by one chunk as data arrives and is consumed.
        const double alpha = std::min(1.0, double(frames) / (0.5 * sr_));
        smooth_ += alpha * (double(buffered_frames) - smooth_);
        const double err = smooth_ - target_;                    // + = too much buffered

        if (err > 0.150 * sr_) {                                 // backlog from a stall: cut it now
            dropped_ += frames;
            smooth_ -= double(frames);
            ratio_ = 1.0;
            return {};
        }

        const double dead = 0.002 * sr_;                         // +-2 ms is left alone
        double r = 1.0;
        if (std::fabs(err) > dead) {
            const double e = err > 0 ? err - dead : err + dead;
            r = 1.0 - std::clamp(e / (4.0 * sr_), -kMaxTrim, kMaxTrim);   // fix the error over ~4 s
        }
        ratio_ = r;

        const double exact = double(frames) * r + carry_;
        size_t out_n = size_t(std::floor(exact));
        carry_ = exact - double(out_n);
        if (out_n == frames || out_n == 0 || frames < 2)
            return std::vector<int32_t>(in, in + frames * size_t(ch_));

        std::vector<int32_t> out(out_n * size_t(ch_));
        const double step = out_n > 1 ? double(frames - 1) / double(out_n - 1) : 0.0;
        for (size_t i = 0; i < out_n; ++i) {
            const double pos = double(i) * step;
            const size_t i0 = std::min(size_t(pos), frames - 2);
            const double fr = pos - double(i0);
            for (int c = 0; c < ch_; ++c) {
                const double a = in[i0 * size_t(ch_) + size_t(c)], b = in[(i0 + 1) * size_t(ch_) + size_t(c)];
                const double v = a + (b - a) * fr;
                out[i * size_t(ch_) + size_t(c)] = int32_t(std::clamp(v, -2147483648.0, 2147483647.0));
            }
        }
        // The output is shorter/longer than the input by this many frames; track it so the
        // smoothed depth reflects what we actually wrote.
        smooth_ += double(out_n) - double(frames);
        return out;
    }

    bool     calibrated()     const { return calibrated_; }
    double   target_frames()  const { return target_; }
    double   ratio()          const { return ratio_; }
    uint64_t dropped_frames() const { return dropped_; }

private:
    static constexpr double kMaxTrim = 0.005;   // 0.5%
    int      ch_, sr_;
    bool     calibrated_ = false;
    size_t   seen_ = 0;
    double   cal_sum_ = 0, cal_w_ = 0;
    double   target_ = 0, smooth_ = 0, ratio_ = 1.0, carry_ = 0;
    uint64_t dropped_ = 0;
};

} // namespace sdi
