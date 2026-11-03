#include "latency_stamp.h"
#include <cassert>
#include <iostream>
using namespace sdi::latency;
int main() {
    uint8_t buf[kSize];
    for (int64_t t : { int64_t(0), int64_t(1), int64_t(1'793'000'000'123'456), int64_t(0x7FFFFFFFFFFFFFFF) }) {
        pack(buf, t);
        auto r = unpack(buf, kSize);
        assert(r && *r == t);
    }
    pack(buf, 42);
    assert(!unpack(buf, kSize - 1));                       // too short
    buf[3] ^= 0xFF;
    assert(!unpack(buf, kSize));                           // someone else's SEI (e.g. x264's own)
    assert(!unpack(nullptr, 0));
    const int64_t a = now_utc_us(); const int64_t b = now_utc_us();
    assert(b >= a && a > 1'700'000'000'000'000);           // plausibly current microseconds
    std::cout << "latency_stamp_test: ok\n";
}
