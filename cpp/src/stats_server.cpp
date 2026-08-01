#include "stats_server.h"

#include <iostream>

#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  pragma comment(lib, "ws2_32.lib")
   using socket_t = SOCKET;
   static constexpr socket_t kInvalidSocket = INVALID_SOCKET;
#else
#  include <arpa/inet.h>
#  include <netinet/in.h>
#  include <sys/socket.h>
#  include <unistd.h>
   using socket_t = int;
   static constexpr socket_t kInvalidSocket = -1;
#  define closesocket close
#endif

namespace sdi {

namespace {
#ifdef _WIN32
struct WinsockInit {
    WinsockInit()  { WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa); }
    ~WinsockInit() { WSACleanup(); }
};
// One process-wide init/cleanup pair, regardless of how many StatsServer
// instances exist — WSAStartup/WSACleanup are refcounted by Winsock itself,
// but there's no reason to call them more than once per process here.
WinsockInit g_winsock_init;
#endif
} // namespace

StatsServer::StatsServer(int port, JsonProvider provider)
    : port_(port), provider_(std::move(provider)) {}

StatsServer::~StatsServer() { stop(); }

bool StatsServer::start() {
    if (running_.load()) return true;

    socket_t fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd == kInvalidSocket) {
        std::cerr << "stats_server: socket() failed\n";
        return false;
    }

    int reuse = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR,
               reinterpret_cast<const char*>(&reuse), sizeof(reuse));

    sockaddr_in addr{};
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(static_cast<uint16_t>(port_));

    if (bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        std::cerr << "stats_server: bind() to port " << port_ << " failed\n";
        closesocket(fd);
        return false;
    }
    if (listen(fd, 8) != 0) {
        std::cerr << "stats_server: listen() failed\n";
        closesocket(fd);
        return false;
    }

    listen_fd_ = static_cast<long long>(fd);
    reader_thread_ = std::jthread([this](std::stop_token st) { accept_loop(st); });
    std::cerr << "stats_server: listening on :" << port_ << "\n";
    return true;
}

void StatsServer::stop() {
    if (listen_fd_ != -1) {
        // Closing the listen socket unblocks accept() in the reader thread.
        closesocket(static_cast<socket_t>(listen_fd_));
        listen_fd_ = -1;
    }
    if (reader_thread_.joinable()) {
        reader_thread_.request_stop();
        reader_thread_.join();
    }
    running_.store(false);
}

void StatsServer::accept_loop(std::stop_token st) {
    running_.store(true);
    const socket_t listen_fd = static_cast<socket_t>(listen_fd_);

    while (!st.stop_requested()) {
        sockaddr_in client_addr{};
#ifdef _WIN32
        int addr_len = sizeof(client_addr);
#else
        socklen_t addr_len = sizeof(client_addr);
#endif
        socket_t client = accept(listen_fd, reinterpret_cast<sockaddr*>(&client_addr), &addr_len);
        if (client == kInvalidSocket) {
            // stop() closing listen_fd_ is what makes accept() return here
            // when shutting down — nothing to log in that case.
            if (!st.stop_requested())
                std::cerr << "stats_server: accept() failed\n";
            break;
        }

        const std::string body = provider_();
        const std::string response =
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: " + std::to_string(body.size()) + "\r\n"
            "Connection: close\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "\r\n" + body;

        send(client, response.data(), static_cast<int>(response.size()), 0);
        closesocket(client);
    }
}

} // namespace sdi
