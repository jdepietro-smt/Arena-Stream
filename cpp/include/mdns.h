#pragma once
//
// mDNS (multicast DNS) discovery for Arena Link, so a decoder finds encoders on its own network
// with no directory and no internet.
//
// An encoder with a direct SRT listener advertises one service instance, `_arenalink._udp.local`:
//   PTR  _arenalink._udp.local        -> <id>._arenalink._udp.local
//   SRV  <id>._arenalink._udp.local   -> <host>.local : direct SRT port
//   TXT  id= name= format= source= codec= kbps= rh= rp= rn= v=      (what the directory also carries)
//   A    <host>.local                 -> the address on the interface the packet leaves from
// It answers queries for the service and re-announces every 30 s; on exit it sends the same
// records with TTL 0 so decoders drop it immediately. A decoder browses by multicasting a PTR
// query and caching what it hears, honouring TTLs.
//
// The packet building/parsing is pure (no sockets) and is tested on its own; the Responder and
// Browser classes at the bottom are the thin socket layer. The address a decoder connects to is
// the *source address of the announcement it received*: that is the encoder's address on the
// very network the decoder is on, so it is reachable by construction (a PC with several NICs
// announces on each, and each decoder hears the one on its own side).

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <mstcpip.h>
#else
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace sdi::mdns {

inline constexpr const char* kService = "_arenalink._udp.local";
inline constexpr uint16_t    kPort    = 5353;
inline constexpr const char* kGroup   = "224.0.0.251";

struct Service {
    std::string id, name, format, source, codec;
    int         kbps = 0;
    int         port = 0;                 // direct SRT listener (UDP)
    std::string relay_host, relay_name;   // where the encoder publishes, if it does
    int         relay_port = 0;
    std::vector<std::string> ips;         // addresses we heard it on (first = most trustworthy)
};

// ── wire format ──────────────────────────────────────────────────────────────

namespace wire {

enum : uint16_t { A = 1, PTR = 12, TXT = 16, SRV = 33, ANY = 255 };

inline void put16(std::vector<uint8_t>& b, uint16_t v) { b.push_back(uint8_t(v >> 8)); b.push_back(uint8_t(v)); }
inline void put32(std::vector<uint8_t>& b, uint32_t v) { put16(b, uint16_t(v >> 16)); put16(b, uint16_t(v)); }

// "a.b.c" -> length-prefixed labels. A label is cut to 63 bytes; dots inside `instance` labels
// are the caller's job to avoid (see label()).
inline void put_name(std::vector<uint8_t>& b, const std::string& name) {
    size_t i = 0;
    while (i < name.size()) {
        size_t j = name.find('.', i);
        if (j == std::string::npos) j = name.size();
        const size_t len = std::min<size_t>(j - i, 63);
        b.push_back(uint8_t(len));
        b.insert(b.end(), name.begin() + long(i), name.begin() + long(i + len));
        i = j + 1;
    }
    b.push_back(0);
}

// One DNS label from arbitrary text: no dots, no control characters, at most 63 bytes.
inline std::string label(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '.') c = '-';
        if (c < 0x20) continue;
        o += char(c);
        if (o.size() >= 63) break;
    }
    return o.empty() ? "encoder" : o;
}

inline void record(std::vector<uint8_t>& b, const std::string& name, uint16_t type, bool flush,
                   uint32_t ttl, const std::vector<uint8_t>& rdata) {
    put_name(b, name);
    put16(b, type);
    put16(b, uint16_t(1 | (flush ? 0x8000 : 0)));
    put32(b, ttl);
    put16(b, uint16_t(rdata.size()));
    b.insert(b.end(), rdata.begin(), rdata.end());
}

inline void header(std::vector<uint8_t>& b, uint16_t flags, uint16_t qd, uint16_t an) {
    put16(b, 0); put16(b, flags); put16(b, qd); put16(b, an); put16(b, 0); put16(b, 0);
}

} // namespace wire

inline std::string instance_name(const Service& s) { return wire::label(s.id) + "." + kService; }

