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
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace sdi {

struct FanoutConfig {
    int         listen_port        = 0;      // 0 = no direct listener
    int         listen_latency_ms  = 40;     // floor for direct (LAN) viewers
    std::string relay_host;                  // empty = no relay publish
    int         relay_port         = 8895;
    std::string relay_name;
    std::string relay_secret;
    int         relay_latency_ms   = 100;
    int64_t     pace_bytes_per_sec = 0;      // SRT send-rate cap (SRTO_MAXBW); 0 = SRT default (unpaced)
};

class TsFanout {
public:
    explicit TsFanout(FanoutConfig cfg) : cfg_(std::move(cfg)) {
        srt_startup();
        if (cfg_.listen_port > 0) listener_ = std::jthread([this](std::stop_token) { listen_loop(); });
        if (!cfg_.relay_host.empty()) relay_thread_ = std::jthread([this](std::stop_token) { relay_loop(); });
    }

    ~TsFanout() {
        stop_ = true;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (listen_sock_ != SRT_INVALID_SOCK) srt_close(listen_sock_);   // unblocks srt_accept
            listen_sock_ = SRT_INVALID_SOCK;
        }
        if (listener_.joinable()) listener_.join();
        if (relay_thread_.joinable()) relay_thread_.join();
        std::lock_guard<std::mutex> lk(mtx_);
        for (SRTSOCKET s : clients_) srt_close(s);
        if (relay_sock_ != SRT_INVALID_SOCK) srt_close(relay_sock_);
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
            if (relay_sock_ != SRT_INVALID_SOCK && !push(relay_sock_, data + off, len)) {
                srt_close(relay_sock_);
                relay_sock_ = SRT_INVALID_SOCK;     // relay_loop reconnects
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
        if (relay_sock_ != SRT_INVALID_SOCK) apply_pace(relay_sock_);
    }

    int      clients()  const { std::lock_guard<std::mutex> lk(mtx_); return int(clients_.size()); }
    bool     relay_up() const { std::lock_guard<std::mutex> lk(mtx_); return relay_sock_ != SRT_INVALID_SOCK; }
    uint64_t bytes()    const { return bytes_.load(); }
    double   relay_rtt_ms() const {
        std::lock_guard<std::mutex> lk(mtx_);
        if (relay_sock_ == SRT_INVALID_SOCK) return -1;
        SRT_TRACEBSTATS st{};
        return srt_bistats(relay_sock_, &st, 0, 1) == 0 ? st.msRTT : -1;
    }

private:
    static constexpr int kMsg = 1316;   // 7 TS packets per SRT message

    // false = socket is gone and must be dropped. A full send buffer only drops this message.
    static bool push(SRTSOCKET s, const uint8_t* d, int len) {
        if (srt_sendmsg(s, reinterpret_cast<const char*>(d), len, -1, 0) != SRT_ERROR) return true;
        return srt_getlasterror(nullptr) == SRT_EASYNCSND;
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

    void relay_loop() {
        const std::string sid = "publish:" + cfg_.relay_name + ":" + cfg_.relay_secret;
        while (!stop_) {
            SRTSOCKET s = srt_create_socket();
            common_opts(s, cfg_.relay_latency_ms);
            srt_setsockflag(s, SRTO_STREAMID, sid.data(), int(sid.size()));
            const int tmo = 2000;
            srt_setsockflag(s, SRTO_CONNTIMEO, &tmo, sizeof(tmo));

            sockaddr_in sa{};
            sa.sin_family = AF_INET;
            sa.sin_port   = htons(uint16_t(cfg_.relay_port));
            if (inet_pton(AF_INET, cfg_.relay_host.c_str(), &sa.sin_addr) != 1) {
                std::fprintf(stderr, "fanout: relay host must be an IPv4 address: %s\n", cfg_.relay_host.c_str());
                srt_close(s);
                return;
            }
            if (srt_connect(s, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) == SRT_ERROR) {
                srt_close(s);
                for (int i = 0; i < 10 && !stop_; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }
            { std::lock_guard<std::mutex> lk(mtx_); relay_sock_ = s; }
            std::fprintf(stderr, "fanout: relay publish up (%s:%d)\n", cfg_.relay_host.c_str(), cfg_.relay_port);
            while (!stop_) {   // send() clears relay_sock_ on failure; also watch the socket state
                std::this_thread::sleep_for(std::chrono::milliseconds(200));
                std::lock_guard<std::mutex> lk(mtx_);
                if (relay_sock_ != s) break;
                if (srt_getsockstate(s) != SRTS_CONNECTED) { srt_close(s); relay_sock_ = SRT_INVALID_SOCK; break; }
            }
            std::fprintf(stderr, "fanout: relay publish down, reconnecting\n");
        }
    }

    FanoutConfig             cfg_;
    mutable std::mutex       mtx_;
    std::vector<SRTSOCKET>   clients_;
    SRTSOCKET                listen_sock_ = SRT_INVALID_SOCK;
    SRTSOCKET                relay_sock_  = SRT_INVALID_SOCK;
    std::atomic<bool>        stop_{false};
    std::atomic<uint64_t>    bytes_{0};
    std::jthread             listener_;
    std::jthread             relay_thread_;
};

} // namespace sdi
