// Directory parsing and path choice for the Arena Link decoder. Pure C++, no deps.
#include "link_paths.h"

#include <cstdio>
#include <cstdlib>

#define CHECK(c) do { if (!(c)) { std::fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); std::exit(1); } } while (0)

using namespace sdi::link;

static const char* kBody = R"({"yourIp":"203.0.113.9","encoders":[
 {"id":"a","name":"ESPN","format":"1920x1080p@59.94","source":"1920x1080i@59.94","codec":"h264_nvenc","kbps":10000,
  "lanIps":["10.0.0.5"],"directPort":4200,"relay":{"port":8895,"name":"ESPN"},"pubIp":"203.0.113.9","ageMs":300},
 {"id":"b","name":"CBS \"Sports\"","format":"1280x720p@60","codec":"h264_nvenc","kbps":8000,
  "lanIps":["172.16.1.2"],"directPort":4200,"relay":{"port":8895,"name":"CBS","host":"198.51.100.7"},"pubIp":"198.51.100.20"},
 {"id":"c","name":"LANONLY","lanIps":["10.0.0.6"],"directPort":4201,"relay":null,"pubIp":"198.51.100.20"},
 {"name":"no id"}
]})";

int main() {
    std::vector<EncoderInfo> list; std::string me;
    CHECK(parse_encoders(kBody, list, me));
    CHECK(me == "203.0.113.9");
    CHECK(list.size() == 3);                       // the entry without an id is dropped
    CHECK(list[1].name == "CBS \"Sports\"");       // escapes decoded
    CHECK(list[0].source == "1920x1080i@59.94");

    PathPolicy pol; pol.directory_host = "5.78.236.254";

    // Same public IP -> LAN first, relay as fallback.
    auto a = choose_paths(list[0], me, pol);
    CHECK(a.size() == 2 && a[0].kind == "lan" && a[0].url == "srt://10.0.0.5:4200" && a[0].latency_ms == 40);
    CHECK(a[1].kind == "relay" && a[1].url == "srt://5.78.236.254:8895?streamid=read:ESPN" && a[1].latency_ms == 100);

    // Different public IP -> relay only; announce's own relay host wins over the directory's.
    auto b = choose_paths(list[1], me, pol);
    CHECK(b.size() == 1 && b[0].kind == "relay" && b[0].url == "srt://198.51.100.7:8895?streamid=read:CBS");

    // LAN-only encoder seen from another network -> nothing reachable.
    CHECK(choose_paths(list[2], me, pol).empty());
    // ...but from its own network it is reachable.
    auto c = choose_paths(list[2], "198.51.100.20", pol);
    CHECK(c.size() == 1 && c[0].url == "srt://10.0.0.6:4201");
    // Unknown own IP never claims "same network".
    CHECK(choose_paths(list[0], "", pol).size() == 1);

    CHECK(find_encoder(list, "")->id == "a");
    CHECK(find_encoder(list, "espn")->id == "a");
    CHECK(find_encoder(list, "B")->id == "b");
    CHECK(find_encoder(list, "nope") == nullptr);
    CHECK(find_encoder({}, "") == nullptr);

    // Malformed input is rejected, not crashed on.
    CHECK(!parse_encoders("{", list, me));
    CHECK(!parse_encoders("[]", list, me));
    CHECK(!parse_encoders("{\"encoders\":5}", list, me));
    CHECK(!parse_encoders("{\"encoders\":[]} trailing", list, me));
    CHECK(parse_encoders("{\"yourIp\":\"1.2.3.4\",\"encoders\":[]}", list, me) && list.empty());

    std::puts("link_paths_test: all checks passed");
    return 0;
}
