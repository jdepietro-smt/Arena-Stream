// Glass-to-glass latency stamp: the encoder tucks the wall-clock capture time into
// every video frame as an H.264/HEVC "user data unregistered" SEI (16-byte UUID +
// 8-byte big-endian UTC microseconds).  The decoder reads it back from the decoded
// frame's side data and subtracts it from its own clock.  The two machines need
// synchronised clocks (NTP/Windows Time); on one machine the figure is exact.
#pragma once
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <optional>
#include <thread>
#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  pragma comment(lib, "ws2_32.lib")
#else
#  include <netdb.h>
#  include <sys/socket.h>
#  include <unistd.h>
#endif

namespace sdi::latency {

inline constexpr uint8_t kUuid[16] = { 'A','R','E','N','A','-','S','T','R','E','A','M','-','L','A','T' };
inline constexpr size_t  kSize     = 16 + 8;

// How far this PC's clock is from real time (microseconds to add), measured by SNTP.
// Both ends correct for their own PC's error, so the Delay figure and the decoder's
// catch-up logic no longer depend on either PC having a correct clock.
inline std::atomic<int64_t>& clock_offset_us() { static std::atomic<int64_t> v{0}; return v; }

inline int64_t system_utc_us() {
    using namespace std::chrono;
    return duration_cast<microseconds>(system_clock::now().time_since_epoch()).count();
}

inline int64_t now_utc_us() { return system_utc_us() + clock_offset_us().load(std::memory_order_relaxed); }

// One SNTP exchange; returns the offset in microseconds and the round trip, or false.
inline bool sntp_query(const char* host, int64_t& offset_us, int64_t& rtt_us) {
#ifdef _WIN32
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
    addrinfo hints{}; hints.ai_family = AF_INET; hints.ai_socktype = SOCK_DGRAM;
    addrinfo* ai = nullptr;
    if (getaddrinfo(host, "123", &hints, &ai) != 0 || !ai) return false;
    bool ok = false;
#ifdef _WIN32
    SOCKET s = socket(AF_INET, SOCK_DGRAM, 0); const bool good = s != INVALID_SOCKET;
    const DWORD tmo = 800; if (good) setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&tmo), sizeof tmo);
#else
    int s = socket(AF_INET, SOCK_DGRAM, 0); const bool good = s >= 0;
    timeval tmo{0, 800000}; if (good) setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tmo, sizeof tmo);
#endif
    if (good) {
        constexpr int64_t kEra = 2208988800LL;   // seconds from 1900 (NTP) to 1970 (Unix)
        auto to_ntp = [&](int64_t us, uint8_t* p) {
            const uint64_t sec = uint64_t(us / 1000000) + kEra, frac = uint64_t(us % 1000000) * 4294967296ULL / 1000000ULL;
            for (int i = 0; i < 4; ++i) { p[i] = uint8_t(sec >> (24 - 8 * i)); p[4 + i] = uint8_t(frac >> (24 - 8 * i)); }
        };
        auto from_ntp = [&](const uint8_t* p) {
            uint64_t sec = 0, frac = 0;
            for (int i = 0; i < 4; ++i) { sec = (sec << 8) | p[i]; frac = (frac << 8) | p[4 + i]; }
            return int64_t(sec) - kEra > 0 ? (int64_t(sec) - kEra) * 1000000 + int64_t(frac * 1000000ULL >> 32) : int64_t(0);
        };
        uint8_t pkt[48] = {0x23};                 // LI 0, version 4, client mode
        const int64_t t0 = system_utc_us();
        to_ntp(t0, pkt + 40);                     // transmit timestamp (echoed back as originate)
        if (sendto(s, reinterpret_cast<const char*>(pkt), 48, 0, ai->ai_addr, int(ai->ai_addrlen)) == 48) {
            uint8_t rsp[48];
            const int n = int(recv(s, reinterpret_cast<char*>(rsp), 48, 0));
            const int64_t t3 = system_utc_us();
            if (n >= 48 && (rsp[0] & 7) == 4 && rsp[1] != 0) {      // server mode, not "kiss of death"
                const int64_t t1 = from_ntp(rsp + 32), t2 = from_ntp(rsp + 40);
                if (t1 > 0 && t2 > 0) {
                    offset_us = ((t1 - t0) + (t2 - t3)) / 2;
                    rtt_us = (t3 - t0) - (t2 - t1);
                    ok = true;
                }
            }
        }
    }
#ifdef _WIN32
    if (good) closesocket(s);
#else
    if (good) close(s);
#endif
    freeaddrinfo(ai);
    return ok;
}

// Measures the clock error now and every 5 minutes after (best of three exchanges).
// Silent if no time server is reachable: the offset then stays 0, i.e. the PC clock is used.
inline void start_clock_sync() {
    static std::atomic<bool> started{false};
    if (started.exchange(true)) return;
    std::thread([] {
        static const char* kHosts[] = { "time.windows.com", "time.cloudflare.com", "pool.ntp.org" };
        for (;;) {
            int64_t best_rtt = INT64_MAX, best_off = 0;
            for (const char* h : kHosts) {
                for (int i = 0; i < 3; ++i) {
                    int64_t off, rtt;
                    if (sntp_query(h, off, rtt) && rtt >= 0 && rtt < best_rtt) { best_rtt = rtt; best_off = off; }
                }
                if (best_rtt < 150000) break;   // good enough: under 150 ms round trip
            }
            if (best_rtt != INT64_MAX) clock_offset_us().store(best_off);
            std::this_thread::sleep_for(std::chrono::minutes(best_rtt == INT64_MAX ? 1 : 5));
        }
    }).detach();
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
