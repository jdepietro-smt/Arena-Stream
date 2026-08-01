// AJA NTV2 playout (SDI output) backend.
//
// AJA has no SDK-driven output callback (same as its capture side) — we own
// a thread that waits for buffer room and transfers frames out via
// AutoCirculate, the mirror image of aja_device.cpp's capture loop:
//
//   1. CNTV2Card::Open(index)
//   2. Route frame store output -> SDI output widget via Connect (the same
//      explicit crosspoint routing the capture side needed — see the
//      comment in aja_device.cpp about why this can't be skipped once
//      NTV2_OEM_TASKS is set).
//   3. SetMode(ch, NTV2_MODE_OUTPUT), SetVideoFormat, SetFrameBufferFormat.
//   4. AutoCirculateInitForOutput(channel, numFrames, audioSystem, flags).
//   5. AutoCirculateStart(channel).
//   6. Playout loop: AutoCirculateGetStatus -> CanAcceptMoreOutputFrames ->
//      pull next decoded frame (non-blocking) -> AutoCirculateTransfer.
//      On underrun (decoder hasn't produced a frame yet), re-transfer the
//      last frame rather than leave a gap on the SDI output.
//
// NOTE: unlike the DeckLink playout backend, this has not been validated on
// real AJA output hardware yet (see aja_playout.h). Treat it as a first
// pass following the documented AutoCirculate output pattern, not as
// hardware-proven.

#ifdef SDI_WITH_AJA

#include "aja_playout.h"

#include "ntv2card.h"
#include "ntv2devicefeatures.h"
#include "ntv2utils.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>

namespace sdi {

struct AJAPlayoutDevice::Impl {
    CNTV2Card       card;
    NTV2Channel     channel      = NTV2_CHANNEL1;
    NTV2AudioSystem audio_system = NTV2_AUDIOSYSTEM_1;
    VideoMode       mode{};
    int             card_channels = 8;   // actual SDI-embedded interleave width
    uint32_t        our_channels  = 2;   // channels actually decoded/meaningful

    std::jthread    playout_thread;
    std::atomic<bool> running{false};

