#pragma once
//
// CaptureDevice — vendor-agnostic interface that DeckLink and AJA backends
// both implement. The main harness selects a backend at runtime based on
// the user's config.

#include "frame.h"

#include <functional>
#include <memory>
#include <string>
#include <string_view>

namespace sdi {

struct CaptureConfig {
    // Device identifier — backend-specific format. For DeckLink this is the
    // device index as a string; for AJA it's an NTV2DeviceID or index.
    std::string device_id = "0";

    // Input connection (SDI, HDMI, etc.) — ignored by some backends.
    std::string connection = "sdi";

    // Requested video format. If auto_detect is true, backend picks what
    // the source provides and populates `detected_mode` on start().
    VideoMode   requested_mode{};
    bool        auto_detect   = true;

    // Number of audio channels to capture (2, 4, 8, or 16).
    uint32_t    audio_channels = 2;
};

// Abstract base. Concrete implementations live in decklink_device.cpp and
// aja_device.cpp and are constructed via the factory functions below.
class CaptureDevice {
public:
    virtual ~CaptureDevice() = default;

    // Start capturing. Callbacks fire from an internal thread owned by the
    // backend; they must not block for long. Returns false on failure.
    virtual bool start(const CaptureConfig& cfg,
                       VideoCallback on_video,
                       AudioCallback on_audio) = 0;

    // Stop capturing and join internal threads. Safe to call multiple times.
    virtual void stop() = 0;

    // The video mode actually in use. Valid after start() returns true.
    virtual VideoMode current_mode() const = 0;

    // Human-readable backend name for logging ("decklink", "aja").
    virtual std::string_view backend_name() const = 0;
};

// Backend selector. `kind` is "decklink" or "aja". Returns nullptr if the
// requested backend was not compiled in (see ENABLE_* CMake options).
std::unique_ptr<CaptureDevice> make_capture(std::string_view kind);

} // namespace sdi
