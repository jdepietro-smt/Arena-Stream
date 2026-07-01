// SMPTE 2022-7 sender redundancy + SRT auto-reconnect implementations.
// See redundancy.h for the design overview.

#include "redundancy.h"

#include <algorithm>
#include <chrono>
#include <iostream>

namespace sdi {

// Diagnostic: wall-clock reference for measuring true first-successful-write
// timing (distinct from "first call" timing, which can be misleadingly early
// if packets are silently dropped while the SRT connection is still coming up).
static const auto g_diag_t0 = std::chrono::steady_clock::now();
static std::atomic<bool> g_diag_logged_v{false};
static std::atomic<bool> g_diag_logged_a{false};

// ===========================================================================
// ReconnectingSrtOutput
// ===========================================================================

ReconnectingSrtOutput::ReconnectingSrtOutput(
    SrtOutputConfig           cfg,
    AVCodecContext*           vctx,
    AVCodecContext*           actx,
    std::chrono::milliseconds initial_backoff,
    std::chrono::milliseconds max_backoff)
    : cfg_(std::move(cfg))
    , vctx_(vctx)
    , actx_(actx)
    , initial_backoff_(initial_backoff)
    , max_backoff_(max_backoff)
{
    // Start the reconnect thread. It will establish the first connection
    // immediately (need_reconnect_ is initialised to true).
    reconnect_thread_ = std::jthread([this](std::stop_token st) {
        reconnect_loop(st);
    });
}

ReconnectingSrtOutput::~ReconnectingSrtOutput() {
    // jthread destructor calls request_stop() + join().
    // After join, the reconnect thread is done, so we can safely destroy out_.
}

void ReconnectingSrtOutput::signal_reconnect() {
    need_reconnect_.store(true, std::memory_order_release);
    reconnect_cv_.notify_one();
}

void ReconnectingSrtOutput::write_video(AVPacket* pkt) {
    std::shared_lock lock(mtx_);
    if (!out_) return;
    if (!g_diag_logged_v.exchange(true)) {
        const double wall_ms = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - g_diag_t0).count();
        std::cerr << "diag: first video packet ACTUALLY SENT wall_ms=" << wall_ms
                  << " pkt_pts=" << pkt->pts << "\n";
    }
    if (int ret = out_->write_video(pkt); ret < 0) {
        char errbuf[128];
        av_strerror(ret, errbuf, sizeof(errbuf));
        std::cerr << "srt [" << cfg_.uri << "]: write_video failed: "
                  << errbuf << " (" << ret << ")\n";
        if (consecutive_failures_.fetch_add(1, std::memory_order_relaxed) + 1
            >= kConsecutiveFailureThreshold)
            signal_reconnect();
    } else {
        consecutive_failures_.store(0, std::memory_order_relaxed);
    }
}

void ReconnectingSrtOutput::write_audio(AVPacket* pkt) {
    std::shared_lock lock(mtx_);
    if (!out_) return;
    if (!g_diag_logged_a.exchange(true)) {
        const double wall_ms = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - g_diag_t0).count();
        std::cerr << "diag: first audio packet ACTUALLY SENT wall_ms=" << wall_ms
                  << " pkt_pts=" << pkt->pts << "\n";
    }
    if (int ret = out_->write_audio(pkt); ret < 0) {
        char errbuf[128];
        av_strerror(ret, errbuf, sizeof(errbuf));
        std::cerr << "srt [" << cfg_.uri << "]: write_audio failed: "
                  << errbuf << " (" << ret << ")\n";
        if (consecutive_failures_.fetch_add(1, std::memory_order_relaxed) + 1
            >= kConsecutiveFailureThreshold)
            signal_reconnect();
    } else {
        consecutive_failures_.store(0, std::memory_order_relaxed);
    }
}

