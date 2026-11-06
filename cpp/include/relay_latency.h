#pragma once
//
// Per-leg relay latency.
//
// A relayed stream is two independent SRT legs: encoder -> relay and relay -> decoder. Each has
// its own RTT (the encoder and the decoder are usually in different places) and its own latency
// buffer; the end-to-end delay is roughly the sum. Each end therefore sizes its own leg from its
// own measured RTT to the server instead of both using one number.
//
// SRT recommends 4x RTT for lossy links, but with an RTT of 77 ms that is 300 ms per leg, far
// outside a 300-350 ms end-to-end budget. This uses 1.25x RTT + 5 ms: enough for one
// retransmission round trip plus jitter, which is what a mostly clean path needs. The transmit
// side separately raises a warning when loss shows that the buffer is too small (see the
// encoder's stats loop), so a bad link is reported rather than silently buffered away.
//
//   rtt  15 ms ->  60 ms (floor)      rtt  77 ms -> 110 ms      rtt 150 ms -> 200 ms (ceiling)

#include <algorithm>
#include <cmath>

namespace sdi::link {

inline constexpr int kRelayLatencyDefaultMs = 100;   // when the RTT could not be measured

inline int auto_relay_latency_ms(double rtt_ms) {
    if (!(rtt_ms > 0)) return kRelayLatencyDefaultMs;
    const int v = int(std::ceil((1.25 * rtt_ms + 5.0) / 10.0)) * 10;
    return std::clamp(v, 60, 200);
}

} // namespace sdi::link