// PTR question for the service.
inline std::vector<uint8_t> build_query() {
    std::vector<uint8_t> b;
    wire::header(b, 0x0000, 1, 0);
    wire::put_name(b, kService);
    wire::put16(b, wire::PTR);
    wire::put16(b, 1);
    return b;
}

// The four records describing `s`, reachable at `ip`. ttl 0 = goodbye.
inline std::vector<uint8_t> build_announce(const Service& s, const std::string& host_label,
                                           const std::string& ip, uint32_t ttl) {
    std::vector<uint8_t> b;
    wire::header(b, 0x8400, 0, 4);
    const std::string inst = instance_name(s);
    const std::string host = wire::label(host_label) + ".local";

    { std::vector<uint8_t> r; wire::put_name(r, inst); wire::record(b, kService, wire::PTR, false, ttl, r); }
    { std::vector<uint8_t> r; wire::put16(r, 0); wire::put16(r, 0); wire::put16(r, uint16_t(s.port)); wire::put_name(r, host);
      wire::record(b, inst, wire::SRV, true, ttl, r); }
    {
        std::vector<uint8_t> r;
        auto kv = [&](const std::string& k, const std::string& v) {
            std::string e = k + "=" + v;
            if (e.size() > 255) e.resize(255);
            r.push_back(uint8_t(e.size()));
            r.insert(r.end(), e.begin(), e.end());
        };
        kv("v", "1"); kv("id", s.id); kv("name", s.name); kv("format", s.format); kv("source", s.source);
        kv("codec", s.codec); kv("kbps", std::to_string(s.kbps));
        if (s.relay_port > 0) { kv("rh", s.relay_host); kv("rp", std::to_string(s.relay_port)); kv("rn", s.relay_name); }
        wire::record(b, inst, wire::TXT, true, ttl, r);
    }
    {
        std::vector<uint8_t> r(4, 0);
        in_addr a{};
        if (inet_pton(AF_INET, ip.c_str(), &a) == 1) std::memcpy(r.data(), &a, 4);
        wire::record(b, host, wire::A, true, ttl, r);
    }
    return b;
}

namespace detail {

struct Reader {
    const uint8_t* p; size_t n;
    bool ok = true;
    uint16_t u16(size_t at) { if (at + 2 > n) { ok = false; return 0; } return uint16_t(p[at] << 8 | p[at + 1]); }
    uint32_t u32(size_t at) { return (uint32_t(u16(at)) << 16) | u16(at + 2); }

    // Reads a (possibly compressed) name starting at `pos`; advances `pos` past it in the
    // *original* position. Bounded: a pointer loop or a long name stops the parse.
    std::string name(size_t& pos) {
        std::string out;
        size_t cur = pos; bool jumped = false; int hops = 0;
        for (;;) {
            if (cur >= n || ++hops > 64) { ok = false; return out; }
            const uint8_t len = p[cur];
            if (len == 0) { ++cur; break; }
            if ((len & 0xC0) == 0xC0) {
                if (cur + 1 >= n) { ok = false; return out; }
                const size_t ptr = size_t((len & 0x3F) << 8 | p[cur + 1]);
                if (!jumped) { pos = cur + 2; jumped = true; }
                cur = ptr;
                continue;
            }
            if ((len & 0xC0) != 0 || cur + 1 + len > n) { ok = false; return out; }
            if (!out.empty()) out += '.';
            out.append(reinterpret_cast<const char*>(p + cur + 1), len);
            cur += 1 + len;
            if (out.size() > 255) { ok = false; return out; }
        }
        if (!jumped) pos = cur;
        return out;
    }
};

inline std::string lower(std::string s) { for (auto& c : s) c = char(std::tolower((unsigned char)c)); return s; }

} // namespace detail

// True when the packet is a query asking for our service.
inline bool is_query_for_service(const uint8_t* d, size_t n) {
    detail::Reader r{d, n};
    if (n < 12) return false;
    const uint16_t flags = r.u16(2), qd = r.u16(4);
    if (flags & 0x8000) return false;
    size_t pos = 12;
    for (uint16_t i = 0; i < qd && r.ok; ++i) {
        const std::string q = r.name(pos);
        const uint16_t type = r.u16(pos); pos += 4;
        if (r.ok && detail::lower(q) == kService && (type == wire::PTR || type == wire::ANY)) return true;
    }
    return false;
}

