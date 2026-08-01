#pragma once
//
// PlayoutDevice — vendor-agnostic interface for SDI OUTPUT, symmetric to
// CaptureDevice (see capture_device.h). The decoder harness pushes decoded
// frames in; the backend (AJA or DeckLink) schedules them onto the SDI
// output at the correct cadence via its own internal buffering
// (AutoCirculate for AJA, IDeckLinkOutput's scheduled playback for
// DeckLink) rather than the caller's arrival timing.

#include "frame.h"

#include <memory>
#include <string>
#include <string_view>

namespace sdi {

struct PlayoutConfig {
    // Device identifier — backend-specific format, same convention as
    // CaptureConfig::device_id.
    std::string device_id = "0";

    // Output connection (SDI channel/connector) — same convention as
    // CaptureConfig::connection ("1"-"8" for AJA channel number).
    std::string connection = "1";

    // Video mode to output. Unlike capture, playout must know the format
    // up front — there is no incoming signal to auto-detect from; this is
    // normally set from the decoded stream's own SPS/format metadata once
    // the first frame arrives.
    VideoMode   mode{};

    // Number of audio channels to output (2, 4, 8, or 16).
    uint32_t    audio_channels = 2;

    // AJA only: genlock/reference source. "freerun" (default) is correct
    // for a standalone decoder box with sole use of its card. On AJA
    // hardware the reference selector is typically a BOARD-WIDE setting,
    // not per-channel — if this process's card is shared with another
    // process that already locked the reference to an SDI input (e.g. an
    // encoder capturing on the same card), forcing free-run here yanks the
    // clock out from under it and destabilizes every active channel at
    // once. Set to "input1".."input8" to match whatever the other process
    // already established instead of fighting over it.
    std::string reference = "freerun";
};

// Abstract base. Concrete implementations live in decklink_playout.cpp and
// aja_playout.cpp and are constructed via the factory function below.
class PlayoutDevice {
public:
    virtual ~PlayoutDevice() = default;

    // Start playout in the given mode. Returns false on failure (e.g. the
    // requested mode isn't supported by the card, or the channel is
    // already in use).
    virtual bool start(const PlayoutConfig& cfg) = 0;

    // Stop playout and join internal threads. Safe to call multiple times.
    virtual void stop() = 0;

    // Queue a decoded frame for output. Non-blocking: internally buffered
    // and scheduled by the backend's own hardware clock, not the caller's
    // — decoder arrival jitter (network/decode variance) must never leak
    // onto the SDI output timing that downstream broadcast equipment
    // depends on being rock solid.
    virtual void write_video(VideoFrame&& frame) = 0;
    virtual void write_audio(AudioFrame&& frame) = 0;

    // Human-readable backend name for logging ("decklink", "aja").
    virtual std::string_view backend_name() const = 0;
};

// Backend selector. `kind` is "decklink" or "aja". Returns nullptr if the
// requested backend was not compiled in (see ENABLE_* CMake options).
std::unique_ptr<PlayoutDevice> make_playout(std::string_view kind);

} // namespace sdi
