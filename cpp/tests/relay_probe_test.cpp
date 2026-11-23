// The relay round trip probe, against a real SRT listener on this PC.
#include "relay_probe.h"
#include "relay_latency.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <thread>

#define CHECK(c) do { if (!(c)) { std::fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); std::exit(1); } } while (0)

static std::atomic<int> g_seen{0};
static std::atomic<bool> g_accept_all{false};

// What the relay does: refuse any stream id that is not publish: or read:. Counts what it was asked.
static int listen_cb(void*, SRTSOCKET, int, const struct sockaddr*, const char* streamid) {
    ++g_seen;
    const std::string id = streamid ? streamid : "";
    if (g_accept_all) return 0;
    return (id.rfind("publish:", 0) == 0 || id.rfind("read:", 0) == 0) ? 0 : -1;
}

static SRTSOCKET listen_on(int port) {
    SRTSOCKET l = srt_create_socket();
    srt_listen_callback(l, listen_cb, nullptr);
    sockaddr_in sa{};
    sa.sin_family = AF_INET; sa.sin_port = htons(uint16_t(port)); inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
    CHECK(srt_bind(l, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) != SRT_ERROR);
    CHECK(srt_listen(l, 4) != SRT_ERROR);
    return l;
}

int main() {
    srt_startup();
    SRTSOCKET l = listen_on(28931);

    // A relay that turns the probe away is still an answer, and the time is a small number on this PC.
    const double rtt = sdi::link::srt_rtt_ms("127.0.0.1", 28931);
    CHECK(rtt >= 0 && rtt < 60);
    CHECK(g_seen >= 1);                                    // it really reached the listener
    CHECK(sdi::link::auto_relay_latency_ms(rtt) == 60);    // a nearby relay gets the smallest buffer

    // A listener that accepts everything also answers.
    g_accept_all = true;
    const double rtt2 = sdi::link::srt_rtt_ms("127.0.0.1", 28931, 2);
    CHECK(rtt2 >= 0 && rtt2 < 60);
    g_accept_all = false;

    // Nobody there: no answer, in about the time allowed, and not a made-up number.
    const auto t0 = std::chrono::steady_clock::now();
    const double none = sdi::link::srt_rtt_ms("127.0.0.1", 28939, 1, 400);
    const double took = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    CHECK(none < 0);
    CHECK(took < 2500);
    CHECK(sdi::link::auto_relay_latency_ms(none) == sdi::link::kRelayLatencyDefaultMs);   // and the default buffer is used

    // A bad address is refused at once.
    CHECK(sdi::link::srt_rtt_ms("not an address", 1234) < 0);

    srt_close(l);
    srt_cleanup();
    std::puts("relay_probe_test: all checks passed");
    return 0;
}
