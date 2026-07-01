#pragma once
//
// Frame types passed through the capture → encode → mux pipeline.
// Kept intentionally simple: owning buffers, explicit PTS, and enough
// format information that downstream stages don't need to re-inspect.

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace sdi {

using Nanos = std::chrono::nanoseconds;

enum class PixelFormat {
    Unknown = 0,
    UYVY422_8,     // 8-bit 4:2:2, DeckLink/AJA default
    V210_10,       // 10-bit 4:2:2 packed, broadcast-quality capture
    NV12_8,        // 8-bit 4:2:0 semi-planar, encoder-friendly
    I420_8,        // 8-bit 4:2:0 planar
};

struct VideoMode {
    uint32_t width       = 0;
    uint32_t height      = 0;
    uint32_t fps_num     = 0;  // e.g. 60000 for 59.94
    uint32_t fps_den     = 0;  // e.g. 1001  for 59.94
    bool     interlaced  = false;
    PixelFormat format   = PixelFormat::Unknown;

    // Convenience: frame duration in nanoseconds.
    Nanos frame_duration() const {
        if (fps_num == 0) return Nanos{0};
        return Nanos{int64_t(1'000'000'000LL) * fps_den / fps_num};
    }
};

struct VideoFrame {
    std::vector<uint8_t> data;       // Owning buffer; row-packed per format.
    size_t               stride = 0; // Bytes per row.
    VideoMode            mode;
    Nanos                pts{0};     // Presentation time (capture clock).
    uint64_t             sequence = 0;
};

struct AudioFrame {
    // Interleaved S32LE samples at mode.sample_rate; channel count in
    // `channels`. Using S32 is DeckLink/AJA native and avoids lossy convert.
    std::vector<int32_t> samples;
    uint32_t             channels    = 0;
    uint32_t             sample_rate = 0;
    Nanos                pts{0};
    uint64_t             sequence    = 0;

    size_t frame_count() const {
        return channels == 0 ? 0 : samples.size() / channels;
    }
};

// Capture backends produce these in a callback model. Audio and video
// arrive on separate callbacks to match how both SDKs deliver data; PTS
// alignment happens downstream in the muxer.
using VideoCallback = std::function<void(VideoFrame&&)>;
using AudioCallback = std::function<void(AudioFrame&&)>;

} // namespace sdi
