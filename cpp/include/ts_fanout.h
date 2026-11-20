#pragma once
//
// TsFanout — one MPEG-TS byte stream, many SRT destinations.
//
// The encoder muxes once; every muxer write is cut into SRT messages and sent to
//   * every decoder that connected to our listener (LAN path, no server in between)
//   * the relay, as a publisher (internet path), reconnecting in the background
// Sends never block: a slow or dead destination drops packets (live semantics)
// instead of stalling capture/encode.

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#endif

#include <srt/srt.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include "fec_profile.h"

#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace sdi {

struct FanoutConfig {
    int         listen_port        = 0;      // 0 = no direct listener
    int         listen_latency_ms  = 40;     // floor for direct (LAN) viewers
    std::string relay_host;                  // empty = no relay publish
    int         relay_port         = 8895;
    // Further relays that get the same stream at the same time (hot standby: if one relay or the path to it
    // dies, decoders switch to another with no gap on this side). Each one costs a full copy of the uplink.
    std::vector<std::pair<std::string, int>> extra_relays;
    std::string relay_name;
    std::string relay_secret;
    int         relay_latency_ms   = 100;
    std::string relay_fec;                   // "", "light" or "standard": forward error correction to the relay (see fec_profile.h)
    int64_t     pace_bytes_per_sec = 0;      // SRT send-rate cap (SRTO_MAXBW); 0 = SRT default (unpaced)
};

class TsFanout {
public:
    explicit TsFanout(FanoutConfig cfg) : cfg_(std::move(cfg)) {
        srt_startup();
        if (cfg_.listen_port > 0) listener_ = std::jthread([this](std::stop_token) { listen_loop(); });
        if (!cfg_.relay_host.empty()) {
            legs_.push_back(std::make_unique<Leg>(cfg_.relay_host, cfg_.relay_port));
            for (const auto& r : cfg_.extra_relays) legs_.push_back(std::make_unique<Leg>(r.first, r.second));
            for (auto& l : legs_) { Leg* p = l.get(); p->th = std::jthread([this, p](std::stop_token) { relay_loop(*p); }); }
        }
    }

