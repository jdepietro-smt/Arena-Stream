// NDIDevice — CaptureDevice backend that receives from an NDI source.
// See ndi_device.h for the public interface.

#ifdef SDI_WITH_NDI

#include "ndi_device.h"

#include <Processing.NDI.Lib.h>

#include <atomic>
#include <cstring>
#include <stdexcept>
#include <thread>

namespace sdi {

// ── NDI source discovery ─────────────────────────────────────────────────────

std::vector<std::string> ndi_list_sources(int timeout_ms) {
    if (!NDIlib_initialize()) return {};

    NDIlib_find_create_t fc{};
    fc.show_local_sources = true;
    fc.p_groups           = nullptr;
    fc.p_extra_ips        = nullptr;

    auto finder = NDIlib_find_create_v2(&fc);
    if (!finder) { NDIlib_destroy(); return {}; }

    NDIlib_find_wait_for_sources(finder, uint32_t(timeout_ms));

    uint32_t n = 0;
    const NDIlib_source_t* sources = NDIlib_find_get_current_sources(finder, &n);

    std::vector<std::string> result;
    result.reserve(n);
    for (uint32_t i = 0; i < n; ++i)
        if (sources[i].p_ndi_name)
            result.emplace_back(sources[i].p_ndi_name);

    NDIlib_find_destroy(finder);
    NDIlib_destroy();
    return result;
}

// ── NDIDevice implementation ─────────────────────────────────────────────────

struct NDIDevice::Impl {
    NDIlib_recv_instance_t recv = nullptr;
    std::thread            thread;
    std::atomic<bool>      running{false};
    VideoMode              mode{};
    VideoCallback          on_video;
    AudioCallback          on_audio;
};

NDIDevice::NDIDevice()  : impl_(std::make_unique<Impl>()) {}
NDIDevice::~NDIDevice() { stop(); }

bool NDIDevice::start(const CaptureConfig& cfg,
                      VideoCallback         on_video,
                      AudioCallback         on_audio) {
    if (!NDIlib_initialize()) return false;

    // --- locate the named source (retry a few times for late-arriving mDNS) ---
    NDIlib_find_create_t fc{};
    fc.show_local_sources = true;
    auto finder = NDIlib_find_create_v2(&fc);
    if (!finder) { NDIlib_destroy(); return false; }

    std::string  source_url;   // filled if we find the source
    bool         found = false;

    for (int attempt = 0; attempt < 4 && !found; ++attempt) {
        NDIlib_find_wait_for_sources(finder, 500u);
        uint32_t n = 0;
        const NDIlib_source_t* srcs =
            NDIlib_find_get_current_sources(finder, &n);
        for (uint32_t i = 0; i < n; ++i) {
            if (srcs[i].p_ndi_name &&
                cfg.device_id == srcs[i].p_ndi_name) {
                if (srcs[i].p_url_address) source_url = srcs[i].p_url_address;
                found = true;
                break;
            }
        }
    }
    NDIlib_find_destroy(finder);

    // Build the source descriptor even if we didn't find it in the scan —
    // the receiver will keep retrying until the source appears.
    NDIlib_source_t target{};
    target.p_ndi_name    = cfg.device_id.c_str();
    target.p_url_address = source_url.empty() ? nullptr : source_url.c_str();

    NDIlib_recv_create_v3_t rc{};
    rc.source_to_connect_to = target;
    // Request UYVY so we can feed it directly into the encode chain without
    // conversion.  Fall back to whatever the source sends if UYVY isn't
    // available (best-effort colour fidelity).
    rc.color_format       = NDIlib_recv_color_format_UYVY_BGRA;
    rc.bandwidth          = NDIlib_recv_bandwidth_highest;
    rc.allow_video_fields = true;   // preserve interlace field order

    impl_->recv = NDIlib_recv_create_v3(&rc);
    if (!impl_->recv) { NDIlib_destroy(); return false; }

    impl_->on_video = std::move(on_video);
    impl_->on_audio = std::move(on_audio);
    impl_->running.store(true);

    // --- receiver thread ---
    impl_->thread = std::thread([this]() {
        auto& imp = *impl_;
        uint64_t vid_seq = 0, aud_seq = 0;

        while (imp.running.load()) {
            NDIlib_video_frame_v2_t  vf{};
            NDIlib_audio_frame_v3_t  af{};
            NDIlib_metadata_frame_t  mf{};

            auto type = NDIlib_recv_capture_v3(
                imp.recv, &vf, &af, &mf, /*timeout_ms=*/100u);

            switch (type) {
            // ── Video ───────────────────────────────────────────────────────
            case NDIlib_frame_type_video: {
                VideoFrame out{};
                out.mode.width    = uint32_t(vf.xres);
                out.mode.height   = uint32_t(vf.yres);
                out.mode.fps_num  = uint32_t(vf.frame_rate_N);
                out.mode.fps_den  = uint32_t(vf.frame_rate_D);
                out.mode.interlaced =
                    (vf.frame_format_type == NDIlib_frame_format_type_interleaved ||
                     vf.frame_format_type == NDIlib_frame_format_type_field_0     ||
                     vf.frame_format_type == NDIlib_frame_format_type_field_1);
                out.mode.format = PixelFormat::UYVY422_8;
                out.stride      = uint32_t(vf.line_stride_in_bytes);
                out.pts         = Nanos{0};
                out.sequence    = vid_seq++;

                const size_t n_bytes =
                    size_t(vf.line_stride_in_bytes) * size_t(vf.yres);
                out.data.resize(n_bytes);
                std::memcpy(out.data.data(), vf.p_data, n_bytes);

                // Latch the mode from the first valid frame.
                if (out.mode.width > 0 && imp.mode.width == 0)
                    imp.mode = out.mode;

                if (imp.on_video) imp.on_video(std::move(out));
                NDIlib_recv_free_video_v2(imp.recv, &vf);
                break;
            }
            // ── Audio ───────────────────────────────────────────────────────
            case NDIlib_frame_type_audio: {
                if (imp.on_audio && af.p_data && af.no_samples > 0) {
                    AudioFrame out{};
                    out.channels    = uint32_t(af.no_channels);
                    out.sample_rate = uint32_t(af.sample_rate);
                    out.pts         = Nanos{0};
                    out.sequence    = aud_seq++;

                    const int n_samp = af.no_samples;
                    const int n_ch   = af.no_channels;
                    out.samples.resize(size_t(n_samp * n_ch));

                    // NDI audio is FLTP (float planar) → convert to S32LE interleaved
                    constexpr float kScale = float(0x7FFFFFFF);
                    for (int c = 0; c < n_ch; ++c) {
                        const float* ch_ptr = reinterpret_cast<const float*>(
                            reinterpret_cast<const uint8_t*>(af.p_data)
                            + size_t(c) * size_t(af.channel_stride_in_bytes));
                        for (int s = 0; s < n_samp; ++s) {
                            float v = ch_ptr[s];
                            if (v >  1.0f) v =  1.0f;
                            if (v < -1.0f) v = -1.0f;
                            out.samples[size_t(s * n_ch + c)] =
                                int32_t(v * kScale);
                        }
                    }
                    imp.on_audio(std::move(out));
                }
                NDIlib_recv_free_audio_v3(imp.recv, &af);
                break;
            }
            // ── Metadata ────────────────────────────────────────────────────
            case NDIlib_frame_type_metadata:
                NDIlib_recv_free_metadata(imp.recv, &mf);
                break;
            // ── Timeout / status change ──────────────────────────────────────
            case NDIlib_frame_type_none:
            case NDIlib_frame_type_status_change:
            default:
                break;
            }
        }
    });

    return true;
}

void NDIDevice::stop() {
    if (!impl_->running.exchange(false)) return;
    if (impl_->thread.joinable()) impl_->thread.join();
    if (impl_->recv) {
        NDIlib_recv_destroy(impl_->recv);
        impl_->recv = nullptr;
    }
    NDIlib_destroy();
}

VideoMode NDIDevice::current_mode() const { return impl_->mode; }

}  // namespace sdi

#endif  // SDI_WITH_NDI
