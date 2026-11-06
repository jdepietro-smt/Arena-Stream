// Tests for mdns.h. Pure packet tests always run; `--live` also runs a Responder and a Browser on this
// machine's real network stack (needs UDP 5353 and a multicast-capable interface).
#include "mdns.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <thread>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); ++failures; } } while (0)

static sdi::mdns::Service sample() {
    sdi::mdns::Service s;
    s.id = "TRUCK-PC-0-1"; s.name = "Truck 1 - Camera 2"; s.format = "1920x1080p@59.94"; s.source = "1920x1080i@59.94";
    s.codec = "hevc_nvenc"; s.kbps = 14000; s.port = 4201;
    s.relay_host = "5.78.236.254"; s.relay_port = 8895; s.relay_name = "Truck 1 - Camera 2";
    return s;
}

int main(int argc, char** argv) {
    using namespace sdi::mdns;
    net::init();

    // Query round trip
    {
        const auto q = build_query();
        CHECK(is_query_for_service(q.data(), q.size()));
        std::vector<Heard> h;
        CHECK(!parse_response(q.data(), q.size(), "", h));
    }

    // Announce -> parse
    {
        const auto pkt = build_announce(sample(), "TRUCK-PC", "192.168.1.50", 120);
        CHECK(pkt.size() < 1400);
        CHECK(!is_query_for_service(pkt.data(), pkt.size()));
        std::vector<Heard> h;
        CHECK(parse_response(pkt.data(), pkt.size(), "192.168.1.50", h));
        CHECK(h.size() == 1);
        if (h.size() == 1) {
            const Service& s = h[0].svc;
            CHECK(h[0].ttl == 120);
            CHECK(s.id == "TRUCK-PC-0-1" && s.name == "Truck 1 - Camera 2" && s.format == "1920x1080p@59.94");
            CHECK(s.source == "1920x1080i@59.94" && s.codec == "hevc_nvenc" && s.kbps == 14000 && s.port == 4201);
            CHECK(s.relay_host == "5.78.236.254" && s.relay_port == 8895 && s.relay_name == "Truck 1 - Camera 2");
            CHECK(s.ips.size() == 1 && s.ips[0] == "192.168.1.50");   // source == A record: no duplicate
        }
        // The packet's source address is trusted first when it differs from the A record (multi-NIC encoder).
        std::vector<Heard> h2;
        CHECK(parse_response(pkt.data(), pkt.size(), "10.0.0.7", h2) && h2.size() == 1);
        if (h2.size() == 1) CHECK(h2[0].svc.ips.size() == 2 && h2[0].svc.ips[0] == "10.0.0.7" && h2[0].svc.ips[1] == "192.168.1.50");
    }
    // Goodbye
    {
        const auto pkt = build_announce(sample(), "TRUCK-PC", "192.168.1.50", 0);
        std::vector<Heard> h;
        CHECK(parse_response(pkt.data(), pkt.size(), "192.168.1.50", h) && h.size() == 1 && h[0].ttl == 0);
    }
    // No relay: the optional keys are absent
    {
        Service s = sample(); s.relay_port = 0;
        const auto pkt = build_announce(s, "x", "10.0.0.1", 120);
        std::vector<Heard> h;
        CHECK(parse_response(pkt.data(), pkt.size(), "", h) && h.size() == 1 && h[0].svc.relay_port == 0 && h[0].svc.relay_host.empty());
    }
    // Dots and control characters in names don't break the labels
    {
        Service s = sample(); s.id = "a.b\tc";
        const auto pkt = build_announce(s, "my.host", "10.0.0.1", 120);
        std::vector<Heard> h;
        CHECK(parse_response(pkt.data(), pkt.size(), "", h) && h.size() == 1);
    }
    // A very long name is cut, not overflowed
    {
        Service s = sample(); s.name = std::string(400, 'n');
        const auto pkt = build_announce(s, "h", "10.0.0.1", 120);
        std::vector<Heard> h;
        CHECK(parse_response(pkt.data(), pkt.size(), "", h) && h.size() == 1 && h[0].svc.name.size() == 250);
    }

    // Name compression: a hand-built response whose PTR rdata and TXT owner use pointers.
    {
        std::vector<uint8_t> b;
        wire::header(b, 0x8400, 0, 2);
        const size_t svc_at = b.size();
        wire::put_name(b, kService);
        wire::put16(b, wire::PTR); wire::put16(b, 1); wire::put32(b, 120);
        std::vector<uint8_t> rd = {2, 'e', '1', 0xC0, uint8_t(svc_at)};   // "e1" + pointer to the service name
        wire::put16(b, uint16_t(rd.size())); b.insert(b.end(), rd.begin(), rd.end());
        b.insert(b.end(), {2, 'e', '1', 0xC0, uint8_t(svc_at)});          // TXT owner, compressed the same way
        wire::put16(b, wire::TXT); wire::put16(b, 1); wire::put32(b, 120);
        const std::string t = "name=Compressed";
        std::vector<uint8_t> tr; tr.push_back(uint8_t(t.size())); tr.insert(tr.end(), t.begin(), t.end());
        wire::put16(b, uint16_t(tr.size())); b.insert(b.end(), tr.begin(), tr.end());
        std::vector<Heard> h;
        CHECK(parse_response(b.data(), b.size(), "1.2.3.4", h) && h.size() == 1);
        if (h.size() == 1) CHECK(h[0].svc.name == "Compressed" && h[0].svc.id == "e1");
    }

    // Hostile input: truncations, random bytes, a pointer loop. Must not crash or hang.
    {
        const auto pkt = build_announce(sample(), "TRUCK-PC", "192.168.1.50", 120);
        std::vector<Heard> h;
        for (size_t n = 0; n <= pkt.size(); ++n) { parse_response(pkt.data(), n, "", h); is_query_for_service(pkt.data(), n); }
        std::mt19937 rng(1);
        for (int i = 0; i < 20000; ++i) {
            std::vector<uint8_t> junk = pkt;
            for (int k = 0; k < 6; ++k) junk[rng() % junk.size()] = uint8_t(rng());
            parse_response(junk.data(), junk.size(), "", h);
        }
        std::vector<uint8_t> loop(12, 0);
        loop[2] = 0x84; loop[7] = 1;                          // response, 1 answer
        loop.push_back(0xC0); loop.push_back(12);             // name -> itself
        loop.insert(loop.end(), 10, 0);
        CHECK(!parse_response(loop.data(), loop.size(), "", h));
    }

    // Live: encoder-side Responder and decoder-side Browser on this machine's real network stack.
    if (argc > 1 && std::string(argv[1]) == "--live") {
        std::puts("live: starting responder and browser...");
        std::atomic<int> kbps{9000};
        Responder resp("TESTHOST", [&] { Service s = sample(); s.id = "LIVE-TEST-0-1"; s.name = "Live test"; s.kbps = kbps; return s; });
        Browser br;
        const bool r_ok = resp.start(), b_ok = br.start();
        CHECK(r_ok); CHECK(b_ok);
        bool found = false; Service got;
        for (int i = 0; i < 40 && !found; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            for (const auto& s : br.snapshot()) if (s.id == "LIVE-TEST-0-1") { found = true; got = s; }
        }
        CHECK(found);
        if (found) {
            std::printf("live: found '%s' port %d kbps %d at", got.name.c_str(), got.port, got.kbps);
            for (const auto& ip : got.ips) std::printf(" %s", ip.c_str());
            std::puts("");
            CHECK(got.name == "Live test" && got.port == 4201 && !got.ips.empty());
        }
        resp.stop();                                           // sends the goodbye
        bool gone = false;
        for (int i = 0; i < 30 && !gone; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            gone = true;
            for (const auto& s : br.snapshot()) if (s.id == "LIVE-TEST-0-1") gone = false;
        }
        CHECK(gone);
        std::puts(gone ? "live: goodbye removed it at once" : "live: still listed after goodbye");
    }

    if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
    std::puts("mdns_test: all passed");
    return 0;
}
