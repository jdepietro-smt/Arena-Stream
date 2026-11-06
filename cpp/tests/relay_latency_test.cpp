// Tests for relay_latency.h. Plain asserts, exits non-zero on the first failure.
#include "relay_latency.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); ++failures; } } while (0)

int main() {
    using sdi::link::auto_relay_latency_ms;
    CHECK(auto_relay_latency_ms(-1) == 100);     // not measured -> the old default
    CHECK(auto_relay_latency_ms(0) == 100);
    CHECK(auto_relay_latency_ms(5) == 60);       // very close: floor
    CHECK(auto_relay_latency_ms(15) == 60);
    CHECK(auto_relay_latency_ms(40) == 60);
    CHECK(auto_relay_latency_ms(77) == 110);     // this PC to the server
    CHECK(auto_relay_latency_ms(100) == 130);
    CHECK(auto_relay_latency_ms(150) == 200);
    CHECK(auto_relay_latency_ms(400) == 200);    // ceiling: beyond this the delay budget is gone anyway
    for (double r = 1; r < 500; r += 1) CHECK(auto_relay_latency_ms(r) >= 60 && auto_relay_latency_ms(r) <= 200 && auto_relay_latency_ms(r) % 10 == 0);
    for (double r = 1; r < 499; r += 1) CHECK(auto_relay_latency_ms(r + 1) >= auto_relay_latency_ms(r));   // monotonic
    if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
    std::puts("relay_latency_test: all passed");
    return 0;
}
