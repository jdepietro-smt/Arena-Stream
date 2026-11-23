// srt_relay — minimal low-latency SRT fan-out relay.
//
// mediamtx re-muxes every stream (SRT in -> MPEG-TS demux -> remux -> SRT out),
// which measured ~300 ms on top of the SRT windows. This relay does none of
// that: each SRT message a publisher sends is handed, unparsed, to every
// reader of the same name, so end-to-end delay is just the two SRT latency
// windows. It sits beside mediamtx on its own port; nothing else changes.
//
//   publisher:  srt://HOST:PORT?streamid=publish:NAME:SECRET&mode=caller
//   reader:     srt://HOST:PORT?streamid=read:NAME&mode=caller
//
// Environment: LL_PORT (8895)  LL_LATENCY_MS (40, floor: each peer's own latency setting wins when higher)
//              LL_PUBLISH_SECRET (required to publish)
//              LL_MIRROR (optional "host:port", normally 127.0.0.1:8890): also push a copy of every published stream into mediamtx as
//              publish:NAME, so the Arena Hub (which only reads mediamtx) lists, previews and records it. The copy uses LL_PUBLISH_SECRET
//              as the SRT passphrase, the same one mediamtx asks publishers for. It is best effort and never delays or stalls the relay.
#include <srt/srt.h>

#include "../include/fec_profile.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#endif

namespace {

std::atomic<bool> g_stop{false};
void on_signal(int) { g_stop = true; }

std::mutex                               g_mtx;
std::map<std::string, std::vector<SRTSOCKET>> g_readers;   // name -> reader sockets
std::map<std::string, SRTSOCKET>         g_publishers;     // name -> publisher socket
std::string                              g_secret;
std::string                              g_mirror_host;   // empty = no mirror
int                                      g_mirror_port = 0;

// A best-effort copy of one stream into mediamtx. Non-blocking: if mediamtx is down or slow the copy is dropped, the relay is unaffected.
struct Mirror {
    SRTSOCKET sock = SRT_INVALID_SOCK;
    std::chrono::steady_clock::time_point next_try{};
    bool logged_up = false;

    void close() { if (sock != SRT_INVALID_SOCK) { srt_close(sock); sock = SRT_INVALID_SOCK; } logged_up = false; }

    void connect_now(const std::string& name) {
        sock = srt_create_socket();
        const int off = 0, yes = 1, payload = 1316, lat = 120;
        srt_setsockflag(sock, SRTO_SNDSYN, &off, sizeof(off));
        srt_setsockflag(sock, SRTO_RCVSYN, &off, sizeof(off));
        srt_setsockflag(sock, SRTO_TSBPDMODE, &yes, sizeof(yes));
        srt_setsockflag(sock, SRTO_PAYLOADSIZE, &payload, sizeof(payload));
        srt_setsockflag(sock, SRTO_PEERLATENCY, &lat, sizeof(lat));
        srt_setsockflag(sock, SRTO_RCVLATENCY, &lat, sizeof(lat));
        const std::string sid = "publish:" + name;
        srt_setsockflag(sock, SRTO_STREAMID, sid.data(), int(sid.size()));
        if (g_secret.size() >= 10) srt_setsockflag(sock, SRTO_PASSPHRASE, g_secret.data(), int(g_secret.size()));
        sockaddr_in a{};
        a.sin_family = AF_INET; a.sin_port = htons(uint16_t(g_mirror_port));
        inet_pton(AF_INET, g_mirror_host.c_str(), &a.sin_addr);
        if (srt_connect(sock, reinterpret_cast<sockaddr*>(&a), sizeof(a)) == SRT_ERROR) close();
    }

