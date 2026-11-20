#pragma once
//
// Arena Link decoder: turn the directory's encoder list into connection candidates.
//
// Rule: an encoder that announced from the same public IP as this decoder is on the
// same network, so connect straight to its LAN address; otherwise go through the
// relay. Candidates come back in the order to try; the caller falls through the list.

#include "mini_json.h"

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

namespace sdi::link {

struct EncoderInfo {
    std::string id, name, format, source, codec, pub_ip;
    int         kbps        = 0;
    std::vector<std::string> lan_ips;
    int         direct_port = 0;
    std::string relay_host;           // empty = use the directory's host
    int         relay_port  = 0;      // 0 = encoder isn't publishing to a relay
    std::string relay_name;
    bool        local = false;        // heard on this network by mDNS: its LAN address is reachable
    struct Relay { std::string host; int port = 0; };
    std::vector<Relay> more_relays;   // further relays that carry the same stream (failover); tried after the first
};

struct Path {
    std::string kind;                 // "lan" | "relay"
    std::string url;                  // srt://...
    int         latency_ms = 0;
};

struct PathPolicy {
    std::string directory_host;       // relay lives here unless the announce says otherwise
    int         lan_latency_ms   = 40;
    int         relay_latency_ms = 100;
};

// Parses GET /v1/encoders. False if the body isn't the expected shape.
inline bool parse_encoders(const std::string& body, std::vector<EncoderInfo>& out, std::string& your_ip) {
    json::Value root;
    if (!json::parse(body, root) || root.type != json::Value::Obj) return false;
    const json::Value* list = root.get("encoders");
    if (!list || list->type != json::Value::Arr) return false;
    your_ip = root.str("yourIp");
    out.clear();
    for (const json::Value& e : list->a) {
        if (e.type != json::Value::Obj) continue;
        EncoderInfo i;
        i.id = e.str("id"); i.name = e.str("name"); i.format = e.str("format");
        i.source = e.str("source"); i.codec = e.str("codec"); i.pub_ip = e.str("pubIp");
        i.kbps = int(e.num("kbps")); i.direct_port = int(e.num("directPort"));
        if (const json::Value* ips = e.get("lanIps"); ips && ips->type == json::Value::Arr)
            for (const auto& ip : ips->a) if (ip.type == json::Value::Str && !ip.s.empty()) i.lan_ips.push_back(ip.s);
        if (const json::Value* r = e.get("relay"); r && r->type == json::Value::Obj) {
            i.relay_port = int(r->num("port"));
            i.relay_name = r->str("name");
            i.relay_host = r->str("host");
        }
        // "relays" lists every relay the encoder publishes to, the first being the same as "relay" (older decoders
        // read only that one). The rest are failover targets.
        if (const json::Value* rs = e.get("relays"); rs && rs->type == json::Value::Arr)
            for (size_t k = 1; k < rs->a.size(); ++k)
                if (rs->a[k].type == json::Value::Obj && int(rs->a[k].num("port")) > 0)
                    i.more_relays.push_back({rs->a[k].str("host"), int(rs->a[k].num("port"))});
        if (!i.id.empty() && !i.name.empty()) out.push_back(std::move(i));
    }
    return true;
}

inline std::vector<Path> choose_paths(const EncoderInfo& e, const std::string& your_ip, const PathPolicy& p) {
    std::vector<Path> out;
    const bool same_net = (e.local || (!your_ip.empty() && e.pub_ip == your_ip)) && !e.lan_ips.empty() && e.direct_port > 0;
    if (same_net)
        out.push_back({"lan", "srt://" + e.lan_ips.front() + ":" + std::to_string(e.direct_port), p.lan_latency_ms});
    if (e.relay_port > 0 && !e.relay_name.empty()) {
        const std::string host = e.relay_host.empty() ? p.directory_host : e.relay_host;
        out.push_back({"relay", "srt://" + host + ":" + std::to_string(e.relay_port) + "?streamid=read:" + e.relay_name,
                       p.relay_latency_ms});
        for (const auto& r : e.more_relays) {
            const std::string h = r.host.empty() ? p.directory_host : r.host;
            out.push_back({"relay", "srt://" + h + ":" + std::to_string(r.port) + "?streamid=read:" + e.relay_name,
                           p.relay_latency_ms});
        }
    }
    return out;
}

// After a relay has worked, try it again before the others: switching back and forth between relays on every
// reconnect would cost a connect timeout each time. A LAN path stays first. `last_ok` is the url that was live.
inline void prefer_last_good(std::vector<Path>& paths, const std::string& last_ok) {
    if (last_ok.empty()) return;
    auto it = std::find_if(paths.begin(), paths.end(), [&](const Path& x) { return x.kind == "relay" && x.url == last_ok; });
    if (it == paths.end()) return;
    auto first_relay = std::find_if(paths.begin(), paths.end(), [](const Path& x) { return x.kind == "relay"; });
    if (it != first_relay) std::rotate(first_relay, it, it + 1);
}

// After a relay failed to go live, try the others first next time: the failed one goes last among the relays.
inline void demote_failed(std::vector<Path>& paths, const std::string& failed) {
    auto it = std::find_if(paths.begin(), paths.end(), [&](const Path& x) { return x.kind == "relay" && x.url == failed; });
    if (it == paths.end()) return;
    auto last_relay = std::find_if(paths.rbegin(), paths.rend(), [](const Path& x) { return x.kind == "relay"; }).base();
    if (it + 1 != last_relay) std::rotate(it, it + 1, last_relay);
}

// Selector matches id or name, case-insensitively. Empty selector picks the first encoder.
inline const EncoderInfo* find_encoder(const std::vector<EncoderInfo>& list, const std::string& sel) {
    if (list.empty()) return nullptr;
    if (sel.empty()) return &list.front();
    auto eq = [](const std::string& a, const std::string& b) {
        return a.size() == b.size() &&
               std::equal(a.begin(), a.end(), b.begin(), [](unsigned char x, unsigned char y) { return std::tolower(x) == std::tolower(y); });
    };
    for (const auto& e : list) if (eq(e.id, sel) || eq(e.name, sel)) return &e;
    return nullptr;
}

} // namespace sdi::link
