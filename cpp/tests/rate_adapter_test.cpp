// Tests for rate_adapter.h. Plain asserts, exits non-zero on the first failure.
#include "rate_adapter.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); ++failures; } } while (0)

struct Net { long sent = 0, re = 0, drop = 0; void sec(int pkts, double loss_pct, int drops = 0) { sent += pkts; re += long(pkts * loss_pct / 100.0); drop += drops; } };

int main() {
    // Clean link: never changes.
    { sdi::RateAdapter a(10000, true); Net n; for (int i = 0; i < 120; ++i) { n.sec(1000, 0); CHECK(a.tick(n.sent, n.re, n.drop) == 0); } CHECK(a.current() == 10000); }

    // Sustained 5% loss: steps down, but not below half.
    { sdi::RateAdapter a(10000, true); Net n; int changes = 0; a.tick(0, 0, 0);
      for (int i = 0; i < 60; ++i) { n.sec(1000, 5); if (a.tick(n.sent, n.re, n.drop)) ++changes; }
      CHECK(a.current() == 5000); CHECK(changes >= 4); CHECK(a.reduced());
      // Steps are 3 s apart at most: the first drop after 1 s, then every 3 s.
    }
    // Loss clears: recovers fully, slowly.
    { sdi::RateAdapter a(10000, true); Net n; a.tick(0, 0, 0);
      for (int i = 0; i < 20; ++i) { n.sec(1000, 5); a.tick(n.sent, n.re, n.drop); }
      const int low = a.current(); CHECK(low < 10000);
      int secs = 0; for (; secs < 600 && a.current() < 10000; ++secs) { n.sec(1000, 0); a.tick(n.sent, n.re, n.drop); }
      CHECK(a.current() == 10000); CHECK(secs >= 15 && secs < 300); std::printf("recovered %d -> 10000 in %d s\n", low, secs); }

    // One too-late drop is enough.
    { sdi::RateAdapter a(10000, true); Net n; a.tick(0, 0, 0); n.sec(1000, 0, 1); CHECK(a.tick(n.sent, n.re, n.drop) == 8500); CHECK(a.drops_recent()); }

    // Disabled: reports, never changes.
    { sdi::RateAdapter a(10000, false); Net n; a.tick(0, 0, 0); for (int i = 0; i < 30; ++i) { n.sec(1000, 8); CHECK(a.tick(n.sent, n.re, n.drop) == 0); } CHECK(a.loss_avg() > 4); CHECK(a.current() == 10000); }

    // A viewer leaving resets the counters: no false alarm.
    { sdi::RateAdapter a(10000, true); a.tick(100000, 0, 0); CHECK(a.tick(500, 0, 0) == 0); CHECK(a.current() == 10000); }

    // The user changes the bitrate: that is the new target.
    { sdi::RateAdapter a(10000, true); a.set_target(6000); CHECK(a.current() == 6000 && a.target() == 6000 && !a.reduced()); }

    if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
    std::puts("rate_adapter_test: all passed");
    return 0;
}