    void send(const std::string& name, const char* data, int n) {
        const auto now = std::chrono::steady_clock::now();
        if (sock == SRT_INVALID_SOCK) {
            if (now < next_try) return;
            next_try = now + std::chrono::seconds(2);
            connect_now(name);
            if (sock == SRT_INVALID_SOCK) return;
        }
        const SRT_SOCKSTATUS st = srt_getsockstate(sock);
        if (st == SRTS_CONNECTING) return;
        if (st != SRTS_CONNECTED) { close(); return; }
        if (!logged_up) { logged_up = true; std::fprintf(stderr, "relay: mirror to mediamtx up: %s\n", name.c_str()); }
        if (srt_sendmsg(sock, data, n, -1, 0) == SRT_ERROR) {
            if (srt_getlasterror(nullptr) != SRT_EASYNCSND) close();
        }
    }
};

struct Id { std::string role, name, secret; };

Id parse_id(const std::string& sid) {
    Id id;
    const auto a = sid.find(':');
    if (a == std::string::npos) return id;
    id.role = sid.substr(0, a);
    const auto b = sid.find(':', a + 1);
    id.name = sid.substr(a + 1, b == std::string::npos ? std::string::npos : b - a - 1);
    if (b != std::string::npos) id.secret = sid.substr(b + 1);
    return id;
}

bool name_ok(const std::string& n) {
    if (n.empty() || n.size() > 128) return false;
    for (unsigned char c : n)
        if (!(isalnum(c) || c == '_' || c == '-' || c == '.')) return false;
    return true;
}

// Runs inside srt_accept's handshake: reject bad ids before a socket exists.
int listen_cb(void*, SRTSOCKET ns, int, const struct sockaddr*, const char* streamid) {
    // "read:NAME~fec=light": the peer asked for forward error correction on this connection (see fec_profile.h).
    std::string fec_profile;
    const Id id = parse_id(sdi::fec::split_streamid(streamid ? streamid : "", fec_profile));
    if (!name_ok(id.name)) return -1;
    if (!fec_profile.empty() && fec_profile != "off") {
        const std::string cfg = sdi::fec::config(fec_profile);
        if (cfg.empty() || srt_setsockflag(ns, SRTO_PACKETFILTER, cfg.data(), int(cfg.size())) == SRT_ERROR) {
            std::fprintf(stderr, "relay: refused %s: unusable FEC request '%s'\n", id.name.c_str(), fec_profile.c_str());
            return -1;
        }
    }
    if (id.role == "publish") {
        if (!g_secret.empty() && id.secret != g_secret) return -1;
        return 0;
    }
    if (id.role == "read") {
        // Readers must never be able to stall a publisher: non-blocking send,
        // overflow is dropped (live-mode semantics).
        const int off = 0;
        srt_setsockflag(ns, SRTO_SNDSYN, &off, sizeof(off));
        return 0;
    }
    return -1;
}

void drop_reader(const std::string& name, SRTSOCKET s) {
    auto it = g_readers.find(name);
    if (it != g_readers.end()) {
        auto& v = it->second;
        for (size_t i = 0; i < v.size(); ++i) if (v[i] == s) { v.erase(v.begin() + long(i)); break; }
        if (v.empty()) g_readers.erase(it);
    }
    srt_close(s);
}

void publisher_loop(std::string name, SRTSOCKET pub) {
    std::fprintf(stderr, "relay: publisher up: %s\n", name.c_str());
    std::vector<char> buf(1500);
    uint64_t pkts = 0;
    Mirror mirror;
    while (!g_stop) {
        const int n = srt_recvmsg(pub, buf.data(), int(buf.size()));
        if (n == SRT_ERROR) break;
        if (n == 0) continue;
        ++pkts;
        if (!g_mirror_host.empty()) mirror.send(name, buf.data(), n);   // outside the lock: it may take a moment, readers must not wait on it
        std::lock_guard<std::mutex> lk(g_mtx);
        auto it = g_readers.find(name);
        if (it == g_readers.end()) continue;
        auto readers = it->second;   // copy: drop_reader edits the original
        for (SRTSOCKET r : readers) {
            if (srt_sendmsg(r, buf.data(), n, -1, 0) != SRT_ERROR) continue;
            const int err = srt_getlasterror(nullptr);
            if (err == SRT_EASYNCSND) continue;                 // reader too slow: drop this packet
            std::fprintf(stderr, "relay: reader left: %s\n", name.c_str());
            drop_reader(name, r);
        }
    }
    {
        std::lock_guard<std::mutex> lk(g_mtx);
        auto it = g_publishers.find(name);
        if (it != g_publishers.end() && it->second == pub) g_publishers.erase(it);
        // Readers stay connected; they resume when the publisher reconnects.
    }
    mirror.close();
    srt_close(pub);
    std::fprintf(stderr, "relay: publisher gone: %s (%llu packets)\n", name.c_str(), (unsigned long long)pkts);
}

} // namespace

