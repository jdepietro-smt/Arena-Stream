// FEC profile names and how they travel in the SRT stream id. Pure C++, no deps.
#include "fec_profile.h"

#include <cstdio>
#include <cstdlib>

#define CHECK(c) do { if (!(c)) { std::fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); std::exit(1); } } while (0)

using namespace sdi::fec;

int main() {
    CHECK(config("off").empty() && config("").empty() && config("bogus").empty());
    CHECK(config("light").rfind("fec,cols:10,rows:1", 0) == 0);
    CHECK(config("standard").rfind("fec,cols:10,rows:5", 0) == 0);
    CHECK(config("light").find("arq:onreq") != std::string::npos);        // normal retransmission stays as the backstop

    CHECK(known("off") && known("") && known("light") && known("standard") && !known("heavy"));

    // Off adds nothing, so old relays and old apps see exactly what they always saw.
    CHECK(tag_streamid("read:Garden", "off") == "read:Garden");
    CHECK(tag_streamid("read:Garden", "") == "read:Garden");
    CHECK(tag_streamid("read:Garden", "bogus") == "read:Garden");
    CHECK(tag_streamid("read:Garden", "light") == "read:Garden~fec=light");

    std::string prof;
    CHECK(split_streamid("read:Garden~fec=standard", prof) == "read:Garden" && prof == "standard");
    CHECK(split_streamid("publish:Garden:s3cret~fec=light", prof) == "publish:Garden:s3cret" && prof == "light");   // the secret is not eaten
    CHECK(split_streamid("read:Garden", prof) == "read:Garden" && prof.empty());
    CHECK(split_streamid("", prof).empty() && prof.empty());
    CHECK(split_streamid("read:Garden~other=1", prof) == "read:Garden" && prof.empty());                           // unknown options are ignored

    // Round trip.
    CHECK(split_streamid(tag_streamid("publish:A:b", "standard"), prof) == "publish:A:b" && prof == "standard");

    std::puts("fec_profile_test: all checks passed");
    return 0;
}
