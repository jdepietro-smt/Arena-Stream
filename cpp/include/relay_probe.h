#pragma once
//
// Round trip time to a relay, measured without touching anything that is running on it.
//
// Every SRT connection starts with two exchanges (an induction and a conclusion). The relay turns away a connection whose stream id
// is not a publisher or a reader, so a connect with the stream id "probe:rtt" fails after exactly those two round trips, and
// nothing is registered on the relay: no publisher is replaced, no reader joins. The time it took, halved, is the round trip. The
// shortest of a few tries is used, since a delay only ever adds. Works on old relays too (they refuse unknown roles the same way).
//
// Used to size the SRT buffer of each relay leg from that relay's own distance (see relay_latency.h), so a relay in the same region
// as the PC gets a small buffer and a distant one gets a larger one.
#include <srt/srt.h>

#include <algorithm>
#include <chrono>
#include <string>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#endif

namespace sdi::link {

// -1 when the relay does not answer (down, firewalled, wrong address). srt_startup() must already have been called.
inline double srt_rtt_ms(const std::string& host, int port, int trials = 3, int timeout_ms = 1500) {
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(uint16_t(port));
    if (inet_pton(AF_INET, host.c_str(), &sa.sin_addr) != 1) return -1;
    double best = -1;
    srt_setloglevel(2);          // libsrt would log a warning for every refused try: keep the apps' logs clean (2 = critical only; 4 is its normal level)
    for (int i = 0; i < trials; ++i) {
        SRTSOCKET s = srt_create_socket();
        if (s == SRT_INVALID_SOCK) break;
        const char id[] = "probe:rtt";
        srt_setsockflag(s, SRTO_STREAMID, id, int(sizeof(id) - 1));
        srt_setsockflag(s, SRTO_CONNTIMEO, &timeout_ms, sizeof(timeout_ms));
        const auto t0 = std::chrono::steady_clock::now();
        const int r = srt_connect(s, reinterpret_cast<sockaddr*>(&sa), sizeof(sa));
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        const bool answered = r != SRT_ERROR || srt_getlasterror(nullptr) == SRT_ECONNREJ;   // refused counts: the other end replied
        srt_close(s);
        if (answered) best = best < 0 ? ms / 2.0 : std::min(best, ms / 2.0);
    }
    srt_setloglevel(4);
    return best;
}

} // namespace sdi::link
