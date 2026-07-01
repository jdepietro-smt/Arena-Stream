#pragma once
//
// NDIDevice — CaptureDevice backend that receives from an NDI source.
//
// Useful for NDI → SRT bridging: the Electron UI discovers NDI sources via
// sdi_stream --list (which includes NDI entries when compiled with NDI support),
// and then starts sdi_stream with --backend ndi --device "Source Name" to
// feed the NDI video into the existing encode → SRT chain.

#ifdef SDI_WITH_NDI

#include "capture_device.h"

#include <memory>
#include <string>
#include <vector>

namespace sdi {

//
// Enumerate NDI sources visible on the LAN.
// Blocks for timeout_ms to allow mDNS discovery to complete.
// Returns a list of source names in the standard NDI "Machine (Source)" format.
//
std::vector<std::string> ndi_list_sources(int timeout_ms = 500);

//
// NDIDevice — implements the CaptureDevice interface for an NDI input.
//
// CaptureConfig usage:
//   cfg.device_id = full NDI source name, e.g. "WORKSTATION (NDI Cam 1)"
//
class NDIDevice : public CaptureDevice {
public:
    NDIDevice();
    ~NDIDevice() override;

    bool             start(const CaptureConfig& cfg,
                           VideoCallback         on_video,
                           AudioCallback         on_audio) override;
    void             stop() override;
    VideoMode        current_mode() const override;
    std::string_view backend_name() const override { return "ndi"; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace sdi

#endif  // SDI_WITH_NDI
