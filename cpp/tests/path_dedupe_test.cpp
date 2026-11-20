// First-wins merge of one stream arriving over two paths. Pure C++, no deps.
#include "path_dedupe.h"

#include <cstdio>
#include <cstdlib>

#define CHECK(c) do { if (!(c)) { std::fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); std::exit(1); } } while (0)

using sdi::PathDedupe;
constexpr int V = 0, A = 1;
constexpr int64_t MS = 1000;

int main() {
    // Both paths deliver everything: the first copy of each packet is fresh, the second a duplicate.
    PathDedupe d;
    int64_t now = 0;
    for (int i = 0; i < 100; ++i) {
        const int64_t ts = i * 16'667;
        CHECK(d.check(V, ts, now) == PathDedupe::Fresh);          // path A
        CHECK(d.check(V, ts, now + 3 * MS) == PathDedupe::Duplicate);   // path B, 3 ms later
        now += 16 * MS;
    }

    // One path loses a packet: the other path's copy is still used.
    PathDedupe l;
    CHECK(l.check(V, 1000, 0) == PathDedupe::Fresh);               // from B (A lost 2000)
    CHECK(l.check(V, 2000, 1) == PathDedupe::Fresh);               // from B
    CHECK(l.check(V, 3000, 2) == PathDedupe::Fresh);
    CHECK(l.check(V, 2000, 3) == PathDedupe::Duplicate);           // A's own copy of 2000 turns up: already used

    // A packet that arrives after a newer one has gone on is too late to use.
    PathDedupe o;
    CHECK(o.check(V, 1000, 0) == PathDedupe::Fresh);
    CHECK(o.check(V, 3000, 1) == PathDedupe::Fresh);               // 2000 never came from this path
    CHECK(o.check(V, 2000, 2) == PathDedupe::Late);                // the other path delivers it after 3000: too late

    // Streams are independent: audio is not "late" because video moved on.
    PathDedupe s;
    CHECK(s.check(V, 900'000, 0) == PathDedupe::Fresh);
    CHECK(s.check(A, 100'000, 1) == PathDedupe::Fresh);
    CHECK(s.check(A, 100'000, 2) == PathDedupe::Duplicate);

    // One path dies: the survivor carries the stream alone, nothing is dropped.
    PathDedupe k;
    for (int i = 0; i < 50; ++i) { CHECK(k.check(V, i * 20'000, i) == PathDedupe::Fresh); }

    // Sender restarted (timestamps jump back by seconds): start over, do not drop the new stream.
    PathDedupe r;
    CHECK(r.check(V, 600'000'000, 0) == PathDedupe::Fresh);
    CHECK(r.check(V, 1'000, 10) == PathDedupe::Fresh);
    CHECK(r.check(V, 1'000, 11) == PathDedupe::Duplicate);
    CHECK(r.check(V, 17'000, 12) == PathDedupe::Fresh);

    // Memory stays bounded: old entries are forgotten after the keep time.
    PathDedupe m(5'000'000);
    for (int i = 0; i < 10000; ++i) m.check(V, int64_t(i) * 10'000, int64_t(i) * 10'000);
    CHECK(m.check(V, 99'999'000, 100'000'000) == PathDedupe::Fresh);

    std::puts("path_dedupe_test: all checks passed");
    return 0;
}
