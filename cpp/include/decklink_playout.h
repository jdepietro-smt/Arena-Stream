#pragma once
//
// Blackmagic DeckLink playout (SDI output) backend. Only declared when
// SDI_WITH_DECKLINK is defined at compile time (see CMakeLists.txt).

#ifdef SDI_WITH_DECKLINK

#include "playout_device.h"
#include "frame_queue.h"

#include <atomic>
#include <memory>

namespace sdi {

class DeckLinkPlayoutDevice : public PlayoutDevice {
public:
    DeckLinkPlayoutDevice();
    ~DeckLinkPlayoutDevice() override;

    bool start(const PlayoutConfig& cfg) override;
    void stop() override;
    void write_video(VideoFrame&& frame) override;
    void write_audio(AudioFrame&& frame) override;
    std::string_view backend_name() const override { return "decklink"; }

    // DeckLink SDK uses COM-style IUnknown objects. We hide them behind a
    // pimpl so the SDK headers don't leak into the rest of the codebase.
    // Impl must be public so OutputCallback (defined in the .cpp) can hold
    // a pointer to it — MSVC enforces this more strictly than GCC/Clang.
    struct Impl;
    std::unique_ptr<Impl> impl_;

private:
    // Frames arrive from the decoder thread via write_video/write_audio;
    // ScheduledFrameCompleted (driver callback thread) pulls from this
    // queue non-blocking. Capacity of a few frames absorbs normal decoder
    // jitter without ever blocking either side.
    FrameQueue<VideoFrame> video_queue_{8};
    FrameQueue<AudioFrame> audio_queue_{32};
};

} // namespace sdi

#endif // SDI_WITH_DECKLINK