int main() {
    srt_setloglevel(3);   // errors only: clients that probe the round trip are refused on purpose, and libsrt would log each one as a warning
    const char* e;
    const int port    = (e = std::getenv("LL_PORT"))        ? std::atoi(e) : 8895;
    const int latency = (e = std::getenv("LL_LATENCY_MS"))  ? std::atoi(e) : 40;
    g_secret          = (e = std::getenv("LL_PUBLISH_SECRET")) ? e : "";
    if ((e = std::getenv("LL_MIRROR")) && *e) {
        const std::string m = e;
        const auto c = m.rfind(':');
        if (c != std::string::npos) { g_mirror_host = m.substr(0, c); g_mirror_port = std::atoi(m.c_str() + c + 1); }
        if (g_mirror_host.empty() || g_mirror_port <= 0) { g_mirror_host.clear(); std::fprintf(stderr, "relay: LL_MIRROR '%s' ignored (want host:port)\n", m.c_str()); }
        else std::fprintf(stderr, "relay: mirroring every stream to mediamtx at %s:%d\n", g_mirror_host.c_str(), g_mirror_port);
    }
    if (g_secret.empty())
        std::fprintf(stderr, "relay: WARNING LL_PUBLISH_SECRET unset - anyone can publish\n");

    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    srt_startup();
    SRTSOCKET lis = srt_create_socket();
    const int yes = 1, payload = 1316;
    srt_setsockflag(lis, SRTO_RCVLATENCY,  &latency, sizeof(latency));
    srt_setsockflag(lis, SRTO_PEERLATENCY, &latency, sizeof(latency));
    srt_setsockflag(lis, SRTO_PAYLOADSIZE, &payload, sizeof(payload));
    srt_setsockflag(lis, SRTO_TSBPDMODE,   &yes, sizeof(yes));
    srt_setsockflag(lis, SRTO_TLPKTDROP,   &yes, sizeof(yes));
    srt_listen_callback(lis, listen_cb, nullptr);

    sockaddr_in sa{};
    sa.sin_family = AF_INET; sa.sin_port = htons(uint16_t(port)); sa.sin_addr.s_addr = INADDR_ANY;
    if (srt_bind(lis, reinterpret_cast<sockaddr*>(&sa), sizeof(sa)) == SRT_ERROR ||
        srt_listen(lis, 16) == SRT_ERROR) {
        std::fprintf(stderr, "relay: cannot listen on :%d: %s\n", port, srt_getlasterror_str());
        return 1;
    }
    std::fprintf(stderr, "relay: listening on UDP :%d, latency %d ms\n", port, latency);

    std::vector<std::thread> threads;
    while (!g_stop) {
        sockaddr_storage peer{};
        int plen = sizeof(peer);
        SRTSOCKET s = srt_accept(lis, reinterpret_cast<sockaddr*>(&peer), &plen);
        if (s == SRT_INVALID_SOCK) { if (g_stop) break; std::this_thread::sleep_for(std::chrono::milliseconds(50)); continue; }

        char sid[512]; int sl = sizeof(sid);
        std::memset(sid, 0, sizeof(sid));
        srt_getsockflag(s, SRTO_STREAMID, sid, &sl);
        std::string fec_unused;
        const Id id = parse_id(sdi::fec::split_streamid(sid, fec_unused));   // the "~fec=..." request was already applied at the handshake

        if (id.role == "publish") {
            std::lock_guard<std::mutex> lk(g_mtx);
            auto old = g_publishers.find(id.name);
            if (old != g_publishers.end()) srt_close(old->second);   // newest publisher wins
            g_publishers[id.name] = s;
            threads.emplace_back(publisher_loop, id.name, s);
        } else {
            std::lock_guard<std::mutex> lk(g_mtx);
            g_readers[id.name].push_back(s);
            std::fprintf(stderr, "relay: reader joined: %s\n", id.name.c_str());
        }
    }
    srt_close(lis);
    for (auto& t : threads) if (t.joinable()) t.join();
    srt_cleanup();
    return 0;
}
