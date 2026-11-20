#pragma once
//
// SRT forward error correction profiles, shared by the encoder, the decoder and the relay.
//
// FEC sends a few extra parity packets with the video so a receiver can rebuild lost packets without waiting a round trip
// to ask for them again. That is what keeps delay low on a lossy internet link: with FEC a lost packet costs nothing, without
// it the receiver waits at least one round trip (and the SRT latency window must be sized for several).
//
// Both ends of one SRT connection must use the same setting. Plain SRT cannot tell an old program from a new one, so the
// setting travels in the stream id after a "~" ("read:Garden~fec=light"). The relay reads it and applies the same filter to
// its side of that connection; a program that sends nothing gets no FEC, so old apps keep working.
//
// Each hop (encoder to relay, relay to decoder) is protected on its own.
#include <string>

namespace sdi::fec {

// "off" (or anything unknown) -> empty = no FEC.
//   light:    one parity packet per 10 data packets (about 10% extra). Fixes a single lost packet in ten: scattered loss.
//   standard: row and column parity over a 10 x 5 block (about 30% extra). Also fixes short bursts.
// "arq:onreq" keeps normal retransmission as a backstop for what FEC cannot repair.
inline std::string config(const std::string& profile) {
    if (profile == "light")    return "fec,cols:10,rows:1,layout:staircase,arq:onreq";
    if (profile == "standard") return "fec,cols:10,rows:5,layout:staircase,arq:onreq";
    return "";
}
inline bool known(const std::string& profile) { return profile == "off" || profile.empty() || !config(profile).empty(); }

// Stream id with the profile attached: "read:Garden" -> "read:Garden~fec=light". Unchanged when there is no FEC.
inline std::string tag_streamid(const std::string& id, const std::string& profile) {
    return config(profile).empty() ? id : id + "~fec=" + profile;
}
// Splits "publish:Garden:secret~fec=light" into "publish:Garden:secret" and "light" ("" if none).
inline std::string split_streamid(const std::string& sid, std::string& profile) {
    profile.clear();
    const auto t = sid.find('~');
    if (t == std::string::npos) return sid;
    const std::string opt = sid.substr(t + 1);
    if (opt.rfind("fec=", 0) == 0) profile = opt.substr(4);
    return sid.substr(0, t);
}

} // namespace sdi::fec
