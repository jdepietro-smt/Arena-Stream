// Blackmagic DeckLink capture backend.
//
// DeckLink uses a COM-style callback model on all platforms:
//   1. Obtain an IDeckLinkIterator (platform-specific, see below).
//   2. Walk the iterator to the desired device index.
//   3. QueryInterface(IID_IDeckLinkInput) → get the input interface.
//   4. EnableVideoInput with bmdVideoInputEnableFormatDetection so the card
//      reports format changes automatically via VideoInputFormatChanged.
//   5. EnableAudioInput at 48 kHz / S32 / N channels.
//   6. SetCallback(our IDeckLinkInputCallback subclass).
//   7. StartStreams() — frames begin arriving on the SDK's internal thread.
//
// Platform differences for step 1:
//   Linux / macOS: Call CreateDeckLinkIteratorInstance() — implemented in
//       DeckLinkAPIDispatch.cpp, compiled into sdi_decklink by CMakeLists.
//   Windows:       DeckLink is a registered COM in-process server.
//       CoCreateInstance(CLSID_CDeckLinkIterator) retrieves the iterator.
//       DeckLinkAPIDispatch.cpp is NOT needed and NOT compiled on Windows.
//
// SDK reference: Desktop Video SDK Manual, "Capturing" chapter.

#ifdef SDI_WITH_DECKLINK

#include "decklink_device.h"

// On Windows the MIDL-generated DeckLinkAPI.h uses the 'interface' keyword
// and MIDL_INTERFACE macro which require COM headers to be included first.
#ifdef _WIN32
#  include <objbase.h>
#endif
#include "DeckLinkAPI.h"

#include <atomic>
#include <cstring>
#include <iostream>
#include <stdexcept>

namespace sdi {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static VideoMode mode_from_decklink(IDeckLinkDisplayMode* dm, BMDPixelFormat pf) {
    VideoMode m;
    m.width    = uint32_t(dm->GetWidth());
    m.height   = uint32_t(dm->GetHeight());
    BMDTimeValue fp_val; BMDTimeScale fp_scale;
    dm->GetFrameRate(&fp_val, &fp_scale);
    // fp_scale is the timescale (e.g. 60000), fp_val is the frame duration
    // (e.g. 1001), so fps = fp_scale / fp_val.
    m.fps_num  = uint32_t(fp_scale);
    m.fps_den  = uint32_t(fp_val);
    const auto dom = dm->GetFieldDominance();
    m.interlaced = (dom != bmdProgressiveFrame &&
                    dom != bmdProgressiveSegmentedFrame);
    m.format   = (pf == bmdFormat10BitYUV) ? PixelFormat::V210_10
                                           : PixelFormat::UYVY422_8;
    return m;
}

// ---------------------------------------------------------------------------
// Impl forward declaration — needed before InputCallback.
// ---------------------------------------------------------------------------

struct DeckLinkDevice::Impl {
    IDeckLink*      device         = nullptr;
    IDeckLinkInput* input          = nullptr;

    // Points to DeckLinkDevice::mode_ so InputCallback can update it
    // when VideoInputFormatChanged fires. The DeckLink SDK guarantees
    // that format-changed fires before the first frame on that format,
    // so current_mode() will be accurate by the time frames arrive.
    VideoMode*      mode_ptr       = nullptr;

    uint32_t        audio_channels = 2;
    VideoCallback   on_video;
    AudioCallback   on_audio;
    std::atomic<uint64_t> seq_video{0};
    std::atomic<uint64_t> seq_audio{0};

    // Set after callback installation so InputCallback can refer back.
    class InputCallback* callback  = nullptr;
};

// ---------------------------------------------------------------------------
// InputCallback — runs on the DeckLink driver's internal thread.
// ---------------------------------------------------------------------------

class InputCallback : public IDeckLinkInputCallback {
public:
    InputCallback(DeckLinkDevice::Impl* impl, IDeckLinkInput* input)
        : impl_(impl), input_(input), ref_(1) {}

    // IUnknown
    HRESULT QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
    ULONG   AddRef()  override { return ++ref_; }
    ULONG   Release() override {
        auto r = --ref_;
        if (r == 0) delete this;
        return r;
    }