struct Heard { Service svc; uint32_t ttl = 0; };

// Reads a response and returns the Arena Link instances it describes (ttl 0 = goodbye).
// `src_ip` is the packet's source address and becomes the first entry of `ips`.
inline bool parse_response(const uint8_t* d, size_t n, const std::string& src_ip, std::vector<Heard>& out) {
    out.clear();
    detail::Reader r{d, n};
    if (n < 12) return false;
    const uint16_t flags = r.u16(2);
    if (!(flags & 0x8000)) return false;
    const uint16_t qd = r.u16(4), an = r.u16(6), ns = r.u16(8), ar = r.u16(10);
    size_t pos = 12;
    for (uint16_t i = 0; i < qd && r.ok; ++i) { r.name(pos); pos += 4; }

    std::map<std::string, uint32_t> ptrs;                                   // instance -> ttl
    struct Srv { std::string host; int port = 0; uint32_t ttl = 0; };
    std::map<std::string, Srv> srvs;
    std::map<std::string, std::vector<std::string>> txts;                   // instance -> "k=v"
    std::map<std::string, std::vector<std::string>> addrs;                  // host -> ips

    const int total = an + ns + ar;
    for (int i = 0; i < total && r.ok; ++i) {
        const std::string name = detail::lower(r.name(pos));
        const uint16_t type = r.u16(pos), len = r.u16(pos + 8);
        const uint32_t ttl = r.u32(pos + 4);
        pos += 10;
        if (!r.ok || pos + len > n) return false;
        const size_t rd = pos;
        if (type == wire::PTR && name == kService) {
            size_t q = rd; ptrs[detail::lower(r.name(q))] = ttl;
        } else if (type == wire::SRV && len >= 7) {
            size_t q = rd + 6; Srv s; s.port = r.u16(rd + 4); s.host = detail::lower(r.name(q)); s.ttl = ttl; srvs[name] = s;
        } else if (type == wire::TXT) {
            size_t q = rd;
            while (q < rd + len) {
                const size_t l = d[q++];
                if (q + l > rd + len) break;
                txts[name].emplace_back(reinterpret_cast<const char*>(d + q), l);
                q += l;
            }
        } else if (type == wire::A && len == 4) {
            char b[INET_ADDRSTRLEN];
            if (inet_ntop(AF_INET, d + rd, b, sizeof(b))) addrs[name].push_back(b);
        }
        pos = rd + len;
    }
    if (!r.ok) return false;

    // Instances: from PTR, or from an SRV/TXT of ours that arrived without it.
    const std::string suffix = std::string(".") + kService;
    std::map<std::string, uint32_t> instances = ptrs;
    for (const auto& s : srvs) if (s.first.size() > suffix.size() && s.first.compare(s.first.size() - suffix.size(), suffix.size(), suffix) == 0) instances.emplace(s.first, s.second.ttl);
    for (const auto& [inst, ttl] : instances) {
        Heard h; h.ttl = ttl;
        Service& s = h.svc;
        for (const auto& kv : txts[inst]) {
            const auto eq = kv.find('=');
            if (eq == std::string::npos) continue;
            const std::string k = kv.substr(0, eq), v = kv.substr(eq + 1);
            if (k == "id") s.id = v; else if (k == "name") s.name = v; else if (k == "format") s.format = v;
            else if (k == "source") s.source = v; else if (k == "codec") s.codec = v; else if (k == "kbps") s.kbps = std::atoi(v.c_str());
            else if (k == "rh") s.relay_host = v; else if (k == "rp") s.relay_port = std::atoi(v.c_str()); else if (k == "rn") s.relay_name = v;
        }
        if (auto it = srvs.find(inst); it != srvs.end()) {
            s.port = it->second.port;
            if (auto a = addrs.find(it->second.host); a != addrs.end()) s.ips = a->second;
        }
        if (!src_ip.empty()) { s.ips.erase(std::remove(s.ips.begin(), s.ips.end(), src_ip), s.ips.end()); s.ips.insert(s.ips.begin(), src_ip); }
        if (s.id.empty()) {   // goodbye packets may carry no TXT: recover the id from the instance label
            s.id = inst.substr(0, inst.size() - suffix.size());
        }
        out.push_back(std::move(h));
    }
    return true;
}

