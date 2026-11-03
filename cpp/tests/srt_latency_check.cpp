// Publishes paced synthetic 720p60 video through the real Encoder + SrtOutput,
// so sdi_decoder's rxMs/g2gMs can be read against it. Isolates "encoder + mux +
// SRT + relay" delay from the AJA capture path.  usage: srt_latency_check <srt-url> [seconds] [codec]
#include "encoder.h"
#include "srt_output.h"
#include <chrono>
#include <cstdio>
#include <thread>

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: srt_latency_check srt://... [seconds] [codec]\n"); return 2; }
    const int secs = argc > 2 ? std::atoi(argv[2]) : 20;
    const std::string codec = argc > 3 ? argv[3] : "h264_nvenc";
    sdi::VideoMode mode;
    mode.width = 1280; mode.height = 720; mode.fps_num = 60000; mode.fps_den = 1001;
    mode.format = sdi::PixelFormat::UYVY422_8;
    sdi::EncoderConfig cfg;
    cfg.codec_name = codec; cfg.chain = { codec }; cfg.bitrate_kbps = 10000; cfg.gop = 60;
    sdi::Encoder enc(mode, cfg);
    enc.prewarm();
    sdi::SrtOutput out(sdi::SrtOutputConfig{argv[1], 200}, enc.video_ctx(), nullptr);

    using clk = std::chrono::steady_clock;
    const auto t0 = clk::now();
    const auto frame_dur = std::chrono::nanoseconds(16'683'333);
    uint32_t seed = 1;
    for (int i = 0; clk::now() - t0 < std::chrono::seconds(secs); ++i) {
        std::this_thread::sleep_until(t0 + i * frame_dur);
        sdi::VideoFrame f;
        f.mode = mode; f.stride = mode.width * 2;
        f.data.resize(f.stride * mode.height);
        for (size_t p = 0; p < f.data.size(); p += 2) {
            seed = seed * 1664525u + 1013904223u;
            f.data[p] = 128; f.data[p + 1] = uint8_t(((p / 2 + i * 5) >> 4) + (seed >> 29));
        }
        f.pts = std::chrono::nanoseconds(int64_t(i) * 16'683'333);
        enc.encode(f, [&](AVPacket* pkt) { out.write_video(pkt); });
    }
    return 0;
}
