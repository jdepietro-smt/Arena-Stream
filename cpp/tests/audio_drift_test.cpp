// Tests for audio_drift.h: a simulated output card whose clock differs from the source's.
// Plain asserts, exits non-zero on the first failure.

#include "audio_drift.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

static int failures = 0;
#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); ++failures; } \
    } while (0)

struct Sim { double final_err; double max_abs_err; uint64_t dropped; double min_buf; };

// Source delivers 10 ms chunks at its own clock (ppm faster than the card); card drains at 48 kHz.
// `trim` off shows what happens without the fix.
static Sim run(double ppm, double hours, bool trim, bool stall) {
    const int ch = 2, chunk = 480;
    sdi::AudioDriftTrim t(ch);
    std::vector<int32_t> in(size_t(chunk) * ch);
    double buffered = 2400, target = -1, max_err = 0, min_buf = 1e9;
    const long chunks = long(hours * 3600.0 * 100.0);
    double phase = 0;
    for (long n = 0; n < chunks; ++n) {
        for (int i = 0; i < chunk; ++i) {
            const int32_t v = int32_t(std::sin(phase) * 5.0e8);
            phase += 2 * 3.14159265358979 * 1000.0 / 48000.0;
            in[size_t(i) * ch] = v; in[size_t(i) * ch + 1] = v;
        }
        if (stall && n == chunks / 2) buffered += 20000;           // a stall released a backlog
        double wrote = chunk;
        if (trim) {
            auto out = t.process(in.data(), chunk, int64_t(buffered));
            wrote = double(out.size() / ch);
        }
        buffered += wrote;
        buffered -= double(chunk) / (1.0 + ppm * 1e-6);              // card drains in the same interval
        buffered = std::max(0.0, std::min(buffered, 480000.0));
        if (t.calibrated() && target < 0) target = t.target_frames();
        if (target >= 0 && n > chunks / 2 + 3000) { max_err = std::max(max_err, std::fabs(buffered - target)); }
        if (n > 500) min_buf = std::min(min_buf, buffered);
    }
    return { buffered - (target < 0 ? 2400.0 : target), max_err, t.dropped_frames(), min_buf };
}

int main() {
    for (double ppm : { 100.0, -100.0, 40.0, -40.0 }) {
        const Sim off = run(ppm, 1.0, false, false);
        const Sim on  = run(ppm, 1.0, true,  false);
        std::printf("ppm %+.0f: without trim buffer ends %+.0f frames from start | with trim %+.0f (worst %.0f)\n",
                    ppm, off.final_err, on.final_err, on.max_abs_err);
        CHECK(std::fabs(on.final_err) < 600);          // held within ~12 ms of where it started
        CHECK(on.dropped == 0);
    }
    // 100 ppm for 6 hours: still bounded.
    { const Sim s = run(100.0, 6.0, true, false); std::printf("6 h at +100 ppm: ends %+.0f\n", s.final_err); CHECK(std::fabs(s.final_err) < 600); CHECK(s.dropped == 0); }
    // A zero-drift stream is left alone.
    { const Sim s = run(0.0, 0.2, true, false); CHECK(std::fabs(s.final_err) < 600); CHECK(s.dropped == 0); }
    // A 400 ms backlog is cut once, then the level returns to target.
    { const Sim s = run(0.0, 0.5, true, true); std::printf("stall: dropped %llu frames, ends %+.0f\n", (unsigned long long)s.dropped, s.final_err);
      CHECK(s.dropped > 0); CHECK(std::fabs(s.final_err) < 1500); }

    // Waveform continuity: trimming a sine must not add steps.
    {
        sdi::AudioDriftTrim t(1);
        std::vector<int32_t> in(480);
        double phase = 0, max_step_in = 0, max_step_out = 0; int32_t last = 0; bool have = false;
        for (int n = 0; n < 2000; ++n) {
            for (int i = 0; i < 480; ++i) { in[size_t(i)] = int32_t(std::sin(phase) * 5.0e8); phase += 2 * 3.14159265358979 * 1000.0 / 48000.0; }
            auto out = t.process(in.data(), 480, n < 400 ? 2400 : 2400 + 3000);   // forces a squeeze after calibration
            for (int32_t v : out) { if (have) max_step_out = std::max(max_step_out, std::fabs(double(v) - double(last))); last = v; have = true; }
        }
        max_step_in = 5.0e8 * 2 * 3.14159265358979 * 1000.0 / 48000.0;
        std::printf("sine step: input max %.3g, trimmed output max %.3g\n", max_step_in, max_step_out);
        CHECK(max_step_out < max_step_in * 1.6);
    }

    if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
    std::puts("audio_drift_test: all passed");
    return 0;
}
