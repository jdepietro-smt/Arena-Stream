// Blackmagic DeckLink playout (SDI output) backend.
//
// DeckLink output uses a scheduled-playback model, the mirror image of the
// input side's callback model:
//   1. Obtain an IDeckLinkIterator, walk to the desired device (same as input).
//   2. QueryInterface(IID_IDeckLinkOutput) -> get the output interface.
//   3. EnableVideoOutput with the mode the decoded stream is actually in.
//   4. EnableAudioOutput at 48 kHz / S32 / N channels, continuous stream mode.
//   5. SetScheduledFrameCompletionCallback(our IDeckLinkVideoOutputCallback).
//   6. Pre-roll a couple of frames, then StartScheduledPlayback().
//   7. Every time a scheduled frame finishes playing, the driver calls
//      ScheduledFrameCompleted on its own thread; we pull the next decoded
//      frame from our queue (non-blocking — never stall the driver thread)
//      and schedule it. If the decoder hasn't produced one yet, we re-
//      schedule the frame that just completed rather than leaving a gap:
//      SDI output timing must never depend on decoder/network arrival
//      jitter, which is exactly the discipline capture-side AutoCirculate
//      already gives us on the sender.
//
// SDK reference: Desktop Video SDK Manual, "Playback" chapter.

#ifdef SDI_WITH_DECKLINK

#include "decklink_playout.h"

#ifdef _WIN32
#  include <objbase.h>
#endif
#include "DeckLinkAPI.h"

#include <atomic>
#include <cstring>
#include <iostream>

