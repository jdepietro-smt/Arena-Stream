#pragma once
//
// Minimal blocking HTTP/1.0 POST/GET over plain TCP, for the encoder's directory
// announcements (one tiny JSON request per second). No TLS, no redirects.

#include <cstdio>
#include <cstring>
#include <string>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

namespace sdi::net {

#ifdef _WIN32
using sock_t = SOCKET;
inline void close_sock(sock_t s) { closesocket(s); }
inline void net_init() { static bool done = [] { WSADATA w; WSAStartup(MAKEWORD(2, 2), &w); return true; }(); (void)done; }
inline constexpr sock_t kBadSock = INVALID_SOCKET;
#else
using sock_t = int;
inline void close_sock(sock_t s) { ::close(s); }
inline void net_init() {}
inline constexpr sock_t kBadSock = -1;
#endif

struct Url { std::string host; int port = 80; };

// "http://host:port[/...]" or "host:port" -> host, port. False if unparseable.
inline bool parse_url(std::string u, Url& out) {
    const auto scheme = u.find("://");
    if (scheme != std::string::npos) u = u.substr(scheme + 3);
    u = u.substr(0, u.find('/'));
    const auto colon = u.rfind(':');
    out.host = u.substr(0, colon);
    out.port = colon == std::string::npos ? 80 : std::atoi(u.c_str() + colon + 1);
    return !out.host.empty() && out.port > 0 && out.port < 65536;
}

// Returns the HTTP status (200, 401, ...) or -1 on a network failure. The response body
// is stored in *resp when given.
inline int http_request(const Url& url, const char* method, const std::string& path, const std::string& key,
                        const std::string& body, std::string* resp = nullptr, int timeout_ms = 1500) {
    net_init();
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(url.host.c_str(), std::to_string(url.port).c_str(), &hints, &res) != 0 || !res) return -1;
    sock_t s = ::socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s == kBadSock) { freeaddrinfo(res); return -1; }
#ifdef _WIN32
    const DWORD tmo = DWORD(timeout_ms);
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&tmo), sizeof(tmo));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&tmo), sizeof(tmo));
#else
    timeval tv{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
    const int cr = ::connect(s, res->ai_addr, int(res->ai_addrlen));
    freeaddrinfo(res);
    if (cr != 0) { close_sock(s); return -1; }

    std::string req = std::string(method) + " " + path + " HTTP/1.0\r\nHost: " + url.host +
                      "\r\nX-Arena-Key: " + key + "\r\nContent-Type: application/json\r\nContent-Length: " +
                      std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
    if (::send(s, req.data(), int(req.size()), 0) != int(req.size())) { close_sock(s); return -1; }

    std::string in;
    char buf[2048];
    for (int n; (n = ::recv(s, buf, sizeof(buf), 0)) > 0;) in.append(buf, size_t(n));
    close_sock(s);

    int status = -1;
    if (in.size() > 12 && in.compare(0, 5, "HTTP/") == 0) status = std::atoi(in.c_str() + 9);
    if (resp) { const auto p = in.find("\r\n\r\n"); *resp = p == std::string::npos ? "" : in.substr(p + 4); }
    return status;
}

// The address this machine would use to reach the internet (no packet is sent).
inline std::string primary_lan_ip() {
    net_init();
    sock_t s = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (s == kBadSock) return "";
    sockaddr_in to{};
    to.sin_family = AF_INET; to.sin_port = htons(53);
    inet_pton(AF_INET, "8.8.8.8", &to.sin_addr);
    std::string ip;
    if (::connect(s, reinterpret_cast<sockaddr*>(&to), sizeof(to)) == 0) {
        sockaddr_in me{};
        socklen_t len = sizeof(me);
        if (getsockname(s, reinterpret_cast<sockaddr*>(&me), &len) == 0) {
            char b[INET_ADDRSTRLEN];
            if (inet_ntop(AF_INET, &me.sin_addr, b, sizeof(b))) ip = b;
        }
    }
    close_sock(s);
    return ip;
}

} // namespace sdi::net
