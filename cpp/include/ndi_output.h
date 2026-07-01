#pragma once
//
// NDIOutput — simultaneously broadcasts the captured SDI signal as an NDI source
// on the local LAN while it is being encoded/streamed.
//
// Usage:
//   NDIOutput ndi("My SDI Channel");
//   // in video worker:
//   ndi.send_video(frame);
//   // in audio worker:
//   ndi.send_audio(frame);
//
// Video is sent as UYVY422 — NDI's native format, so no pixel-format conversion
// happens at all.  Audio is converted from capture-native S32 interleaved PCM
// to NDI-native FLTP (float planar) in a small scratch buffer.
//
// NDIlib_initialize / NDIlib_destroy are called in the constructor / destructor.
// If you need multiple NDI components in the same process and the SDK is not
// reference-counted in your SDK version, call NDIlib_initialize() once in main()
// instead and remove the calls here.

#ifdef SDI_WITH_NDI

#include "frame.h"

#include <stdexcept>
#include <string>
#include <vector>

#include <Processing.NDI.Lib.h>

namespace sdi {

class NDIOutput {
public:
    explicit NDIOutput(const std::string& ndi_name) {
        if (!NDIlib_initialize())
            throw std::runtime_error("NDIOutput: NDIlib_initialize() failed");

        NDIlib_send_create_t cfg{};
        cfg.p_ndi_name  = ndi_name.c_str();
        cfg.clock_video = false;   // we are clock master (SDI-locked)
        cfg.clock_audio = false;

        sender_ = NDIlib_send_create(&cfg);
        if (!sender_) {
            NDIlib_destroy();
            throw std::runtime_error(
                "NDIOutput: NDIlib_send_create failed for '" + ndi_name + "'");
        }
    }

    ~NDIOutput() {
        if (sender_) NDIlib_send_destroy(sender_);
        NDIlib_destroy();
    }

    NDIOutput(const NDIOutput&)            = delete;
    NDIOutput& operator=(const NDIOutput&) = delete;

    // Send one video frame.  The frame data is copied inside the NDI SDK;
    // the caller may free vf immediately after return.
    void send_video(const VideoFrame& vf) {
        if (!sender_ || vf.data.empty()) return;

        NDIlib_video_frame_v2_t nf{};
        nf.xres                 = int(vf.mode.width);
        nf.yres                 = int(vf.mode.height);
        nf.FourCC               = NDIlib_FourCC_video_type_UYVY;
        nf.frame_rate_N         = int(vf.mode.fps_num);
        nf.frame_rate_D         = int(vf.mode.fps_den);
        nf.picture_aspect_ratio = float(vf.mode.width) / float(vf.mode.height);
        nf.frame_format_type    = vf.mode.interlaced
            ? NDIlib_frame_format_type_interleaved
            : NDIlib_frame_format_type_progressive;
        nf.timecode             = NDIlib_send_timecode_synthesize;
        // NDI expects non-const but does not modify the data.
        nf.p_data               = const_cast<uint8_t*>(vf.data.data());
        nf.line_stride_in_bytes = int(vf.stride);

        NDIlib_send_send_video_v2(sender_, &nf);
    }

    // Send one audio frame.  Converts S32LE interleaved → FLTP before sending.
    void send_audio(const AudioFrame& af) {
        if (!sender_ || af.samples.empty() || af.channels == 0) return;

        const int n_ch   = int(af.channels);
        const int n_samp = int(af.samples.size()) / n_ch;
        if (n_samp <= 0) return;

        // Grow scratch buffer on the first call or on frame-size increase.
        float_buf_.resize(size_t(n_ch) * size_t(n_samp));

        // S32LE interleaved  →  FLTP planar  (float, range −1…+1)
        constexpr float kScale = 1.0f / 2147483648.0f;
        for (int c = 0; c < n_ch; ++c) {
            float* dst = float_buf_.data() + c * n_samp;
            for (int s = 0; s < n_samp; ++s)
                dst[s] = float(af.samples[size_t(s * n_ch + c)]) * kScale;
        }

        NDIlib_audio_frame_v3_t na{};
        na.sample_rate             = int(af.sample_rate);
        na.no_channels             = n_ch;
        na.no_samples              = n_samp;
        na.timecode                = NDIlib_send_timecode_synthesize;
        na.FourCC                  = NDIlib_FourCC_audio_type_FLTP;
        na.p_data                  = reinterpret_cast<uint8_t*>(float_buf_.data());
        na.channel_stride_in_bytes = int(n_samp * sizeof(float));

        NDIlib_send_send_audio_v3(sender_, &na);
    }

private:
    NDIlib_send_instance_t sender_ = nullptr;
    std::vector<float>     float_buf_;
};

}  // namespace sdi

#endif  // SDI_WITH_NDI