    std::vector<uint8_t> last_video;   // re-sent on underrun (freeze-frame)
};

AJAPlayoutDevice::AJAPlayoutDevice() : impl_(std::make_unique<Impl>()) {}
AJAPlayoutDevice::~AJAPlayoutDevice() { stop(); }

bool AJAPlayoutDevice::start(const PlayoutConfig& cfg) {
    impl_->mode = cfg.mode;

    // --- 1. Open the card (close-then-reopen flushes stale driver state,
    //     same reasoning as the capture side: a hard-killed previous
    //     process can leave AutoCirculate/interrupt subscriptions behind). ---
    const UWord device_index = UWord(std::stoi(cfg.device_id));
    impl_->card.Close();
    if (!impl_->card.Open(device_index)) {
        std::cerr << "aja playout: CNTV2Card::Open(" << device_index << ") failed\n";
        return false;
    }

    // --- 2. Select channel from connection string. ---
    int ch_num = 1;
    try { ch_num = std::stoi(cfg.connection); } catch (...) {}
    if (ch_num < 1 || ch_num > 8) ch_num = 1;
    impl_->channel      = NTV2Channel(NTV2_CHANNEL1 + ch_num - 1);
    impl_->audio_system = NTV2AudioSystem(NTV2_AUDIOSYSTEM_1 + ch_num - 1);
    const NTV2Channel ch = impl_->channel;

    // --- 3. OEM task mode, clean slate. ---
    impl_->card.SetTaskMode(NTV2_OEM_TASKS);
    impl_->card.AutoCirculateStop(ch);
    impl_->card.UnsubscribeOutputVerticalEvent(ch);

    impl_->card.SetMode(ch, NTV2_MODE_OUTPUT, false);
    // The reference/genlock selector is a BOARD-WIDE AJA setting, not
    // per-channel — on a card shared with another process (e.g. an encoder
    // already capturing on other channels, genlocked to one of its SDI
    // inputs), forcing free-run here overwrites that process's reference
    // out from under it and destabilizes every active channel at once, not
    // just this one. Default is free-run (correct for a standalone decoder
    // box with sole use of its card); pass cfg.reference="input1".."input8"
    // to match whatever another process on the same card already set.
    NTV2ReferenceSource ref_source = NTV2_REFERENCE_FREERUN;
    if (cfg.reference.rfind("input", 0) == 0) {
        int input_num = 1;
        try { input_num = std::stoi(cfg.reference.substr(5)); } catch (...) {}
        if (input_num < 1) input_num = 1;
        if (input_num > 8) input_num = 8;
        ref_source = NTV2ReferenceSource(NTV2_REFERENCE_INPUT1 + input_num - 1);
    }
    impl_->card.SetReference(ref_source);
    impl_->card.EnableChannel(ch);

    // --- 3b. Route frame store output -> SDI output widget. ---
    // Same explicit crosspoint routing requirement discovered on the
    // capture side: NTV2_OEM_TASKS disables the driver's default routing,
    // so without this the SDI output would carry no signal at all even
    // though AutoCirculate reports "running".
    {
        const NTV2OutputXptID fb_output_xpt = ::GetFrameStoreOutputXptFromChannel(ch);
        const NTV2InputXptID  sdi_input_xpt = ::GetSDIOutputInputXpt(ch);
        if (!impl_->card.Connect(sdi_input_xpt, fb_output_xpt)) {
            std::cerr << "aja playout: Connect(SDI output=" << ::NTV2ChannelToString(ch)
                      << ") FAILED to route frame store to SDI output\n";
        }
    }

    // --- 4. Set video format from the decoded stream's mode. ---
    // NTV2_STANDARD_1080 and NTV2_STANDARD_1080p are DISTINCT enum values
    // (see aja_device.cpp's capture-side handling of both) — this used to
    // pick NTV2_STANDARD_1080 (interlaced) for every 1080 source regardless
    // of cfg.mode.interlaced, embedding the wrong SMPTE 352 payload ID
    // standard tag on a progressive source (or vice-versa for 720, though
    // broadcast 720 is conventionally always progressive so that direction
    // rarely bites). A mismatched standard tag vs. the actual raster is
    // exactly the kind of thing a signal analyzer flags as an invalid format.
    const NTV2Standard standard =
        (cfg.mode.width == 1920 && cfg.mode.height == 1080)
            ? (cfg.mode.interlaced ? NTV2_STANDARD_1080 : NTV2_STANDARD_1080p)
      : (cfg.mode.width == 1280 && cfg.mode.height == 720)  ? NTV2_STANDARD_720
      : NTV2_STANDARD_1080;

    // GetFirstMatchingVideoFormat takes an NTV2FrameRate, not fps directly —
    // map the decoded stream's fps_num/fps_den the same way aja_device.cpp's
    // capture side maps the reverse direction (NTV2FrameRate -> fps).
    //
    // fps_den == 1001 is the exact, unambiguous signal for an NTSC-family
    // rate (e.g. 30000/1001 = 29.97) as opposed to the same nominal integer
    // rate (30/1 = 30 exact). The previous version tried to guess this with
    // overlapping float ranges — e.g. both "fps > 59.9 && fps < 60.1" (exact
    // 60) and "fps > 59.8 && fps < 59.99" (59.94) match 59.94 — and because
    // the exact-integer branch was checked first in the if/else chain, EVERY
    // NTSC-family rate (59.94, 29.97, 47.95, 23.98) was misclassified as its
    // round-number sibling. That's why a genuinely 1080i59.94 (29.97 frame
    // rate) source got configured as a clean, progressive 1080p30 output.
    const bool ntsc = (cfg.mode.fps_den == 1001);
    const double fps = double(cfg.mode.fps_num) / double(cfg.mode.fps_den ? cfg.mode.fps_den : 1);
    NTV2FrameRate rate = NTV2_FRAMERATE_5994;
    if      (fps > 55   && fps < 62)   rate = ntsc ? NTV2_FRAMERATE_5994 : NTV2_FRAMERATE_6000;
    else if (fps > 48   && fps < 52)   rate = NTV2_FRAMERATE_5000;
    else if (fps > 45   && fps < 49)   rate = ntsc ? NTV2_FRAMERATE_4795 : NTV2_FRAMERATE_4800;
    else if (fps > 27   && fps < 32)   rate = ntsc ? NTV2_FRAMERATE_2997 : NTV2_FRAMERATE_3000;
    else if (fps > 24.5 && fps < 25.5) rate = NTV2_FRAMERATE_2500;
    else if (fps > 22   && fps < 24.5) rate = ntsc ? NTV2_FRAMERATE_2398 : NTV2_FRAMERATE_2400;

    NTV2VideoFormat vid_fmt = ::GetFirstMatchingVideoFormat(
        rate, UWord(cfg.mode.height), UWord(cfg.mode.width), cfg.mode.interlaced, false, false);
    if (vid_fmt == NTV2_FORMAT_UNKNOWN) {
        std::cerr << "aja playout: no NTV2 video format matches "
                  << cfg.mode.width << "x" << cfg.mode.height << " @" << fps << "fps"
                  << (cfg.mode.interlaced ? " interlaced" : " progressive")
                  << " — falling back to 1080p59.94 (output will NOT match the source)\n";
        vid_fmt = NTV2_FORMAT_1080p_5994_A;
    }

    impl_->card.SetVideoFormat(vid_fmt, false, false, ch);
    impl_->card.SetFrameBufferFormat(ch, NTV2_FBF_8BIT_YCBCR);
    impl_->card.SetSDIOutputStandard(UWord(ch), standard);

    // --- 5. Audio system: embed into this channel's SDI output. ---
    // SDI embedded audio is always organized in fixed-width groups — the
    // capture side (aja_device.cpp) already discovered this and always
    // requests 8 channels regardless of how many the caller actually wants,
    // then de-interleaves down to the wanted count in software afterward.
    // This side used to request only cfg.audio_channels (typically 2)
    // directly, mismatching whatever fixed interleave width the card's
    // embedder actually uses — every sample would land at the wrong byte
    // offset, exactly the kind of corruption that plays back as a pitched
    // squeak rather than recognizable audio. Match capture's convention:
    // always configure 8, then pad our actual channels out to that width
    // with silence when feeding the transfer buffer.
    impl_->card.SetNumberAudioChannels(8, impl_->audio_system);
    impl_->card.SetAudioRate(NTV2_AUDIO_48K, impl_->audio_system);
    impl_->card.SetAudioBufferSize(NTV2_AUDIO_BUFFER_SIZE_4MB, impl_->audio_system);
    impl_->card.SetSDIOutputAudioSystem(ch, impl_->audio_system);
    ULWord actual_ch = 8;
    impl_->card.GetNumberAudioChannels(actual_ch, impl_->audio_system);
    impl_->card_channels = int(actual_ch);
    impl_->our_channels  = cfg.audio_channels;

    // --- 6. AutoCirculate init for output: 8 frame buffers + RP188. ---
    if (!impl_->card.AutoCirculateInitForOutput(
            ch, 8, impl_->audio_system, AUTOCIRCULATE_WITH_RP188)) {
        std::cerr << "aja playout: AutoCirculateInitForOutput FAILED for "
                  << ::NTV2ChannelToString(ch) << "\n";
        return false;
    }

    impl_->card.SubscribeOutputVerticalEvent(ch);
    if (!impl_->card.AutoCirculateStart(ch)) {
        std::cerr << "aja playout: AutoCirculateStart FAILED for "
                  << ::NTV2ChannelToString(ch) << "\n";
        return false;
    }

    std::cerr << "aja playout: started — device=" << device_index
              << " channel=" << ::NTV2ChannelToString(ch)
              << " mode=" << cfg.mode.width << "x" << cfg.mode.height
              << " @" << (double(cfg.mode.fps_num) / cfg.mode.fps_den) << "fps\n";

    impl_->running = true;
    impl_->playout_thread = std::jthread([this, cfg](std::stop_token st) {
        playout_loop(st, cfg);
    });
    return true;
}

void AJAPlayoutDevice::playout_loop(std::stop_token st, const PlayoutConfig& cfg) {
    const NTV2Channel ch = impl_->channel;
    AUTOCIRCULATE_TRANSFER xfer;
    // Persists across iterations — newly-queued audio is appended here, and
    // only one video-frame's worth is fed per transfer, with any surplus
    // carried over to the next. Opus decode and SRT delivery are bursty, so
    // popping the ENTIRE queue into a single transfer (the previous
    // approach) could occasionally hand the card far more audio than one
    // frame period's worth at once — that plays back faster than real time,
    // which is a pitched-up "squeak", not the silence-gap "tick" that
    // starving the buffer produced. Pacing to real frame duration fixes
    // both failure modes: never empty (avoids the tick), never oversupplied
    // in a lump (avoids the squeak).
    std::vector<int32_t> audio_carry;
    std::vector<int32_t> audio_padded;   // audio_carry expanded to card_channels width
    const uint32_t fps_num = cfg.mode.fps_num ? cfg.mode.fps_num : 30000;
    const uint32_t fps_den = cfg.mode.fps_den ? cfg.mode.fps_den : 1001;
    // 48000/fps is essentially never an integer (e.g. 29.97fps → 1601.6
    // samples/frame) — truncating it every cycle (the previous version) always
    // feeds a hair less audio than the frame period it's meant to cover, real
    // audio keeps arriving at its true rate, and the shortfall accumulates in
    // audio_carry forever. That's a slow, ever-growing A/V desync that gets
    // worse the longer the stream runs, not a fixed offset. Carrying the
    // fractional remainder (same technique as the encoder's own PTS drift
    // correction in encoder.h) keeps the long-run average exactly correct.
    const double samples_per_frame_exact = 48000.0 * fps_den / fps_num;
    double sample_frame_accum = 0.0;

    // Diagnostics: with no hardware to test this against before now, log
    // enough to tell a starved decoder (video freeze-frame repeats climbing)
    // apart from anything else, the next time this runs against real output.
    uint64_t transfers = 0, freeze_repeats = 0;
    auto diag_t0 = std::chrono::steady_clock::now();

    while (!st.stop_requested() && impl_->running) {
        AUTOCIRCULATE_STATUS status;
        impl_->card.AutoCirculateGetStatus(ch, status);
        if (!status.CanAcceptMoreOutputFrames()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }

        auto next = video_queue_.try_pop();
        const std::vector<uint8_t>* video_bytes;
        if (next) {
            impl_->last_video = std::move(next->data);
            video_bytes = &impl_->last_video;
        } else if (!impl_->last_video.empty()) {
            // Underrun: decoder hasn't produced a frame yet. Re-transfer the
            // last one (freeze-frame) — a static SDI signal beats a dropout.
            video_bytes = &impl_->last_video;
            ++freeze_repeats;
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }

        // Pull in whatever's newly arrived, then feed at most one frame
        // period's worth this cycle — the rest stays in audio_carry for
        // subsequent transfers instead of going out all at once.
        while (auto audio = audio_queue_.try_pop()) {
            audio_carry.insert(audio_carry.end(), audio->samples.begin(), audio->samples.end());
        }
        const size_t our_ch = std::max<uint32_t>(1, impl_->our_channels);
        sample_frame_accum += samples_per_frame_exact;
        const size_t target_frames  = size_t(sample_frame_accum);
        sample_frame_accum -= double(target_frames);
        const size_t target_samples = target_frames * our_ch;
        const size_t feed_samples   = std::min(audio_carry.size() - (audio_carry.size() % our_ch), target_samples);
        const size_t feed_frames    = feed_samples / our_ch;

        xfer.SetVideoBuffer(
            reinterpret_cast<ULWord*>(const_cast<uint8_t*>(video_bytes->data())),
            ULWord(video_bytes->size()));
        if (feed_frames > 0) {
            // SDI embedded audio is a fixed-width interleave (card_channels,
            // always 8 here — see the comment in start()) regardless of how
            // many of those channels actually carry real content. Feeding a
            // buffer interleaved at our_channels width into a system
            // configured for card_channels width would misalign every
            // sample after the first frame — expand into the full width,
            // silence-padding the unused channels, so byte offsets line up
            // with what the embedder actually expects.
            audio_padded.assign(feed_frames * size_t(impl_->card_channels), 0);
            for (size_t f = 0; f < feed_frames; ++f)
                for (size_t c = 0; c < our_ch; ++c)
                    audio_padded[f * impl_->card_channels + c] = audio_carry[f * our_ch + c];

            xfer.SetAudioBuffer(
                reinterpret_cast<ULWord*>(audio_padded.data()),
                ULWord(audio_padded.size() * sizeof(int32_t)));
        }

        impl_->card.AutoCirculateTransfer(ch, xfer);
        if (feed_samples > 0) {
            audio_carry.erase(audio_carry.begin(), audio_carry.begin() + feed_samples);
        }
        ++transfers;

        const auto now = std::chrono::steady_clock::now();
        if (now - diag_t0 >= std::chrono::seconds(1)) {
            if (freeze_repeats > 0) {
                std::cerr << "aja playout: " << freeze_repeats << "/" << transfers
                          << " transfers in the last second were freeze-frame"
                             " repeats (decoder underrun)\n";
            }
            transfers = 0; freeze_repeats = 0; diag_t0 = now;
        }
    }
}

void AJAPlayoutDevice::write_video(VideoFrame&& frame) {
    video_queue_.push(std::move(frame));
}

void AJAPlayoutDevice::write_audio(AudioFrame&& frame) {
    audio_queue_.push(std::move(frame));
}

void AJAPlayoutDevice::stop() {
    if (!impl_) return;
    impl_->running = false;
    if (impl_->playout_thread.joinable()) {
        impl_->playout_thread.request_stop();
        impl_->playout_thread.join();
    }
    const NTV2Channel ch = impl_->channel;
    impl_->card.AutoCirculateStop(ch);
    impl_->card.UnsubscribeOutputVerticalEvent(ch);
    impl_->card.Close();
    video_queue_.close();
    audio_queue_.close();
    std::cerr << "aja playout: stopped\n";
}

} // namespace sdi

#endif // SDI_WITH_AJA
