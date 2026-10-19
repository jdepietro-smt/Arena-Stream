#pragma once
//
// Codec policy: the one place that decides which encoders to try.
//
// Input is an *encoder request* (what the user asked for) and a *destination
// kind* (where the stream is going); output is an ordered *candidate chain*
// that always ends in libx264, the one encoder that needs no hardware or
// driver. Callers try the chain in order and the first encoder that opens
// wins — opening an encoder is the only test that proves it works, so this
// header deliberately does no probing and has no FFmpeg dependency. That is
// also what makes it testable on its own.
//
// Rules:
//   "gpu" (or empty)  -> H.264 only, vendor-specific first, then the
//                        vendor-neutral Media Foundation path, then libx264.
//   "cpu"             -> libx264.
//   anything else     -> an explicit encoder name: tried on its own, then
//                        libx264. It never walks the GPU chain — an explicit
//                        name means "I asked for this one", and silently
//                        swapping vendors would hide a mistake.
//   AV1 over MPEG-TS  -> refused. MPEG-TS has no usable AV1 signalling in
//                        this FFmpeg build (the video comes out as opaque
//                        private data no receiver can decode), so an AV1
//                        request for an MPEG-TS destination becomes the same
//                        vendor's H.264, then libx264. RTP/RTSP carry AV1
//                        natively and are left alone.

#include <functional>
#include <string>
#include <vector>

namespace sdi::codec_policy {

enum class DestKind {
    None,     // preview only; nothing is sent anywhere
    MpegTs,   // SRT or UDP — everything except RTP/RTSP is wrapped in MPEG-TS
    Rtp,      // rtp:// or rtsp://
};

inline constexpr const char* kSoftware = "libx264";

inline bool is_av1(const std::string& name) {
    return name.find("av1") != std::string::npos;
}

// The same vendor's H.264 encoder for a vendor-specific encoder name, or ""
// when the name doesn't belong to a known vendor.
inline std::string h264_for_vendor(const std::string& name) {
    if (name.find("nvenc") != std::string::npos) return "h264_nvenc";
    if (name.find("qsv")   != std::string::npos) return "h264_qsv";
    if (name.find("amf")   != std::string::npos) return "h264_amf";
    return "";
}

inline bool is_rtp_family(const std::string& uri) {
    return uri.rfind("rtsp://", 0) == 0 || uri.rfind("rtp://", 0) == 0;
}

// Destination kind for the primary (and optional secondary, for dual-path
// output) destination. A bare host:port is SRT, so MPEG-TS.
inline DestKind dest_kind(const std::string& primary, const std::string& secondary = {}) {
    if (primary.empty() || primary == "none") return DestKind::None;
    const bool primary_ts   = !is_rtp_family(primary);
    const bool secondary_ts = !secondary.empty() && !is_rtp_family(secondary);
    return (primary_ts || secondary_ts) ? DestKind::MpegTs : DestKind::Rtp;
}

inline bool is_auto(const std::string& request) {
    return request.empty() || request == "gpu" || request == "cpu";
}

// True when this request can't be carried by the destination as asked and
// will be replaced (callers use it to log the swap).
inline bool refused(const std::string& request, DestKind kind) {
    return kind == DestKind::MpegTs && is_av1(request);
}

inline std::vector<std::string> candidate_chain(const std::string& request, DestKind kind) {
    if (request.empty() || request == "gpu")
        return { "h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", kSoftware };
    if (request == "cpu" || request == kSoftware)
        return { kSoftware };

    if (refused(request, kind)) {
        const std::string h264 = h264_for_vendor(request);
        if (!h264.empty()) return { h264, kSoftware };
        return { kSoftware };
    }
    return { request, kSoftware };
}

// First encoder in the chain that `available` accepts, or "" if none do.
// `available` is whatever the caller uses to test an encoder (the real FFmpeg
// probe in --list-codecs, a fake in tests).
inline std::string first_available(const std::vector<std::string>& chain,
                                   const std::function<bool(const std::string&)>& available) {
    for (const auto& name : chain)
        if (available(name)) return name;
    return "";
}

} // namespace sdi::codec_policy
