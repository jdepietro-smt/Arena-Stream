// Pushes synthetic 720p frames through the real Encoder (libx264) and writes the
// raw H.264 stream to argv[1], so a script can confirm every frame carries the
// glass-to-glass latency SEI (ffprobe -show_frames lists it as side data).
#include "encoder.h"
#include <cstdio>
#include <fstream>

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: latency_encode_check out.h264 [encoder]\n"); return 2; }
    const std::string codec = argc > 2 ? argv[2] : "libx264";
    sdi::VideoMode mode;
    mode.width = 1280; mode.height = 720; mode.fps_num = 60000; mode.fps_den = 1001;
    mode.format = sdi::PixelFormat::UYVY422_8;
    sdi::EncoderConfig cfg;
    cfg.codec_name = codec; cfg.chain = { codec }; cfg.bitrate_kbps = 4000; cfg.gop = 15;
    sdi::Encoder enc(mode, cfg);

    std::ofstream out(argv[1], std::ios::binary);
    for (int i = 0; i < 45; ++i) {
        sdi::VideoFrame f;
        f.mode = mode; f.stride = mode.width * 2;
        f.data.assign(f.stride * mode.height, 0);
        for (size_t p = 0; p < f.data.size(); p += 2) { f.data[p] = 128; f.data[p + 1] = uint8_t((p / 2 + i * 7) & 0xFF); }
        f.pts = std::chrono::nanoseconds(int64_t(i) * 16'683'333);
        enc.encode(f, [&](AVPacket* pkt) { out.write(reinterpret_cast<char*>(pkt->data), pkt->size); });
    }
    return 0;
}
