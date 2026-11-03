// Glass-to-glass latency stamp: the encoder tucks the wall-clock capture time into
// every video frame as an H.264/HEVC "user data unregistered" SEI (16-byte UUID +
// 8-byte big-endian UTC microseconds).  The decoder reads it back from the decoded
// frame's side data and subtracts it from its own clock.  The two machines need
// synchronised clocks (NTP/Windows Time); on one machine the figure is exact.
#pragma once
#include <chrono>
#include <cstdint>
#include <cstring>
#include <optional>

namespace sdi::latency {

inline constexpr uint8_t kUuid[16] = { 'A','R','E','N','A','-','S','T','R','E','A','M','-','L','A','T' };
inline constexpr size_t  kSize     = 16 + 8;

inline int64_t now_utc_us() {
    using namespace std::chrono;
    return duration_cast<microseconds>(system_clock::now().time_since_epoch()).count();
}

inline void pack(uint8_t* out /* kSize bytes */, int64_t utc_us) {
    std::memcpy(out, kUuid, 16);
    for (int i = 0; i < 8; ++i) out[16 + i] = uint8_t((uint64_t(utc_us) >> (56 - 8 * i)) & 0xFF);
}

// Returns the stamped UTC microseconds, or nothing if this isn't our SEI.
inline std::optional<int64_t> unpack(const uint8_t* data, size_t size) {
    if (!data || size < kSize || std::memcmp(data, kUuid, 16) != 0) return std::nullopt;
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v = (v << 8) | data[16 + i];
    return int64_t(v);
}

}  // namespace sdi::latency
