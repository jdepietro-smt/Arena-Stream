// AJA NTV2 capture backend.
//
// Unlike DeckLink, AJA has no SDK-driven callback. We own the capture thread
// and use AutoCirculate (double-buffered DMA) to pull frames:
//
//   1. CNTV2Card::Open(index)
//   2. SubscribeInputVerticalEvent(channel)
//   3. Route SDI input → frame store via Connect/SetInputOutputXptSelect.
//   4. GetInputVideoFormat → SetVideoFormat → SetFrameBufferFormat
//   5. AutoCirculateInitForInput(channel, numFrames, audioSystem, flags)
//   6. AutoCirculateStart(channel)
//   7. Capture loop: WaitForInputVerticalInterrupt → AutoCirculateGetStatus
//      → AutoCirculateTransfer → hand off VideoFrame + AudioFrame.
//   8. AutoCirculateStop → UnsubscribeInputVerticalEvent → Close.
//
// SDK reference: NTV2 SDK Programmer's Guide, "AutoCirculate" chapter.

#ifdef SDI_WITH_AJA

#include "aja_device.h"

#include "ntv2card.h"
#include "ntv2devicefeatures.h"
#include "ntv2utils.h"

#include <atomic>
#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

namespace sdi {

// ---------------------------------------------------------------------------
// NTV2VideoFormat → VideoMode
// ---------------------------------------------------------------------------

static VideoMode ntv2_to_video_mode(NTV2VideoFormat fmt) {
    VideoMode m;
    m.format = PixelFormat::UYVY422_8;

    // Width and height from the NTV2 standard.
    const NTV2Standard std = ::GetNTV2StandardFromVideoFormat(fmt);
    switch (std) {
        case NTV2_STANDARD_1080:
        case NTV2_STANDARD_1080p:       m.width = 1920; m.height = 1080; break;
        case NTV2_STANDARD_720:         m.width = 1280; m.height = 720;  break;
        case NTV2_STANDARD_525:         m.width = 720;  m.height = 486;  break;
        case NTV2_STANDARD_625:         m.width = 720;  m.height = 576;  break;
        case NTV2_STANDARD_2K:          m.width = 2048; m.height = 1556; break;
        case NTV2_STANDARD_2Kx1080p:
        case NTV2_STANDARD_2Kx1080i:    m.width = 2048; m.height = 1080; break;
        case NTV2_STANDARD_3840x2160p:
        case NTV2_STANDARD_3840HFR:     m.width = 3840; m.height = 2160; break;
        case NTV2_STANDARD_4096x2160p:  m.width = 4096; m.height = 2160; break;
        default:                        m.width = 1920; m.height = 1080; break;
    }

    // Frame rate — NTV2 uses timescale / frame-duration convention.
    const NTV2FrameRate fps = ::GetNTV2FrameRateFromVideoFormat(fmt);
    switch (fps) {
        case NTV2_FRAMERATE_6000: m.fps_num = 60;    m.fps_den = 1;    break;
        case NTV2_FRAMERATE_5994: m.fps_num = 60000; m.fps_den = 1001; break;
        case NTV2_FRAMERATE_5000: m.fps_num = 50;    m.fps_den = 1;    break;
        case NTV2_FRAMERATE_4800: m.fps_num = 48;    m.fps_den = 1;    break;
        case NTV2_FRAMERATE_4795: m.fps_num = 48000; m.fps_den = 1001; break;
        case NTV2_FRAMERATE_3000: m.fps_num = 30;    m.fps_den = 1;    break;
        case NTV2_FRAMERATE_2997: m.fps_num = 30000; m.fps_den = 1001; break;
        case NTV2_FRAMERATE_2500: m.fps_num = 25;    m.fps_den = 1;    break;
        case NTV2_FRAMERATE_2400: m.fps_num = 24;    m.fps_den = 1;    break;
        case NTV2_FRAMERATE_2398: m.fps_num = 24000; m.fps_den = 1001; break;
        default:                  m.fps_num = 30;    m.fps_den = 1;    break;
    }

    m.interlaced = !::IsProgressivePicture(fmt);
    return m;
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

struct AJADevice::Impl {
    CNTV2Card           card;
    NTV2Channel         channel      = NTV2_CHANNEL1;
    NTV2AudioSystem     audio_system = NTV2_AUDIOSYSTEM_1;
    int                 card_channels = 8;  // actual channel count in DMA buffer

    std::jthread          capture_thread;
    std::atomic<bool>     running{false};
    VideoCallback         on_video;
    AudioCallback         on_audio;
    std::atomic<uint64_t> seq_video{0};
    std::atomic<uint64_t> seq_audio{0};
};

// ---------------------------------------------------------------------------
// AJADevice
// ---------------------------------------------------------------------------

AJADevice::AJADevice() : impl_(std::make_unique<Impl>()) {}
AJADevice::~AJADevice() { stop(); }

bool AJADevice::start(const CaptureConfig& cfg,
                      VideoCallback on_video,
                      AudioCallback on_audio) {
    impl_->on_video = std::move(on_video);
    impl_->on_audio = std::move(on_audio);

    // --- 1. Open the card (with a close-then-reopen to flush any stale driver state). ---
    // If a previous sdi_stream was killed hard (SIGKILL / TerminateProcess), the driver
    // may still hold interrupt subscriptions and AutoCirculate sessions from the dead
    // process. Closing (no-op if not open) and reopening guarantees a clean handle.
    const UWord device_index = UWord(std::stoi(cfg.device_id));
    impl_->card.Close();   // safe to call even when not open
    if (!impl_->card.Open(device_index)) {
        std::cerr << "aja: CNTV2Card::Open(" << device_index << ") failed — "
                     "is ajantv2 module loaded? check /dev/ajantv2*\n";
        return false;
    }

    // --- 2. Select channel from config connection string (default Ch1). ---
    // Accept "1"–"8" as channel numbers.
    {
        int ch_num = 1;
        try { ch_num = std::stoi(cfg.connection); } catch (...) {}
        if (ch_num < 1 || ch_num > 8) ch_num = 1;
        impl_->channel      = NTV2Channel(NTV2_CHANNEL1 + ch_num - 1);
        impl_->audio_system = NTV2AudioSystem(NTV2_AUDIOSYSTEM_1 + ch_num - 1);
    }
    const NTV2Channel ch = impl_->channel;

    // --- 3. Set task mode (OEM = application controls the device). ---
    // NTV2_OEM_TASKS puts the driver in OEM mode so our app owns the routing.
    impl_->card.SetTaskMode(NTV2_OEM_TASKS);

    // --- 4. Clear any stale AutoCirculate state from a previous crashed process. ---
    // AutoCirculate state in the kernel driver survives process death.
    // Calling Stop + Unsubscribe after a fresh Open() ensures a clean slate.
    impl_->card.AutoCirculateStop(ch);
    impl_->card.UnsubscribeInputVerticalEvent(ch);

    impl_->card.SetMode(ch, NTV2_MODE_CAPTURE, false);
    impl_->card.SetReference(NTV2_REFERENCE_INPUT1);
    impl_->card.EnableChannel(ch);

    // --- 3b. Route SDI input -> frame store. ---
    // NTV2_OEM_TASKS (above) disables the driver's automatic/default signal
    // routing, so this connection MUST be made explicitly per channel — this
    // was previously only documented in this file's header comment, never
    // actually implemented. Without it, a channel's AutoCirculate reports
    // "running" and allocates valid frame buffers, but the SDI receiver's
    // output is never wired to that frame store's input, so no frame data
    // ever actually arrives (confirmed via AUTOCIRCULATE_STATUS diagnostics:
    // acState running, but activeFrame never advances and bufferLevel stays
    // 0 indefinitely). Channel 1 alone appeared to work only because it
    // happened to match whatever default crosspoint the card powers on with;
    // any other channel run standalone hits this same failure.
    const NTV2InputSource src = ::NTV2ChannelToInputSource(ch);
    {
        const NTV2InputCrosspointID fb_input_xpt = ::GetFrameStoreInputXptFromChannel(ch);
        const NTV2OutputCrosspointID sdi_output_xpt = ::GetInputSourceOutputXpt(src);
        if (!impl_->card.Connect(fb_input_xpt, sdi_output_xpt)) {
            std::cerr << "aja: Connect(frameStore=" << ::NTV2ChannelToString(ch)
                      << ") FAILED to route SDI input to frame store\n";
        }
    }

    // --- 4. Detect input format. ---
    NTV2VideoFormat vid_fmt = impl_->card.GetInputVideoFormat(src);
    if (vid_fmt == NTV2_FORMAT_UNKNOWN) {
        std::cerr << "aja: no signal detected on " << ::NTV2ChannelToString(ch)
                  << " — using fallback 1080p59.94\n";
        vid_fmt = NTV2_FORMAT_1080p_5994_A;
    }

    impl_->card.SetVideoFormat(vid_fmt, false, false, ch);
    impl_->card.SetFrameBufferFormat(ch, NTV2_FBF_8BIT_YCBCR);

    mode_ = ntv2_to_video_mode(vid_fmt);

    // --- 5. Configure audio system input source. ---
    // Without SetAudioSystemInputSource the audio system has no defined source and
    // will DMA zeros. Route SDI embedded audio from the correct input to our system.
    // Use 8 channels (minimum for SDI embedded audio); query back the actual count so
    // the capture loop can de-interleave correctly when extracting the user's channels.
    {
        const NTV2InputSource inp_src = ::NTV2ChannelToInputSource(ch);
        const NTV2EmbeddedAudioInput emb_in = ::NTV2InputSourceToEmbeddedAudioInput(inp_src);
        impl_->card.SetAudioSystemInputSource(impl_->audio_system, NTV2_AUDIO_EMBEDDED, emb_in);
        impl_->card.SetNumberAudioChannels(8, impl_->audio_system);
        impl_->card.SetAudioRate(NTV2_AUDIO_48K, impl_->audio_system);
        impl_->card.SetAudioBufferSize(NTV2_AUDIO_BUFFER_SIZE_4MB, impl_->audio_system);
        impl_->card.SetAudioLoopBack(NTV2_AUDIO_LOOPBACK_OFF, impl_->audio_system);
        // Query actual channel count back — the card may round up to its minimum.
        ULWord actual_ch = 8;
        impl_->card.GetNumberAudioChannels(actual_ch, impl_->audio_system);
        impl_->card_channels = int(actual_ch);
    }

    // --- 6. AutoCirculate init: 8 frame buffers + RP188 timecode. ---
    // Neither call here previously checked its return value. On a multi-channel
    // card, onboard frame buffer memory is a SHARED, LIMITED pool across all
    // channels — if another channel's process already claimed its share, this
    // can silently fail (or succeed with zero usable buffers), and the capture
    // loop then polls HasAvailableInputFrame() forever with no diagnostic of
    // why. Logging the return values here is required to tell "no signal" apart
    // from "the driver refused this channel's frame buffer request".
    const bool ac_init_ok = impl_->card.AutoCirculateInitForInput(
        ch,
        8,
        impl_->audio_system,
        AUTOCIRCULATE_WITH_RP188);
    if (!ac_init_ok) {
        std::cerr << "aja: AutoCirculateInitForInput FAILED for "
                  << ::NTV2ChannelToString(ch)
                  << " — likely insufficient shared frame buffer memory on this "
                     "card (another channel/process may already hold it)\n";
    }

    // --- 6. Subscribe to vertical interrupt and start AutoCirculate. ---
    impl_->card.SubscribeInputVerticalEvent(ch);
    const bool ac_start_ok = impl_->card.AutoCirculateStart(ch);
    if (!ac_start_ok) {
        std::cerr << "aja: AutoCirculateStart FAILED for " << ::NTV2ChannelToString(ch) << "\n";
    }

    std::cerr << "aja: started — device=" << device_index
              << " channel=" << ::NTV2ChannelToString(ch)
              << " mode=" << mode_.width << "x" << mode_.height
              << " @" << (double(mode_.fps_num) / mode_.fps_den) << "fps"
              << (mode_.interlaced ? " interlaced" : " progressive") << "\n";

    impl_->running = true;
    impl_->capture_thread = std::jthread([this, cfg](std::stop_token st) {
        capture_loop(st, cfg);
    });
    return true;
}

void AJADevice::stop() {
    if (!impl_) return;
    impl_->running = false;
    if (impl_->capture_thread.joinable()) {
        impl_->capture_thread.request_stop();
        impl_->capture_thread.join();
    }
    const NTV2Channel ch = impl_->channel;
    impl_->card.AutoCirculateStop(ch);
    impl_->card.UnsubscribeInputVerticalEvent(ch);
    impl_->card.Close();
    std::cerr << "aja: stopped\n";
}

void AJADevice::capture_loop(std::stop_token st, const CaptureConfig& cfg) {
    const NTV2Channel ch = impl_->channel;

    // Pre-allocate DMA transfer buffers.
    // GetVideoActiveSize returns the exact byte count for the active picture
    // area (no VANC) for this format and frame buffer format.
    NTV2VideoFormat vid_fmt = NTV2_FORMAT_UNKNOWN;
    impl_->card.GetVideoFormat(vid_fmt, ch);
    const ULWord vid_size = ::GetVideoActiveSize(
        vid_fmt, NTV2_FBF_8BIT_YCBCR, NTV2_VANCMODE_OFF);
    std::vector<uint8_t> vid_buf(vid_size ? vid_size : 1920 * 1080 * 2);

    // NTV2_AUDIO_BUFFER_SIZE_1MB / 4MB are enum SELECTORS, not byte counts.
    // Modern AJA cards use a 4MB audio ring buffer. Allocate enough bytes for
    // several frames of audio: 16ch × 48kHz × 4B × 2 frames ≈ 200KB is enough,
    // but 4MB matches the card's own buffer to prevent any DMA overrun.
    std::vector<uint8_t> aud_buf(4 * 1024 * 1024);

    AUTOCIRCULATE_TRANSFER xfer;
    xfer.SetVideoBuffer(reinterpret_cast<ULWord*>(vid_buf.data()), ULWord(vid_buf.size()));
    xfer.SetAudioBuffer(reinterpret_cast<ULWord*>(aud_buf.data()), ULWord(aud_buf.size()));

    // Capture-relative epoch: PTS starts at 0 when the first frame is captured.
    // steady_clock::now().time_since_epoch() gives nanoseconds from system boot
    // (~100,000 s on a long-running machine). After av_rescale_q to 90 kHz that
    // overflows the MPEG-TS 33-bit PTS field (max ~95,443 s), breaking A/V sync.
    // Subtracting t0 keeps PTS in the range [0, stream_duration], well within limits.
    const auto t0 = std::chrono::steady_clock::now();
    bool logged_first_video = false, logged_first_audio = false;

    int diag_poll_count = 0;
    int diag_transfer_fail_count = 0;

    while (!st.stop_requested() && impl_->running) {
        // Poll AutoCirculate status — more reliable than WaitForInputVerticalInterrupt
        // on Windows after hard kills, which can leave interrupt state corrupted.
        AUTOCIRCULATE_STATUS status;
        impl_->card.AutoCirculateGetStatus(ch, status);
        if (!status.HasAvailableInputFrame()) {
            // Diagnostic: dump the full status periodically so a channel that
            // never gets an available frame is distinguishable from one that's
            // merely slow — e.g. acState stuck at "not running", or "dropped"
            // count climbing, would each point to a different root cause.
            if (++diag_poll_count % 1000 == 0) {
                std::cerr << "aja: " << ::NTV2ChannelToString(ch)
                          << " diag: no available input frame after "
                          << diag_poll_count << " polls. acState="
                          << int(status.acState)
                          << " startFrame=" << status.acStartFrame
                          << " endFrame=" << status.acEndFrame
                          << " activeFrame=" << status.acActiveFrame
                          << " framesProcessed=" << status.acFramesProcessed
                          << " framesDropped=" << status.acFramesDropped
                          << " bufferLevel=" << status.acBufferLevel << "\n";
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }

        if (!impl_->card.AutoCirculateTransfer(ch, xfer)) {
            if (++diag_transfer_fail_count <= 10 || diag_transfer_fail_count % 500 == 0) {
                std::cerr << "aja: " << ::NTV2ChannelToString(ch)
                          << " diag: AutoCirculateTransfer failed (#"
                          << diag_transfer_fail_count << ")\n";
            }
            continue;
        }

        // Single timestamp for this transfer. Video and audio in this xfer come
        // from the SAME hardware DMA event (one AutoCirculateTransfer call pulls
        // both the video frame and the audio samples captured since the last
        // transfer), so they must share one PTS. Previously this code called
        // steady_clock::now() separately for video and audio, introducing a
        // (small but real) host-clock skew between two samples of the same
        // hardware event — never the right design even though the actual skew
        // was only microseconds.
        const int64_t frame_pts = (std::chrono::steady_clock::now() - t0).count();

        // --- Video frame ---
        const int64_t v_pts = frame_pts;
        VideoFrame vf;
        vf.stride   = uint32_t(mode_.width * 2);  // UYVY: 2 bytes per pixel
        vf.mode     = mode_;
        vf.pts      = Nanos{v_pts};
        vf.sequence = impl_->seq_video.fetch_add(1, std::memory_order_relaxed);
        vf.data.assign(vid_buf.data(), vid_buf.data() + vid_buf.size());
        if (!logged_first_video) {
            logged_first_video = true;
            std::cerr << "diag: first video frame, pts_ns=" << v_pts << "\n";
        }
        impl_->on_video(std::move(vf));

        // --- Audio frame ---
        // The DMA buffer contains impl_->card_channels interleaved 32-bit samples.
        // Extract only the first cfg.audio_channels channels (e.g. channels 1&2 = L/R).
        const ULWord aud_bytes = xfer.GetTransferStatus().acAudioTransferSize;
        if (aud_bytes > 0 && impl_->on_audio) {
            const int want_ch  = int(cfg.audio_channels);
            const int card_ch  = impl_->card_channels;  // actual interleave width
            const int total_s32 = int(aud_bytes) / int(sizeof(int32_t));
            const int frames    = total_s32 / card_ch;  // samples per channel
            // Same timestamp as the video frame from this transfer — both
            // originate from the same hardware DMA event.
            const int64_t a_pts = frame_pts;
            AudioFrame af;
            af.channels    = uint32_t(want_ch);
            af.sample_rate = 48000;
            af.pts         = Nanos{a_pts};
            af.sequence    = impl_->seq_audio.fetch_add(1, std::memory_order_relaxed);
            // De-interleave: pick only the first want_ch channels from each frame.
            const int32_t* src = reinterpret_cast<const int32_t*>(aud_buf.data());
            af.samples.resize(frames * want_ch);
            for (int f = 0; f < frames; ++f)
                for (int c = 0; c < want_ch; ++c)
                    af.samples[f * want_ch + c] = src[f * card_ch + c];
            if (!logged_first_audio) {
                logged_first_audio = true;
                // duration_ms reveals whether the first audio chunk is unusually
                // large (e.g. stale samples that had piled up in the AJA card's
                // on-board audio ring buffer before AutoCirculateStart) — a large
                // first chunk would itself explain an apparent A/V offset.
                const double duration_ms = 1000.0 * frames / 48000.0;
                std::cerr << "diag: first audio frame, pts_ns=" << a_pts
                          << " samples_per_ch=" << frames
                          << " duration_ms=" << duration_ms << "\n";
            }
            impl_->on_audio(std::move(af));
        }
    }
}

} // namespace sdi

#endif // SDI_WITH_AJA
