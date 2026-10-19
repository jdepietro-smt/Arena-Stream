// Tests for codec_policy.h. Plain asserts, no framework: exits non-zero on
// the first failure. The policy is a pure decision over (request, destination),
// so nothing here touches FFmpeg or hardware; "which encoders opened" is
// supplied by a fake.

#include "codec_policy.h"

#include <cstdio>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>

using namespace sdi::codec_policy;
using Chain = std::vector<std::string>;

static int failures = 0;

static std::string show(const Chain& c) {
    std::string s = "[";
    for (size_t i = 0; i < c.size(); ++i) s += (i ? ", " : "") + c[i];
    return s + "]";
}

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
            ++failures;                                                      \
        }                                                                    \
    } while (0)

#define CHECK_CHAIN(actual, ...)                                             \
    do {                                                                     \
        const Chain expected = __VA_ARGS__;                                  \
        if ((actual) != expected) {                                          \
            std::fprintf(stderr, "FAIL %s:%d\n  got      %s\n  expected %s\n", \
                         __FILE__, __LINE__, show(actual).c_str(), show(expected).c_str()); \
            ++failures;                                                      \
        }                                                                    \
    } while (0)

int main() {
    // --- gpu: H.264 only, vendor-specific first, MF, then software -------------
    const Chain gpu = { "h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264" };
    CHECK_CHAIN(candidate_chain("gpu", DestKind::MpegTs), gpu);
    CHECK_CHAIN(candidate_chain("gpu", DestKind::Rtp),    gpu);
    CHECK_CHAIN(candidate_chain("gpu", DestKind::None),   gpu);
    CHECK_CHAIN(candidate_chain("",    DestKind::MpegTs), gpu);   // empty means gpu

    // --- cpu --------------------------------------------------------------------
    CHECK_CHAIN(candidate_chain("cpu", DestKind::MpegTs), { "libx264" });
    CHECK_CHAIN(candidate_chain("libx264", DestKind::MpegTs), { "libx264" });

    // --- explicit names: own choice, then libx264; never the GPU chain ----------
    CHECK_CHAIN(candidate_chain("h264_qsv",   DestKind::MpegTs), { "h264_qsv", "libx264" });
    CHECK_CHAIN(candidate_chain("hevc_nvenc", DestKind::MpegTs), { "hevc_nvenc", "libx264" });
    CHECK_CHAIN(candidate_chain("libx265",    DestKind::MpegTs), { "libx265", "libx264" });

    // --- AV1 over MPEG-TS is refused: same vendor's H.264, then software --------
    CHECK(refused("av1_nvenc", DestKind::MpegTs));
    CHECK(!refused("av1_nvenc", DestKind::Rtp));
    CHECK(!refused("av1_nvenc", DestKind::None));
    CHECK(!refused("h264_nvenc", DestKind::MpegTs));
    CHECK_CHAIN(candidate_chain("av1_nvenc", DestKind::MpegTs), { "h264_nvenc", "libx264" });
    CHECK_CHAIN(candidate_chain("av1_qsv",   DestKind::MpegTs), { "h264_qsv",   "libx264" });
    CHECK_CHAIN(candidate_chain("av1_amf",   DestKind::MpegTs), { "h264_amf",   "libx264" });
    CHECK_CHAIN(candidate_chain("libsvtav1", DestKind::MpegTs), { "libx264" });   // no vendor to keep
    // ...and left alone where the container carries it.
    CHECK_CHAIN(candidate_chain("av1_nvenc", DestKind::Rtp),  { "av1_nvenc", "libx264" });
    CHECK_CHAIN(candidate_chain("av1_nvenc", DestKind::None), { "av1_nvenc", "libx264" });

    // --- every chain ends in software, so a stream always has somewhere to land --
    for (const char* req : { "gpu", "cpu", "", "h264_qsv", "hevc_amf", "av1_nvenc", "libx265", "nonsense" })
        for (DestKind k : { DestKind::None, DestKind::MpegTs, DestKind::Rtp })
            CHECK(candidate_chain(req, k).back() == kSoftware);

    // --- destination kind --------------------------------------------------------
    CHECK(dest_kind("") == DestKind::None);
    CHECK(dest_kind("none") == DestKind::None);
    CHECK(dest_kind("5.78.236.254:8890?streamid=publish:x") == DestKind::MpegTs);  // bare host = SRT
    CHECK(dest_kind("srt://host:1") == DestKind::MpegTs);
    CHECK(dest_kind("udp://host:1") == DestKind::MpegTs);
    CHECK(dest_kind("rtsp://host:8554/x") == DestKind::Rtp);
    CHECK(dest_kind("rtp://host:1") == DestKind::Rtp);
    // Dual-path: if either path is MPEG-TS, the stream has to survive MPEG-TS.
    CHECK(dest_kind("rtsp://a/x", "srt://b:1") == DestKind::MpegTs);
    CHECK(dest_kind("rtsp://a/x", "rtp://b:1") == DestKind::Rtp);

    // --- first_available with a fake probe -----------------------------------------
    {
        // NVIDIA box: only nvenc and software open.
        const std::set<std::string> opens = { "h264_nvenc", "libx264" };
        auto probe = [&](const std::string& n) { return opens.count(n) > 0; };
        CHECK(first_available(candidate_chain("gpu", DestKind::None), probe) == "h264_nvenc");
        CHECK(first_available(candidate_chain("cpu", DestKind::None), probe) == "libx264");
    }
    {
        // Intel-only box: nvenc can't open, QSV can.
        const std::set<std::string> opens = { "h264_qsv", "libx264" };
        auto probe = [&](const std::string& n) { return opens.count(n) > 0; };
        CHECK(first_available(candidate_chain("gpu", DestKind::None), probe) == "h264_qsv");
    }
    {
        // No GPU at all: gpu resolves to the software end of the chain.
        const std::set<std::string> opens = { "libx264" };
        auto probe = [&](const std::string& n) { return opens.count(n) > 0; };
        CHECK(first_available(candidate_chain("gpu", DestKind::None), probe) == "libx264");
    }
    {
        // Nothing opens (broken build): no answer rather than a wrong one.
        auto probe = [](const std::string&) { return false; };
        CHECK(first_available(candidate_chain("gpu", DestKind::None), probe).empty());
    }

    if (failures) {
        std::fprintf(stderr, "%d check(s) failed\n", failures);
        return EXIT_FAILURE;
    }
    std::puts("codec_policy: all checks passed");
    return EXIT_SUCCESS;
}