// ── sockets ──────────────────────────────────────────────────────────────────

namespace net {

#ifdef _WIN32
using sock_t = SOCKET;
inline constexpr sock_t kBad = INVALID_SOCKET;
inline void close_sock(sock_t s) { closesocket(s); }
inline void init() { static bool done = [] { WSADATA w; WSAStartup(MAKEWORD(2, 2), &w); return true; }(); (void)done; }
#else
using sock_t = int;
inline constexpr sock_t kBad = -1;
inline void close_sock(sock_t s) { ::close(s); }
inline void init() {}
#endif

// Usable IPv4 addresses of this machine: up, multicast-capable, not loopback, not link-local.
inline std::vector<std::string> local_ipv4() {
    init();
    std::vector<std::string> ips;
    auto keep = [&](in_addr a) {
        const uint32_t h = ntohl(a.s_addr);
        if ((h >> 24) == 127 || (h >> 16) == 0xA9FE || h == 0) return;
        char b[INET_ADDRSTRLEN];
        if (inet_ntop(AF_INET, &a, b, sizeof(b))) ips.push_back(b);
    };
#ifdef _WIN32
    sock_t s = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (s == kBad) return ips;
    INTERFACE_INFO info[32];
    DWORD bytes = 0;
    if (WSAIoctl(s, SIO_GET_INTERFACE_LIST, nullptr, 0, info, sizeof(info), &bytes, nullptr, nullptr) == 0) {
        for (DWORD i = 0; i < bytes / sizeof(INTERFACE_INFO); ++i)
            if ((info[i].iiFlags & IFF_UP) && (info[i].iiFlags & IFF_MULTICAST) && !(info[i].iiFlags & IFF_LOOPBACK))
                keep(info[i].iiAddress.AddressIn.sin_addr);
    }
    close_sock(s);
#else
    ifaddrs* list = nullptr;
    if (getifaddrs(&list) == 0) {
        for (ifaddrs* i = list; i; i = i->ifa_next)
            if (i->ifa_addr && i->ifa_addr->sa_family == AF_INET && (i->ifa_flags & IFF_UP) && (i->ifa_flags & IFF_MULTICAST) &&
                !(i->ifa_flags & IFF_LOOPBACK))
                keep(reinterpret_cast<sockaddr_in*>(i->ifa_addr)->sin_addr);
        freeifaddrs(list);
    }
#endif
    return ips;
}

// The shared mDNS receive socket: 0.0.0.0:5353, group joined on every interface.
inline sock_t open_listener(const std::vector<std::string>& ips) {
    init();
    sock_t s = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (s == kBad) return kBad;
    const int yes = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&yes), sizeof(yes));
#ifdef SO_REUSEPORT
    setsockopt(s, SOL_SOCKET, SO_REUSEPORT, reinterpret_cast<const char*>(&yes), sizeof(yes));
#endif
    sockaddr_in a{};
    a.sin_family = AF_INET; a.sin_port = htons(kPort); a.sin_addr.s_addr = INADDR_ANY;
    if (::bind(s, reinterpret_cast<sockaddr*>(&a), sizeof(a)) != 0) { close_sock(s); return kBad; }
    int joined = 0;
    for (const auto& ip : ips) {
        ip_mreq m{};
        inet_pton(AF_INET, kGroup, &m.imr_multiaddr);
        inet_pton(AF_INET, ip.c_str(), &m.imr_interface);
        if (setsockopt(s, IPPROTO_IP, IP_ADD_MEMBERSHIP, reinterpret_cast<const char*>(&m), sizeof(m)) == 0) ++joined;
    }
    if (!joined) { close_sock(s); return kBad; }
    return s;
}

