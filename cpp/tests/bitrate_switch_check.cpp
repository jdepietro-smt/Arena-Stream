// Encodes noisy 720p frames, switching the target bitrate mid-stream with
// Encoder::set_bitrate, and prints bytes/sec for each phase so a script can
// confirm the running encoder really follows the change.
#include "encoder.h"
#include <cstdio>
#include <cstdlib>

int main(int argc, char** argv) {
    const std::string codec = argc > 1 ? argv[1] : "libx264";
    const int hi = argc > 2 ? std::atoi(argv[2]) : 8000;
    const int lo = argc > 3 ? std::atoi(argv[3]) : 2000;
    sdi::VideoMode mode;
    mode.width = 1280; mode.height = 720; mode.fps_num = 30; mode.fps_den = 1;
    mode.format = sdi::PixelFormat::UYVY422_8;
    sdi::EncoderConfig cfg;
    cfg.codec_name = codec; cfg.chain = { codec }; cfg.bitrate_kbps = hi; cfg.gop = 30;
    sdi::Encoder enc(mode, cfg);

    uint32_t seed = 12345;
    size_t bytes = 0;
    int phase_start = 0;
    auto report = [&](int upto, int target) {
        const double secs = (upto - phase_start) / 30.0;
        std::printf("target %5d kbps -> measured %7.0f kbps\n", target, bytes * 8.0 / 1000.0 / secs);
        bytes = 0; phase_start = upto;
    };
    const int total = 270;  // 3 phases x 3 s
    int target = hi;
    for (int i = 0; i < total; ++i) {
        if (i == 90)  { report(i, target); target = lo; enc.set_bitrate(lo); }
        if (i == 180) { report(i, target); target = hi; enc.set_bitrate(hi); }
        sdi::VideoFrame f;
        f.mode = mode; f.stride = mode.width * 2;
        f.data.resize(f.stride * mode.height);
        for (auto& b : f.data) { seed = seed * 1664525u + 1013904223u; b = uint8_t(96 + (seed >> 28) * 4); }
        f.pts = std::chrono::nanoseconds(int64_t(i) * 33'333'333);
        enc.encode(f, [&](AVPacket* pkt) { bytes += pkt->size; });
    }
    report(total, target);
    return 0;
}