namespace sdi {

// ---------------------------------------------------------------------------
// VideoMode -> BMDDisplayMode
// ---------------------------------------------------------------------------

static BMDDisplayMode bmd_mode_from_video_mode(const VideoMode& m) {
    const double fps = double(m.fps_num) / double(m.fps_den ? m.fps_den : 1);
    const bool p = !m.interlaced;

    if (m.width == 1920 && m.height == 1080) {
        if (p) {
            if (fps > 23.9 && fps < 24.1) return bmdModeHD1080p24;
            if (fps > 24.9 && fps < 25.1) return bmdModeHD1080p25;
            if (fps > 29.9 && fps < 30.1) return bmdModeHD1080p30;
            if (fps > 49.9 && fps < 50.1) return bmdModeHD1080p50;
            if (fps > 59.9 && fps < 60.1) return bmdModeHD1080p6000;
            return bmdModeHD1080p5994; // 29.97/59.94-family default
        }
        if (fps > 49.9 && fps < 50.1) return bmdModeHD1080i50;
        if (fps > 59.9 && fps < 60.1) return bmdModeHD1080i6000;
        return bmdModeHD1080i5994;
    }
    if (m.width == 1280 && m.height == 720) {
        if (fps > 49.9 && fps < 50.1) return bmdModeHD720p50;
        if (fps > 59.9 && fps < 60.1) return bmdModeHD720p60;
        return bmdModeHD720p5994;
    }
    if (m.width == 720 && m.height == 486) return bmdModeNTSC;
    if (m.width == 720 && m.height == 576) return bmdModePAL;

    // Fall back to the most common broadcast default rather than failing
    // outright — EnableVideoOutput will reject it below if truly unsupported.
    return bmdModeHD1080p5994;
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

struct DeckLinkPlayoutDevice::Impl {
    IDeckLink*       device = nullptr;
    IDeckLinkOutput* output = nullptr;

    VideoMode        mode{};
    BMDTimeScale     time_scale    = 60000;
    BMDTimeValue     frame_duration = 1001;
    uint32_t         audio_channels = 2;

    std::atomic<uint64_t> frames_scheduled{0};
    IDeckLinkMutableVideoFrame* last_frame = nullptr;   // re-scheduled on underrun

    class OutputCallback* callback = nullptr;
};

// ---------------------------------------------------------------------------
// OutputCallback — runs on the DeckLink driver's internal thread.
// ---------------------------------------------------------------------------

class OutputCallback : public IDeckLinkVideoOutputCallback {
public:
    OutputCallback(DeckLinkPlayoutDevice::Impl* impl, FrameQueue<VideoFrame>* q)
        : impl_(impl), queue_(q), ref_(1) {}

    HRESULT QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
    ULONG   AddRef()  override { return ++ref_; }
    ULONG   Release() override {
        auto r = --ref_;
        if (r == 0) delete this;
        return r;
    }

    HRESULT ScheduledFrameCompleted(IDeckLinkVideoFrame* completedFrame,
                                     BMDOutputFrameCompletionResult result) override {
        if (result == bmdOutputFrameDropped)
            std::cerr << "decklink playout: dropped frame (falling behind)\n";

        auto next = queue_->try_pop();
        IDeckLinkMutableVideoFrame* out_frame = nullptr;

        if (next) {
            void* bytes = nullptr;
            const HRESULT hr = impl_->output->CreateVideoFrame(
                int(impl_->mode.width), int(impl_->mode.height),
                int(next->stride), bmdFormat8BitYUV, bmdFrameFlagDefault,
                &out_frame);
            if (hr == S_OK && out_frame &&
                out_frame->GetBytes(&bytes) == S_OK && bytes) {
                std::memcpy(bytes, next->data.data(),
                            std::min(next->data.size(),
                                     size_t(next->stride) * impl_->mode.height));
            }
            if (impl_->last_frame) impl_->last_frame->Release();
            // last_frame needs its OWN reference, independent of the one
            // ScheduleVideoFrame takes below (and the out_frame->Release()
            // that follows it) — without this AddRef, last_frame's only
            // backing reference is the one owned by the driver's internal
            // scheduling queue. Once the driver finishes displaying this
            // frame and drops that reference, the object is destroyed while
            // last_frame still points at it — a use-after-free the very
            // next time an underrun below calls AddRef() on it. Confirmed
            // in the field: this crashed the whole process (0xC0000005)
            // within the first handful of frames on real DeckLink hardware.
            if (out_frame) out_frame->AddRef();
            impl_->last_frame = out_frame;
        } else {
            // Underrun: no decoded frame ready yet. Re-schedule the frame
            // that just completed (freeze-frame) rather than leave a gap —
            // downstream SDI equipment must always see a continuous signal.
            out_frame = impl_->last_frame;
            if (out_frame) out_frame->AddRef();
        }

        if (!out_frame) return S_OK;

        const uint64_t n = impl_->frames_scheduled.fetch_add(1, std::memory_order_relaxed);
        const BMDTimeValue display_time = BMDTimeValue(n) * impl_->frame_duration;
        impl_->output->ScheduleVideoFrame(out_frame, display_time,
                                          impl_->frame_duration, impl_->time_scale);
        out_frame->Release();
        return S_OK;
    }

    HRESULT ScheduledPlaybackHasStopped() override {
        std::cerr << "decklink playout: scheduled playback stopped\n";
        return S_OK;
    }

private:
    DeckLinkPlayoutDevice::Impl* impl_;
    FrameQueue<VideoFrame>*      queue_;
    std::atomic<ULONG>           ref_;
};

// ---------------------------------------------------------------------------
// DeckLinkPlayoutDevice
// ---------------------------------------------------------------------------

DeckLinkPlayoutDevice::DeckLinkPlayoutDevice() : impl_(std::make_unique<Impl>()) {}
DeckLinkPlayoutDevice::~DeckLinkPlayoutDevice() { stop(); }

bool DeckLinkPlayoutDevice::start(const PlayoutConfig& cfg) {
    impl_->mode           = cfg.mode;
    impl_->audio_channels = cfg.audio_channels;
    impl_->time_scale     = BMDTimeScale(cfg.mode.fps_num ? cfg.mode.fps_num : 60000);
    impl_->frame_duration = BMDTimeValue(cfg.mode.fps_den ? cfg.mode.fps_den : 1001);

    // --- 1. Enumerate and select device by index (same pattern as capture). ---
#ifdef _WIN32
    ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IDeckLinkIterator* it = nullptr;
    HRESULT hr = ::CoCreateInstance(CLSID_CDeckLinkIterator, nullptr, CLSCTX_ALL,
                                    IID_IDeckLinkIterator,
                                    reinterpret_cast<void**>(&it));
    if (FAILED(hr) || !it) {
        std::cerr << "decklink playout: CoCreateInstance failed — is Desktop Video installed?\n";
        return false;
    }
#else
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) {
        std::cerr << "decklink playout: CreateDeckLinkIteratorInstance failed\n";
        return false;
    }
#endif

    int target = 0;
    try { target = std::stoi(cfg.device_id); } catch (...) {}

    for (int i = 0; i <= target; ++i) {
        if (impl_->device) { impl_->device->Release(); impl_->device = nullptr; }
        if (it->Next(&impl_->device) != S_OK) {
            it->Release();
            std::cerr << "decklink playout: device index " << target << " not found\n";
            return false;
        }
    }
    it->Release();

    // --- 2. Get the IDeckLinkOutput interface. ---
    if (impl_->device->QueryInterface(
            IID_IDeckLinkOutput,
            reinterpret_cast<void**>(&impl_->output)) != S_OK) {
        std::cerr << "decklink playout: QueryInterface(IDeckLinkOutput) failed — "
                     "device may be input-only, or already in use\n";
        return false;
    }

    // --- 3. Enable video output in the decoded stream's own format. ---
    const BMDDisplayMode bmd_mode = bmd_mode_from_video_mode(cfg.mode);
    if (impl_->output->EnableVideoOutput(bmd_mode, bmdVideoOutputFlagDefault) != S_OK) {
        std::cerr << "decklink playout: EnableVideoOutput failed for "
                  << cfg.mode.width << "x" << cfg.mode.height << "\n";
        return false;
    }

    // --- 4. Enable audio output: 48 kHz, 32-bit integer, N channels, continuous. ---
    if (impl_->output->EnableAudioOutput(
            bmdAudioSampleRate48kHz, bmdAudioSampleType32bitInteger,
            cfg.audio_channels, bmdAudioOutputStreamContinuous) != S_OK) {
        std::cerr << "decklink playout: EnableAudioOutput failed\n";
        return false;
    }

    // --- 5. Install the scheduled-frame-completion callback. ---
    impl_->callback = new OutputCallback(impl_.get(), &video_queue_);
    if (impl_->output->SetScheduledFrameCompletionCallback(impl_->callback) != S_OK) {
        std::cerr << "decklink playout: SetScheduledFrameCompletionCallback failed\n";
        return false;
    }

    // --- 6. Pre-roll: schedule a couple of black frames so playback has
    //     something queued the instant StartScheduledPlayback fires. ---
    for (int i = 0; i < 3; ++i) {
        IDeckLinkMutableVideoFrame* frame = nullptr;
        const uint32_t stride = cfg.mode.width * 2;  // UYVY: 2 bytes/pixel
        if (impl_->output->CreateVideoFrame(int(cfg.mode.width), int(cfg.mode.height),
                                            int(stride), bmdFormat8BitYUV,
                                            bmdFrameFlagDefault, &frame) == S_OK && frame) {
            void* bytes = nullptr;
            if (frame->GetBytes(&bytes) == S_OK && bytes) {
                // Black in UYVY: fill with 0x80 (Cb/Cr neutral), Y=0x10 pattern
                // approximated by a flat 0x10 fill — close enough for pre-roll,
                // real content replaces it within the first few frames.
                std::memset(bytes, 0x10, size_t(stride) * cfg.mode.height);
            }
            impl_->output->ScheduleVideoFrame(
                frame, BMDTimeValue(i) * impl_->frame_duration,
                impl_->frame_duration, impl_->time_scale);
            if (i == 2) { impl_->last_frame = frame; frame->AddRef(); }
            frame->Release();
        }
    }
    impl_->frames_scheduled = 3;

    // --- 7. Start scheduled playback and the audio stream. ---
    if (impl_->output->StartScheduledPlayback(0, impl_->time_scale, 1.0) != S_OK) {
        std::cerr << "decklink playout: StartScheduledPlayback failed\n";
        return false;
    }
    impl_->output->BeginAudioPreroll();

    std::cerr << "decklink playout: started — device=" << cfg.device_id
              << " mode=" << cfg.mode.width << "x" << cfg.mode.height
              << " @" << (double(cfg.mode.fps_num) / cfg.mode.fps_den) << "fps"
              << (cfg.mode.interlaced ? " interlaced" : " progressive") << "\n";
    return true;
}

void DeckLinkPlayoutDevice::write_video(VideoFrame&& frame) {
    video_queue_.push(std::move(frame));
}

void DeckLinkPlayoutDevice::write_audio(AudioFrame&& frame) {
    if (!impl_->output) return;
    // Continuous audio stream mode: schedule samples ahead of time, the
    // card consumes them at its own hardware clock rate independently of
    // when we happen to call this — no explicit timestamp needed here.
    uint32_t written = 0;
    impl_->output->ScheduleAudioSamples(
        frame.samples.data(), uint32_t(frame.frame_count()),
        0, 0, &written);
}

void DeckLinkPlayoutDevice::stop() {
    if (!impl_ || !impl_->output) return;

    impl_->output->StopScheduledPlayback(0, nullptr, impl_->time_scale);
    impl_->output->DisableVideoOutput();
    impl_->output->DisableAudioOutput();
    impl_->output->SetScheduledFrameCompletionCallback(nullptr);

    if (impl_->last_frame) { impl_->last_frame->Release(); impl_->last_frame = nullptr; }
    if (impl_->callback) { impl_->callback->Release(); impl_->callback = nullptr; }

    impl_->output->Release();
    impl_->output = nullptr;

    if (impl_->device) { impl_->device->Release(); impl_->device = nullptr; }

    video_queue_.close();
    audio_queue_.close();
    std::cerr << "decklink playout: stopped\n";
}

} // namespace sdi

#endif // SDI_WITH_DECKLINK