    ~TsFanout() {
        stop_ = true;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (listen_sock_ != SRT_INVALID_SOCK) srt_close(listen_sock_);   // unblocks srt_accept
            listen_sock_ = SRT_INVALID_SOCK;
        }
        if (listener_.joinable()) listener_.join();
        for (auto& l : legs_) if (l->th.joinable()) l->th.join();
        std::lock_guard<std::mutex> lk(mtx_);
        for (SRTSOCKET s : clients_) srt_close(s);
        for (auto& l : legs_) if (l->sock != SRT_INVALID_SOCK) srt_close(l->sock);
        srt_cleanup();
    }

    TsFanout(const TsFanout&)            = delete;
    TsFanout& operator=(const TsFanout&) = delete;

    // Called from the muxer's write callback.
    void send(const uint8_t* data, int n) {
        std::lock_guard<std::mutex> lk(mtx_);
        for (int off = 0; off < n; off += kMsg) {
            const int len = std::min(kMsg, n - off);
            for (size_t i = 0; i < clients_.size();) {
                if (push(clients_[i], data + off, len)) ++i;
                else { srt_close(clients_[i]); clients_.erase(clients_.begin() + long(i)); }
            }
            for (auto& l : legs_) {
                if (l->sock != SRT_INVALID_SOCK && !push(l->sock, data + off, len)) {
                    srt_close(l->sock);
                    l->sock = SRT_INVALID_SOCK;     // relay_loop reconnects
                }
            }
        }
        bytes_ += uint64_t(n);
    }

    // Cap how fast SRT may send (bytes/s, retransmits included). Without a cap a large keyframe
    // leaves as one line-rate burst, which is what overruns receive buffers and causes loss.
    // Applies to the listener (new viewers inherit it), current viewers and the relay publisher.
    void set_pacing(int64_t bytes_per_sec) {
        std::lock_guard<std::mutex> lk(mtx_);
        cfg_.pace_bytes_per_sec = bytes_per_sec;
        if (listen_sock_ != SRT_INVALID_SOCK) apply_pace(listen_sock_);
        for (SRTSOCKET c : clients_) apply_pace(c);
        for (auto& l : legs_) if (l->sock != SRT_INVALID_SOCK) apply_pace(l->sock);
    }

    // Sender-side SRT counters for one set of connections (cumulative since each connected).
    struct PathHealth {
        int     conns = 0;
        double  rtt_ms = -1;
        int64_t sent = 0, retrans = 0, drops = 0;   // packets sent / re-sent / dropped as too late
    };
    PathHealth relay_health() const {
        std::lock_guard<std::mutex> lk(mtx_);
        PathHealth h;
        for (auto& l : legs_) if (l->sock != SRT_INVALID_SOCK) add_health(h, l->sock);
        return h;
    }
    PathHealth viewer_health() const {
        std::lock_guard<std::mutex> lk(mtx_);
        PathHealth h;
        for (SRTSOCKET c : clients_) add_health(h, c);
        return h;
    }

    int      clients()  const { std::lock_guard<std::mutex> lk(mtx_); return int(clients_.size()); }
    bool     relay_up() const { std::lock_guard<std::mutex> lk(mtx_); for (auto& l : legs_) if (l->sock != SRT_INVALID_SOCK) return true; return false; }
    // How many relays are connected right now, and how many were asked for.
    int      relays_up() const { std::lock_guard<std::mutex> lk(mtx_); int n = 0; for (auto& l : legs_) if (l->sock != SRT_INVALID_SOCK) ++n; return n; }
    int      relays_total() const { return int(legs_.size()); }
    uint64_t bytes()    const { return bytes_.load(); }
    double   relay_rtt_ms() const {
        std::lock_guard<std::mutex> lk(mtx_);
        for (auto& l : legs_) {
            if (l->sock == SRT_INVALID_SOCK) continue;
            SRT_TRACEBSTATS st{};
            if (srt_bistats(l->sock, &st, 0, 1) == 0) return st.msRTT;
        }
        return -1;
    }

