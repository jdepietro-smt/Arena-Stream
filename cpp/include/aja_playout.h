#pragma once
//
// AJA NTV2 playout (SDI output) backend. Only declared when SDI_WITH_AJA is
// defined at compile time (see CMakeLists.txt).
//
// NOTE: unlike the DeckLink backend, this has not yet been validated against
// real AJA output hardware — the decoder machine currently available for
// testing has a DeckLink Duo 2, not an AJA card. The NTV2 API calls below
// follow the same AutoCirculate output pattern documented in the NTV2 SDK
// Programmer's Guide and mirror this project's own AJA capture backend
// (aja_device.cpp) for input, but treat this as needing a real hardware
// pass before depending on it in production.

#ifdef SDI_WITH_AJA

#include "playout_device.h"
#include "frame_queue.h"

#include <stop_token>
#include <thread>

namespace sdi {

class AJAPlayoutDevice : public PlayoutDevice {
public:
    AJAPlayoutDevice();
    ~AJAPlayoutDevice() override;

    bool start(const PlayoutConfig& cfg) override;
    void stop() override;
    void write_video(VideoFrame&& frame) override;
    void write_audio(AudioFrame&& frame) override;
    std::string_view backend_name() const override { return "aja"; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    FrameQueue<VideoFrame> video_queue_{8};
    FrameQueue<AudioFrame> audio_queue_{32};

    // AJA has no SDK-side output callback (same as its capture side) — we
    // own the thread that waits for the output vertical interrupt and
    // transfers the next frame each time the card is ready for one.
    void playout_loop(std::stop_token st, const PlayoutConfig& cfg);
};

} // namespace sdi

#endif // SDI_WITH_AJA
