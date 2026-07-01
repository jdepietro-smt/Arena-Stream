#pragma once
//
// Blackmagic DeckLink capture backend. Only declared when SDI_WITH_DECKLINK
// is defined at compile time (see CMakeLists.txt).

#ifdef SDI_WITH_DECKLINK

#include "capture_device.h"

#include <atomic>
#include <functional>
#include <string>
#include <thread>

namespace sdi {

// Enumerate connected DeckLink devices, calling emit(device_index, channel, name, "decklink")
// for each one. Safe to call even if no DeckLink hardware or drivers are present.
void decklink_list_devices(
    std::function<void(int device, int channel, const std::string& name, const std::string& backend)> emit);

class DeckLinkDevice : public CaptureDevice {
public:
    DeckLinkDevice();
    ~DeckLinkDevice() override;

    bool start(const CaptureConfig& cfg,
               VideoCallback on_video,
               AudioCallback on_audio) override;
    void stop() override;
    VideoMode current_mode() const override { return mode_; }
    std::string_view backend_name() const override { return "decklink"; }

    // DeckLink SDK uses COM-style IUnknown objects. We hide them behind a
    // pimpl so the SDK headers don't leak into the rest of the codebase.
    // Impl must be public so InputCallback (defined in the .cpp) can hold a
    // pointer to it — MSVC enforces this more strictly than GCC/Clang.
    struct Impl;
    std::unique_ptr<Impl> impl_;

private:

    VideoMode mode_{};
};

} // namespace sdi

#endif // SDI_WITH_DECKLINK