    HRESULT VideoInputFrameArrived(IDeckLinkVideoInputFrame* vf,
                                   IDeckLinkAudioInputPacket* ap) override {
        if (vf && !(vf->GetFlags() & bmdFrameHasNoInputSource)) {
            void* bytes = nullptr;
            // GetBytes is on IDeckLinkVideoFrame (parent). On Windows with the
            // MIDL-generated header, inherited methods are not visible directly
            // on IDeckLinkVideoInputFrame — cast to the base interface.
            IDeckLinkVideoFrame* baseFrame = static_cast<IDeckLinkVideoFrame*>(vf);
            if (baseFrame->GetBytes(&bytes) == S_OK && bytes) {
                int64_t pts_ns = 0;
#ifdef _WIN32
                // Windows SDK 16.0 reordered GetStreamTime parameters:
                // (BMDTimeValue *frameTime, BMDTimeValue *frameDuration, BMDTimeScale timeScale)
                BMDTimeValue frameDuration = 0;
                vf->GetStreamTime(reinterpret_cast<BMDTimeValue*>(&pts_ns),
                                  &frameDuration, 1'000'000'000LL);
#else
                vf->GetStreamTime(&pts_ns, 1'000'000'000LL, 1);
#endif

                VideoFrame frame;
                frame.stride   = uint32_t(vf->GetRowBytes());
                frame.mode     = *impl_->mode_ptr;
                frame.pts      = Nanos{pts_ns};
                frame.sequence = impl_->seq_video.fetch_add(1, std::memory_order_relaxed);
                const auto nbytes = frame.stride * uint32_t(vf->GetHeight());
                frame.data.assign(static_cast<uint8_t*>(bytes),
                                  static_cast<uint8_t*>(bytes) + nbytes);
                impl_->on_video(std::move(frame));
            }
        }

        if (ap) {
            void* abytes = nullptr;
            if (ap->GetBytes(&abytes) == S_OK && abytes) {
                const long nsamples = ap->GetSampleFrameCount();
                int64_t pts_ns = 0;
                ap->GetPacketTime(reinterpret_cast<BMDTimeValue*>(&pts_ns),
                                  1'000'000'000LL);

                AudioFrame af;
                af.channels    = impl_->audio_channels;
                af.sample_rate = 48000;
                af.pts         = Nanos{pts_ns};
                af.sequence    = impl_->seq_audio.fetch_add(1, std::memory_order_relaxed);
                const auto* src = static_cast<int32_t*>(abytes);
                af.samples.assign(src, src + nsamples * long(af.channels));
                impl_->on_audio(std::move(af));
            }
        }
        return S_OK;
    }

    HRESULT VideoInputFormatChanged(BMDVideoInputFormatChangedEvents,
                                    IDeckLinkDisplayMode* new_mode,
                                    BMDDetectedVideoInputFormatFlags flags) override {
        const BMDPixelFormat pf =
            (flags & bmdDetectedVideoInputRGB444) ? bmdFormat10BitRGB
                                                  : bmdFormat8BitYUV;
        *impl_->mode_ptr = mode_from_decklink(new_mode, pf);

        std::cerr << "decklink: format changed → "
                  << impl_->mode_ptr->width << "x" << impl_->mode_ptr->height
                  << " @" << (double(impl_->mode_ptr->fps_num) /
                               impl_->mode_ptr->fps_den) << "fps"
                  << (impl_->mode_ptr->interlaced ? " interlaced" : " progressive")
                  << "\n";

        // Reconfigure with the new display mode while streams are running.
        input_->StopStreams();
        input_->EnableVideoInput(new_mode->GetDisplayMode(), pf,
                                 bmdVideoInputEnableFormatDetection);
        input_->FlushStreams();
        input_->StartStreams();
        return S_OK;
    }

private:
    DeckLinkDevice::Impl* impl_;
    IDeckLinkInput*       input_;
    std::atomic<ULONG>    ref_;
};

// ---------------------------------------------------------------------------
// DeckLinkDevice
// ---------------------------------------------------------------------------

DeckLinkDevice::DeckLinkDevice()
    : impl_(std::make_unique<Impl>()) {}

DeckLinkDevice::~DeckLinkDevice() { stop(); }

bool DeckLinkDevice::start(const CaptureConfig& cfg,
                           VideoCallback on_video,
                           AudioCallback on_audio) {
    impl_->on_video        = std::move(on_video);
    impl_->on_audio        = std::move(on_audio);
    impl_->audio_channels  = cfg.audio_channels;
    impl_->mode_ptr        = &mode_;

    // --- 1. Enumerate and select device by index. ---
#ifdef _WIN32
    // Windows: DeckLink is a COM in-process server registered during Desktop Video
    // installation. CoInitialize must be called on the thread before any COM usage;
    // calling it multiple times is harmless (returns S_FALSE on subsequent calls).
    ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    IDeckLinkIterator* it = nullptr;
    HRESULT hr = ::CoCreateInstance(CLSID_CDeckLinkIterator, nullptr, CLSCTX_ALL,
                                    IID_IDeckLinkIterator,
                                    reinterpret_cast<void**>(&it));
    if (FAILED(hr) || !it) {
        std::cerr << "decklink: CoCreateInstance(CLSID_CDeckLinkIterator) failed "
                     "(HRESULT=0x" << std::hex << hr << std::dec << ") — "
                     "is Desktop Video installed?\n";
        return false;
    }
#else
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) {
        std::cerr << "decklink: CreateDeckLinkIteratorInstance() failed — "
                     "is Desktop Video installed and the driver loaded?\n";
        return false;
    }
#endif

    int target = 0;
    try { target = std::stoi(cfg.device_id); } catch (...) {}

    for (int i = 0; i <= target; ++i) {
        if (impl_->device) { impl_->device->Release(); impl_->device = nullptr; }
        if (it->Next(&impl_->device) != S_OK) {
            it->Release();
            std::cerr << "decklink: device index " << target << " not found "
                         "(only " << i << " device(s) enumerated)\n";
            return false;
        }
    }
    it->Release();

    // --- 2. Get the IDeckLinkInput interface. ---
    if (impl_->device->QueryInterface(
            IID_IDeckLinkInput,
            reinterpret_cast<void**>(&impl_->input)) != S_OK) {
        std::cerr << "decklink: QueryInterface(IDeckLinkInput) failed — "
                     "device may be output-only\n";
        return false;
    }

    // --- 3. Install callback. ---
    impl_->callback = new InputCallback(impl_.get(), impl_->input);
    if (impl_->input->SetCallback(impl_->callback) != S_OK) {
        std::cerr << "decklink: SetCallback failed\n";
        return false;
    }

    // --- 4. Enable video input. ---
    // bmdModeHD1080p5994 is used as the initial hint when auto-detecting;
    // VideoInputFormatChanged will fire with the actual format before the
    // first frame arrives. For a fixed mode, map cfg.requested_mode here.
    const BMDDisplayMode bmd_mode = bmdModeHD1080p5994;
    const BMDPixelFormat bmd_pf   = bmdFormat8BitYUV;  // UYVY; 10-bit → bmdFormat10BitYUV
    const BMDVideoInputFlags vflags = cfg.auto_detect
        ? bmdVideoInputEnableFormatDetection
        : bmdVideoInputFlagDefault;

    if (impl_->input->EnableVideoInput(bmd_mode, bmd_pf, vflags) != S_OK) {
        std::cerr << "decklink: EnableVideoInput failed\n";
        return false;
    }

    // --- 5. Enable audio input: 48 kHz, 32-bit integer, N channels. ---
    if (impl_->input->EnableAudioInput(
            bmdAudioSampleRate48kHz,
            bmdAudioSampleType32bitInteger,
            cfg.audio_channels) != S_OK) {
        std::cerr << "decklink: EnableAudioInput failed\n";
        return false;
    }

    // Seed the mode from config. VideoInputFormatChanged overwrites this
    // once the signal is detected.
    mode_ = (cfg.requested_mode.width > 0)
        ? cfg.requested_mode
        : VideoMode{1920, 1080, 60000, 1001, false, PixelFormat::UYVY422_8};

    // --- 6. Start streaming. ---
    if (impl_->input->StartStreams() != S_OK) {
        std::cerr << "decklink: StartStreams failed\n";
        return false;
    }

    std::cerr << "decklink: started — device=" << cfg.device_id
              << " initial_mode=" << mode_.width << "x" << mode_.height
              << " @" << (double(mode_.fps_num) / mode_.fps_den) << "fps"
              << (cfg.auto_detect ? " (format auto-detect enabled)\n" : "\n");
    return true;
}

void DeckLinkDevice::stop() {
    if (!impl_ || !impl_->input) return;

    impl_->input->StopStreams();
    impl_->input->DisableVideoInput();
    impl_->input->DisableAudioInput();
    impl_->input->SetCallback(nullptr);

    if (impl_->callback) {
        impl_->callback->Release();
        impl_->callback = nullptr;
    }
    impl_->input->Release();
    impl_->input = nullptr;

    if (impl_->device) {
        impl_->device->Release();
        impl_->device = nullptr;
    }
    std::cerr << "decklink: stopped\n";
}

void decklink_list_devices(
    std::function<void(int, int, const std::string&, const std::string&)> emit)
{
#ifdef _WIN32
    ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IDeckLinkIterator* it = nullptr;
    if (FAILED(::CoCreateInstance(CLSID_CDeckLinkIterator, nullptr, CLSCTX_ALL,
                                  IID_IDeckLinkIterator,
                                  reinterpret_cast<void**>(&it))) || !it)
        return;
#else
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) return;
#endif

    IDeckLink* dl = nullptr;
    int idx = 0;
    while (it->Next(&dl) == S_OK) {
#ifdef _WIN32
        BSTR nameW = nullptr;
        dl->GetDisplayName(&nameW);
        std::string name = "DeckLink #" + std::to_string(idx);
        if (nameW) {
            int len = WideCharToMultiByte(CP_UTF8, 0, nameW, -1, nullptr, 0, nullptr, nullptr);
            if (len > 0) {
                name.resize(size_t(len - 1));
                WideCharToMultiByte(CP_UTF8, 0, nameW, -1, name.data(), len, nullptr, nullptr);
            }
            SysFreeString(nameW);
        }
#else
        const char* cname = nullptr;
        dl->GetDisplayName(&cname);
        std::string name = cname ? cname : ("DeckLink #" + std::to_string(idx));
        if (cname) free(const_cast<char*>(cname));
#endif
        emit(idx, 1, name, "decklink");
        dl->Release();
        ++idx;
    }
    it->Release();
}

} // namespace sdi

#endif // SDI_WITH_DECKLINK