// A send socket pinned to one interface (so the packet's source address is that interface's).
inline sock_t open_sender(const std::string& ip) {
    sock_t s = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (s == kBad) return kBad;
    in_addr ifa{};
    inet_pton(AF_INET, ip.c_str(), &ifa);
    setsockopt(s, IPPROTO_IP, IP_MULTICAST_IF, reinterpret_cast<const char*>(&ifa), sizeof(ifa));
    const int ttl = 255, loop = 1;
    setsockopt(s, IPPROTO_IP, IP_MULTICAST_TTL, reinterpret_cast<const char*>(&ttl), sizeof(ttl));
    setsockopt(s, IPPROTO_IP, IP_MULTICAST_LOOP, reinterpret_cast<const char*>(&loop), sizeof(loop));
    sockaddr_in a{};
    a.sin_family = AF_INET; a.sin_addr = ifa; a.sin_port = 0;
    ::bind(s, reinterpret_cast<sockaddr*>(&a), sizeof(a));
    return s;
}

inline void send_group(sock_t s, const std::vector<uint8_t>& pkt) {
    sockaddr_in to{};
    to.sin_family = AF_INET; to.sin_port = htons(kPort);
    inet_pton(AF_INET, kGroup, &to.sin_addr);
    ::sendto(s, reinterpret_cast<const char*>(pkt.data()), int(pkt.size()), 0, reinterpret_cast<sockaddr*>(&to), sizeof(to));
}

// Waits up to timeout_ms for a datagram. Returns its size (0 = timeout, <0 = error).
inline int recv_from(sock_t s, uint8_t* buf, size_t cap, std::string& src, int timeout_ms) {
    fd_set fds; FD_ZERO(&fds); FD_SET(s, &fds);
    timeval tv{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
    const int r = ::select(int(s) + 1, &fds, nullptr, nullptr, &tv);
    if (r <= 0) return r;
    sockaddr_in from{};
#ifdef _WIN32
    int fl = sizeof(from);
#else
    socklen_t fl = sizeof(from);
#endif
    const int n = int(::recvfrom(s, reinterpret_cast<char*>(buf), int(cap), 0, reinterpret_cast<sockaddr*>(&from), &fl));
    if (n < 0) return n;
    char b[INET_ADDRSTRLEN];
    src = inet_ntop(AF_INET, &from.sin_addr, b, sizeof(b)) ? b : "";
    return n;
}

} // namespace net

// ── Responder (encoder side) ─────────────────────────────────────────────────

class Responder {
public:
    // `describe` is called on every announcement so the kbps etc. stay current.
    Responder(std::string host_label, std::function<Service()> describe)
        : host_(std::move(host_label)), describe_(std::move(describe)) {}
    ~Responder() { stop(); }
    Responder(const Responder&) = delete;
    Responder& operator=(const Responder&) = delete;

    bool start() {
        ips_ = net::local_ipv4();
        listen_ = net::open_listener(ips_);
        if (listen_ == net::kBad) { std::fprintf(stderr, "mdns: cannot listen on UDP 5353 - LAN discovery off\n"); return false; }
        for (const auto& ip : ips_) { auto s = net::open_sender(ip); if (s != net::kBad) senders_.push_back(s); }
        thread_ = std::thread([this] { loop(); });
        return true;
    }

    void stop() {
        if (stop_.exchange(true)) return;
        if (thread_.joinable()) thread_.join();
        if (listen_ != net::kBad) {          // goodbye: decoders drop us at once
            announce(0);
            net::close_sock(listen_); listen_ = net::kBad;
        }
        for (auto s : senders_) net::close_sock(s);
        senders_.clear();
    }

private:
    void announce(uint32_t ttl) {
        const Service svc = describe_();
        for (size_t i = 0; i < senders_.size() && i < ips_.size(); ++i)
            net::send_group(senders_[i], build_announce(svc, host_, ips_[i], ttl));
    }

