#pragma once
//
// StatsServer — minimal one-shot-response TCP/HTTP health probe.
//
// Not a real HTTP server: it accepts a connection, writes a single valid
// HTTP/1.1 200 response with a JSON body (produced fresh by calling the
// supplied callback), closes the socket, and waits for the next connection.
// No routing, no keep-alive, no request parsing — anything that connects
// gets the current stats regardless of what it asked for. That's enough for
// a backend poller doing `GET /` every few seconds (the same pattern
// ArenaHub's StatsCollector already uses against mediamtx), without pulling
// in a real HTTP server dependency for a single read-only JSON blob.
//
// Used by sdi_receive so the backend can see path1/path2/output health
// across the network — the existing 5s stderr heartbeat only reaches
// whoever is watching this process's own console.

#include <atomic>
#include <functional>
#include <string>
#include <thread>

namespace sdi {

class StatsServer {
public:
    using JsonProvider = std::function<std::string()>;

    StatsServer(int port, JsonProvider provider);
    ~StatsServer();

    StatsServer(const StatsServer&)            = delete;
    StatsServer& operator=(const StatsServer&) = delete;

    // Starts the accept-loop thread. Returns false if the listen socket
    // couldn't be created/bound (port in use, etc.) — logged to stderr.
    bool start();
    void stop();

private:
    void accept_loop(std::stop_token st);

    int          port_;
    JsonProvider provider_;
    std::atomic<bool> running_{false};
    std::jthread reader_thread_;

    // Platform socket handle, stored as an intptr-sized int to avoid pulling
    // winsock2.h/sys/socket.h into this header — the .cpp includes them.
    long long listen_fd_ = -1;
};

} // namespace sdi
