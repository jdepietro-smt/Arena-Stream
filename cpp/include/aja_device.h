#pragma once
//
// AJA NTV2 capture backend. Only declared when SDI_WITH_AJA is defined.

#ifdef SDI_WITH_AJA

#include "capture_device.h"

#include <stop_token>

namespace sdi {

class AJADevice : public CaptureDevice {
public:
    AJADevice();
    ~AJADevice() override;

    bool start(const CaptureConfig& cfg,
               VideoCallback on_video,
               AudioCallback on_audio) override;
    void stop() override;
    VideoMode current_mode() const override { return mode_; }
    std::string_view backend_name() const override { return "aja"; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    VideoMode mode_{};

    // Capture loop — AJA has no SDK-side callback, so we own the thread.
    void capture_loop(std::stop_token st, const CaptureConfig& cfg);
};

} // namespace sdi

#endif // SDI_WITH_AJA