    void loop() {
        auto last = std::chrono::steady_clock::now() - std::chrono::seconds(60);
        int startup = 0;
        std::vector<uint8_t> buf(9000);
        while (!stop_) {
            const auto now = std::chrono::steady_clock::now();
            // Three quick announcements at start, then every 30 s (TTL 120 s).
            if ((startup < 3 && now - last >= std::chrono::seconds(1)) || now - last >= std::chrono::seconds(30)) {
                announce(120); last = now; ++startup;
            }
            std::string src;
            const int n = net::recv_from(listen_, buf.data(), buf.size(), src, 300);
            if (n > 0 && is_query_for_service(buf.data(), size_t(n)) && now - last_reply_ >= std::chrono::milliseconds(200)) {
                announce(120); last_reply_ = now;
            }
        }
    }

    std::string host_;
    std::function<Service()> describe_;
    std::vector<std::string> ips_;
    std::vector<net::sock_t> senders_;
    net::sock_t listen_ = net::kBad;
    std::atomic<bool> stop_{false};
    std::thread thread_;
    std::chrono::steady_clock::time_point last_reply_{};
};

// ── Browser (decoder side) ───────────────────────────────────────────────────

class Browser {
public:
    Browser() = default;
    ~Browser() { stop(); }
    Browser(const Browser&) = delete;
    Browser& operator=(const Browser&) = delete;

    bool start() {
        ips_ = net::local_ipv4();
        listen_ = net::open_listener(ips_);
        if (listen_ == net::kBad) { std::fprintf(stderr, "mdns: cannot listen on UDP 5353 - LAN discovery off\n"); return false; }
        for (const auto& ip : ips_) { auto s = net::open_sender(ip); if (s != net::kBad) senders_.push_back(s); }
        thread_ = std::thread([this] { loop(); });
        return true;
    }

    void stop() {
        if (stop_.exchange(true)) return;
        if (thread_.joinable()) thread_.join();
        if (listen_ != net::kBad) { net::close_sock(listen_); listen_ = net::kBad; }
        for (auto s : senders_) net::close_sock(s);
        senders_.clear();
    }

    // Encoders currently believed to be on the network (expired ones are gone).
    std::vector<Service> snapshot() const {
        std::lock_guard<std::mutex> lk(m_);
        std::vector<Service> v;
        const auto now = std::chrono::steady_clock::now();
        for (const auto& [id, e] : seen_) if (e.expires > now) v.push_back(e.svc);
        return v;
    }

private:
    struct Entry { Service svc; std::chrono::steady_clock::time_point expires; };

    void query() { const auto q = build_query(); for (auto s : senders_) net::send_group(s, q); }

    void loop() {
        std::vector<uint8_t> buf(9000);
        auto next_query = std::chrono::steady_clock::now();
        int burst = 0;
        while (!stop_) {
            const auto now = std::chrono::steady_clock::now();
            if (now >= next_query) {   // 0 s, 0.5 s, 1.5 s, then every 5 s
                query();
                ++burst;
                next_query = now + (burst == 1 ? std::chrono::milliseconds(500) : burst == 2 ? std::chrono::milliseconds(1000) : std::chrono::seconds(5));
            }
            std::string src;
            const int n = net::recv_from(listen_, buf.data(), buf.size(), src, 200);
            if (n <= 0) continue;
            std::vector<Heard> heard;
            if (!parse_response(buf.data(), size_t(n), src, heard)) continue;
            std::lock_guard<std::mutex> lk(m_);
            for (auto& h : heard) {
                if (h.ttl == 0) { seen_.erase(h.svc.id); continue; }
                auto& e = seen_[h.svc.id];
                // Keep every address we have heard it on, newest first.
                for (const auto& ip : e.svc.ips) if (std::find(h.svc.ips.begin(), h.svc.ips.end(), ip) == h.svc.ips.end()) h.svc.ips.push_back(ip);
                e.svc = std::move(h.svc);
                e.expires = now + std::chrono::seconds(std::min<uint32_t>(h.ttl, 4500));
            }
        }
    }

    std::vector<std::string> ips_;
    std::vector<net::sock_t> senders_;
    net::sock_t listen_ = net::kBad;
    std::atomic<bool> stop_{false};
    std::thread thread_;
    mutable std::mutex m_;
    std::map<std::string, Entry> seen_;
};

} // namespace sdi::mdns