void ReconnectingSrtOutput::reconnect_loop(std::stop_token st) {
    auto backoff = initial_backoff_;

    while (!st.stop_requested()) {
        // Wait until a reconnect is needed (or stop is requested).
        {
            std::unique_lock lock(mtx_);
            reconnect_cv_.wait(lock, st,
                [this] { return need_reconnect_.load(std::memory_order_acquire); });
            if (st.stop_requested()) break;

            // Tear down the existing connection under the exclusive lock.
            // SrtOutput destructor writes trailer + closes socket.
            // This may block briefly if the network is down; that is acceptable
            // because the lock prevents workers from writing to a dead socket.
            connected_.store(false, std::memory_order_release);
            out_.reset();
            need_reconnect_.store(false, std::memory_order_release);
        }

        // Back-off outside the lock so workers aren't blocked while sleeping.
        if (reconnect_count_.load() > 0) {
            std::cerr << "srt [" << cfg_.uri << "]: reconnecting in "
                      << backoff.count() << "ms\n";
            // Interruptible sleep: wake early if stop is requested.
            auto deadline = std::chrono::steady_clock::now() + backoff;
            while (!st.stop_requested() &&
                   std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            if (st.stop_requested()) break;
            backoff = std::min(backoff * 2, max_backoff_);
        }

        if (try_connect())
            backoff = initial_backoff_;  // reset back-off on success
    }
}

bool ReconnectingSrtOutput::try_connect() {
    try {
        auto candidate = std::make_unique<SrtOutput>(cfg_, vctx_, actx_);

        std::unique_lock lock(mtx_);
        out_ = std::move(candidate);
        connected_.store(true, std::memory_order_release);
        consecutive_failures_.store(0, std::memory_order_relaxed);
        reconnect_count_.fetch_add(1, std::memory_order_relaxed);
        std::cerr << "srt [" << cfg_.uri << "]: connected"
                  << (reconnect_count_.load() > 1
                      ? " (reconnect #" + std::to_string(reconnect_count_.load()) + ")"
                      : "") << "\n";
        return true;
    } catch (const std::exception& e) {
        std::cerr << "srt [" << cfg_.uri << "]: connect failed: " << e.what() << "\n";
        // Schedule another attempt.
        need_reconnect_.store(true, std::memory_order_release);
        return false;
    }
}

// ===========================================================================
// DualSrtOutput
// ===========================================================================

DualSrtOutput::DualSrtOutput(
    SrtOutputConfig path1_cfg,
    SrtOutputConfig path2_cfg,
    AVCodecContext* vctx,
    AVCodecContext* actx)
    : p1_(std::move(path1_cfg), vctx, actx)
    , p2_(std::move(path2_cfg), vctx, actx)
{}

DualSrtOutput::~DualSrtOutput() = default;

void DualSrtOutput::write_video(AVPacket* pkt) {
    // Write to path 1 directly.
    p1_.write_video(pkt);

    // Ref-copy for path 2: libavformat may consume (unref) the packet data
    // inside av_interleaved_write_frame, so path 2 needs its own reference.
    AVPacket* copy = av_packet_alloc();
    if (av_packet_ref(copy, pkt) == 0) {
        p2_.write_video(copy);
    }
    av_packet_free(&copy);
}

void DualSrtOutput::write_audio(AVPacket* pkt) {
    p1_.write_audio(pkt);

    AVPacket* copy = av_packet_alloc();
    if (av_packet_ref(copy, pkt) == 0) {
        p2_.write_audio(copy);
    }
    av_packet_free(&copy);
}

// ===========================================================================
// RedundancyReceiver
// ===========================================================================

RedundancyReceiver::RedundancyReceiver(
    std::chrono::milliseconds window,
    int                       video_stream_index,
    int                       audio_stream_index,
    EmitFn                    emit_video,
    EmitFn                    emit_audio)
    : window_(window)
    , vsi_(video_stream_index)
    , asi_(audio_stream_index)
    , emit_video_(std::move(emit_video))
    , emit_audio_(std::move(emit_audio))
{
    output_thread_ = std::jthread([this](std::stop_token st) {
        output_loop(st);
    });
}

RedundancyReceiver::~RedundancyReceiver() {
    // jthread destructor stops and joins output_thread_.
    // Drain any remaining buffered packets.
    std::lock_guard lock(mtx_);
    for (auto& e : buf_) av_packet_free(&e.pkt);
    buf_.clear();
}

void RedundancyReceiver::push(int /*path_id*/, AVPacket* pkt) {
    const int64_t pts = (pkt->pts != AV_NOPTS_VALUE) ? pkt->pts : pkt->dts;

    // Make a copy so the caller can safely unref the original packet.
    AVPacket* copy = av_packet_alloc();
    if (!copy || av_packet_ref(copy, pkt) < 0) {
        av_packet_free(&copy);
        return;
    }

    {
        std::lock_guard lock(mtx_);
        buf_.push_back(Entry{
            .pkt          = copy,
            .stream_index = pkt->stream_index,
            .pts          = pts,
            .arrived      = std::chrono::steady_clock::now(),
        });
    }
    cv_.notify_one();
}

void RedundancyReceiver::output_loop(std::stop_token st) {
    while (!st.stop_requested()) {
        std::unique_lock lock(mtx_);

        // Wake when something is in the buffer or on stop.
        cv_.wait_for(lock, std::chrono::milliseconds(10),
            [&] { return !buf_.empty() || st.stop_requested(); });

        if (st.stop_requested() && buf_.empty()) break;

        const auto now = std::chrono::steady_clock::now();

        // Sort buf_ by pts so we emit in presentation order.
        std::stable_sort(buf_.begin(), buf_.end(),
            [](const Entry& a, const Entry& b) { return a.pts < b.pts; });

        // Drain entries that have been held for >= window_ms.
        while (!buf_.empty()) {
            auto& front = buf_.front();
            if ((now - front.arrived) < window_ && !st.stop_requested())
                break;  // not yet; keep waiting

            Entry e = std::move(front);
            buf_.pop_front();

            // Evict stale seen-set entries before checking.
            evict_seen(now);

            PtsKey key{e.stream_index, e.pts};
            if (e.pts != AV_NOPTS_VALUE && seen_.count(key)) {
                // Duplicate from the other path — discard.
                av_packet_free(&e.pkt);
                continue;
            }

            // First copy: mark as seen and emit.
            if (e.pts != AV_NOPTS_VALUE) {
                seen_.insert(key);
                seen_evict_.push_back({key, now + window_ * 2});
            }

            lock.unlock();
            if (e.stream_index == vsi_ && emit_video_)
                emit_video_(e.pkt);
            else if (e.stream_index == asi_ && emit_audio_)
                emit_audio_(e.pkt);
            av_packet_free(&e.pkt);
            lock.lock();
        }
    }
}

void RedundancyReceiver::evict_seen(std::chrono::steady_clock::time_point now) {
    while (!seen_evict_.empty() && seen_evict_.front().evict_at <= now) {
        seen_.erase(seen_evict_.front().key);
        seen_evict_.pop_front();
    }
}

} // namespace sdi
