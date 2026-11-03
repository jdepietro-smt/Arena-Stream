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
#include <srt/srt.h>

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
    const Id id = parse_id(streamid ? streamid : "");
    if (!name_ok(id.name)) return -1;
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
    while (!g_stop) {
        const int n = srt_recvmsg(pub, buf.data(), int(buf.size()));
        if (n == SRT_ERROR) break;
        if (n == 0) continue;
        ++pkts;
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
    srt_close(pub);
    std::fprintf(stderr, "relay: publisher gone: %s (%llu packets)\n", name.c_str(), (unsigned long long)pkts);
}

} // namespace

int main() {
    const char* e;
    const int port    = (e = std::getenv("LL_PORT"))        ? std::atoi(e) : 8895;
    const int latency = (e = std::getenv("LL_LATENCY_MS"))  ? std::atoi(e) : 40;
    g_secret          = (e = std::getenv("LL_PUBLISH_SECRET")) ? e : "";
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
        const Id id = parse_id(sid);

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
