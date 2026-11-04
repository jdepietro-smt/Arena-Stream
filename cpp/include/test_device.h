#pragma once
//
// TestPatternDevice — a CaptureDevice that needs no hardware. Paced in real time like a
// capture card: moving bar video plus a 1 kHz tone, so the whole chain (encode, mux,
// transport, decode) can be run and timed on any machine.
//
// device_id picks the format: "1080p5994" (default), "1080p60", "1080i5994", "720p60", "720p5994".
// Interlaced formats deliver one frame per two fields, with the second field captured half a
// frame later, exactly like a card does.

#include "capture_device.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <thread>

namespace sdi {

class TestPatternDevice final : public CaptureDevice {
public:
    ~TestPatternDevice() override { stop(); }

    bool start(const CaptureConfig& cfg, VideoCallback on_video, AudioCallback on_audio) override {
        const std::string& id = cfg.device_id;
        mode_ = {};
        mode_.format = PixelFormat::UYVY422_8;
        if (id.rfind("720", 0) == 0) { mode_.width = 1280; mode_.height = 720; }
        else                         { mode_.width = 1920; mode_.height = 1080; }
        mode_.interlaced = id.find('i') != std::string::npos;
        const bool ntsc = id.find("5994") != std::string::npos || id.find("59.94") != std::string::npos || id == "0" || id.empty();
        const uint32_t field_rate = ntsc ? 60000 : 60;
        // Cards report the FRAME rate: 1080i59.94 is 29.97 frames per second.
        mode_.fps_num = mode_.interlaced ? field_rate / 2 : field_rate;
        mode_.fps_den = ntsc ? 1001 : 1;
        channels_ = std::max<uint32_t>(2, cfg.audio_channels);
        on_video_ = std::move(on_video);
        on_audio_ = std::move(on_audio);
        running_ = true;
        thread_ = std::thread([this] { run(); });
        return true;
    }

    void stop() override {
        running_ = false;
        if (thread_.joinable()) thread_.join();
    }

    VideoMode current_mode() const override { return mode_; }
    std::string_view backend_name() const override { return "test"; }

private:
    void draw(VideoFrame& f, uint64_t tick) const {
        // tick counts fields for interlaced, frames otherwise; a bar moves 24 px per tick.
        const size_t w = mode_.width, h = mode_.height;
        f.stride = w * 2;
        f.data.assign(f.stride * h, 0);
        for (size_t y = 0; y < h; ++y) {
            uint8_t* row = f.data.data() + y * f.stride;
            for (size_t x = 0; x < w; x += 2) {          // UYVY: U Y0 V Y1
                row[x * 2 + 0] = 128; row[x * 2 + 1] = uint8_t(40 + (x * 100) / w);
                row[x * 2 + 2] = 128; row[x * 2 + 3] = uint8_t(40 + (x * 100) / w);
            }
        }
        const size_t bar_w = 48, x0 = size_t((tick * 24) % (w - bar_w)) & ~size_t(1);
        for (size_t y = 0; y < h; ++y) {
            uint8_t* row = f.data.data() + y * f.stride;
            for (size_t x = x0; x < x0 + bar_w; x += 2) { row[x * 2 + 1] = 235; row[x * 2 + 3] = 235; }
        }
    }

    // Interlaced: field A on even lines at tick 2n, field B on odd lines at tick 2n+1.
    void draw_interlaced(VideoFrame& f, uint64_t n) const {
        VideoFrame a, b;
        draw(a, n * 2);
        draw(b, n * 2 + 1);
        f.stride = a.stride;
        f.data = std::move(a.data);
        for (size_t y = 1; y < mode_.height; y += 2)
            std::memcpy(f.data.data() + y * f.stride, b.data.data() + y * f.stride, f.stride);
    }

    void run() {
        using clock = std::chrono::steady_clock;
        const auto t0 = clock::now();
        const double fps = double(mode_.fps_num) / double(mode_.fps_den);
        const auto period = std::chrono::duration<double>(1.0 / fps);
        double audio_owed = 0;   // fractional samples carried between frames
        uint64_t aseq = 0, vseq = 0, tone = 0;
        for (uint64_t n = 0; running_; ++n) {
            std::this_thread::sleep_until(t0 + std::chrono::duration_cast<clock::duration>(period * double(n + 1)));
            const int64_t pts = std::chrono::duration_cast<std::chrono::nanoseconds>(clock::now() - t0).count();

            VideoFrame vf;
            vf.mode = mode_;
            if (mode_.interlaced) draw_interlaced(vf, n); else draw(vf, n);
            vf.pts = Nanos{pts};
            vf.sequence = vseq++;
            on_video_(std::move(vf));

            audio_owed += 48000.0 / fps;
            const size_t samples = size_t(audio_owed);
            audio_owed -= double(samples);
            AudioFrame af;
            af.channels = channels_;
            af.sample_rate = 48000;
            af.samples.resize(samples * channels_);
            for (size_t i = 0; i < samples; ++i, ++tone) {
                const int32_t v = int32_t(std::sin(2.0 * 3.14159265358979 * 1000.0 * double(tone) / 48000.0) * 0.25 * 2147483647.0);
                for (uint32_t c = 0; c < channels_; ++c) af.samples[i * channels_ + c] = v;
            }
            af.pts = Nanos{pts};
            af.sequence = aseq++;
            on_audio_(std::move(af));
        }
    }

    VideoMode       mode_{};
    uint32_t        channels_ = 2;
    VideoCallback   on_video_;
    AudioCallback   on_audio_;
    std::atomic<bool> running_{false};
    std::thread     thread_;
};

} // namespace sdi