private:
    static constexpr int kMsg = 1316;   // 7 TS packets per SRT message

    // false = socket is gone and must be dropped. A full send buffer only drops this message.
    static bool push(SRTSOCKET s, const uint8_t* d, int len) {
        if (srt_sendmsg(s, reinterpret_cast<const char*>(d), len, -1, 0) != SRT_ERROR) return true;
        return srt_getlasterror(nullptr) == SRT_EASYNCSND;
    }

    static void add_health(PathHealth& h, SRTSOCKET s) {
        SRT_TRACEBSTATS st{};
        if (srt_bistats(s, &st, 0, 1) != 0) return;
        ++h.conns;
        h.rtt_ms   = std::max(h.rtt_ms, double(st.msRTT));
        h.sent    += st.pktSentTotal;
        h.retrans += st.pktRetransTotal;
        h.drops   += st.pktSndDropTotal;
    }

    void apply_pace(SRTSOCKET s) const {
        if (cfg_.pace_bytes_per_sec <= 0) return;
        const int64_t bw = cfg_.pace_bytes_per_sec;
        srt_setsockflag(s, SRTO_MAXBW, &bw, sizeof(bw));
    }

    void common_opts(SRTSOCKET s, int latency_ms) {
        const int yes = 1, no = 0, payload = kMsg;
        srt_setsockflag(s, SRTO_LATENCY,     &latency_ms, sizeof(latency_ms));
        srt_setsockflag(s, SRTO_PAYLOADSIZE, &payload, sizeof(payload));
        srt_setsockflag(s, SRTO_TSBPDMODE,   &yes, sizeof(yes));
        srt_setsockflag(s, SRTO_TLPKTDROP,   &yes, sizeof(yes));
        srt_setsockflag(s, SRTO_SNDSYN,      &no,  sizeof(no));
        apply_pace(s);
    }

    void listen_loop() {
        SRTSOCKET lis = srt_create_socket();
        common_opts(lis, cfg_.listen_latency_ms);
        sockaddr_in sa{};
        sa.sin_family = AF_INET; sa.sin_port = htons(uint16_t(cfg_.listen_port)); sa.sin_addr.s_addr = INADDR_ANY;
        if (srt_bind(lis, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) == SRT_ERROR || srt_listen(lis, 8) == SRT_ERROR) {
            std::fprintf(stderr, "fanout: cannot listen on UDP :%d: %s\n", cfg_.listen_port, srt_getlasterror_str());
            srt_close(lis);
            return;
        }
        { std::lock_guard<std::mutex> lk(mtx_); listen_sock_ = lis; }
        std::fprintf(stderr, "fanout: direct SRT listener on UDP :%d\n", cfg_.listen_port);
        while (!stop_) {
            sockaddr_storage peer{};
            int plen = sizeof(peer);
            SRTSOCKET c = srt_accept(lis, reinterpret_cast<sockaddr*>(&peer), &plen);
            if (c == SRT_INVALID_SOCK) {
                if (stop_) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                continue;
            }
            std::lock_guard<std::mutex> lk(mtx_);
            clients_.push_back(c);
            std::fprintf(stderr, "fanout: viewer connected (%zu)\n", clients_.size());
        }
    }

    struct Leg {
        Leg(std::string h, int p) : host(std::move(h)), port(p) {}
        std::string host;
        int         port;
        SRTSOCKET   sock = SRT_INVALID_SOCK;
        std::jthread th;
    };

    void relay_loop(Leg& leg) {
        const std::string sid = sdi::fec::tag_streamid("publish:" + cfg_.relay_name + ":" + cfg_.relay_secret, cfg_.relay_fec);
        const std::string fec = sdi::fec::config(cfg_.relay_fec);
        while (!stop_) {
            SRTSOCKET s = srt_create_socket();
            common_opts(s, cfg_.relay_latency_ms);
            if (!fec.empty()) srt_setsockflag(s, SRTO_PACKETFILTER, fec.data(), int(fec.size()));
            srt_setsockflag(s, SRTO_STREAMID, sid.data(), int(sid.size()));
            const int tmo = 2000;
            srt_setsockflag(s, SRTO_CONNTIMEO, &tmo, sizeof(tmo));

            sockaddr_in sa{};
            sa.sin_family = AF_INET;
            sa.sin_port   = htons(uint16_t(leg.port));
            if (inet_pton(AF_INET, leg.host.c_str(), &sa.sin_addr) != 1) {
                std::fprintf(stderr, "fanout: relay host must be an IPv4 address: %s\n", leg.host.c_str());
                srt_close(s);
                return;
            }
            if (srt_connect(s, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) == SRT_ERROR) {
                srt_close(s);
                for (int i = 0; i < 10 && !stop_; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }
            { std::lock_guard<std::mutex> lk(mtx_); leg.sock = s; }
            std::fprintf(stderr, "fanout: relay publish up (%s:%d)\n", leg.host.c_str(), leg.port);
            while (!stop_) {   // send() clears leg.sock on failure; also watch the socket state
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
                std::lock_guard<std::mutex> lk(mtx_);
                if (leg.sock != s) break;
                if (srt_getsockstate(s) != SRTS_CONNECTED) { srt_close(s); leg.sock = SRT_INVALID_SOCK; break; }
            }
            std::fprintf(stderr, "fanout: relay publish down (%s:%d), reconnecting\n", leg.host.c_str(), leg.port);
        }
    }

    FanoutConfig             cfg_;
    mutable std::mutex       mtx_;
    std::vector<SRTSOCKET>   clients_;
    SRTSOCKET                listen_sock_ = SRT_INVALID_SOCK;
    std::vector<std::unique_ptr<Leg>> legs_;
    std::atomic<bool>        stop_{false};
    std::atomic<uint64_t>    bytes_{0};
    std::jthread             listener_;
};

} // namespace sdi
