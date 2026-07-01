#pragma once
//
// SMPTE 2022-7 sender-side redundancy + SRT auto-reconnect.
//
// ReconnectingSrtOutput
//   Wraps SrtOutput. Write failures trigger a background reconnect with
//   exponential back-off. Workers never block waiting for reconnection —
//   packets written during the reconnect window are silently dropped
//   (the receiver handles gaps via its jitter buffer or the second path).
//
// DualSrtOutput
//   Writes identical packets to two independent ReconnectingSrtOutput
//   instances. Each path reconnects independently; a failure on one path
//   is transparent to the caller. This is the sender half of 2022-7.
//
// RedundancyReceiver
//   Accepts AVPackets from two SrtInput instances and deduplicates by
//   (stream_index, PTS). Packets are held for `window_ms` before output
//   so both paths have time to deliver their copies. This is the receiver
//   half of 2022-7.

#include "srt_output.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <thread>
#include <unordered_set>

namespace sdi {

// ---------------------------------------------------------------------------
// ReconnectingSrtOutput
// ---------------------------------------------------------------------------

class ReconnectingSrtOutput {
public:
    ReconnectingSrtOutput(
        SrtOutputConfig                  cfg,
        AVCodecContext*                  vctx,
        AVCodecContext*                  actx          = nullptr,
        std::chrono::milliseconds        initial_backoff = std::chrono::seconds{1},
        std::chrono::milliseconds        max_backoff     = std::chrono::seconds{30});

    ~ReconnectingSrtOutput();

    ReconnectingSrtOutput(const ReconnectingSrtOutput&)            = delete;
    ReconnectingSrtOutput& operator=(const ReconnectingSrtOutput&) = delete;

    // These are safe to call concurrently from multiple threads.
    // Packets written while the connection is down are dropped silently.
    void write_video(AVPacket* pkt);
    void write_audio(AVPacket* pkt);

    bool is_connected()    const { return connected_.load(std::memory_order_acquire); }
    int  reconnect_count() const { return reconnect_count_.load(); }

private:
    void reconnect_loop(std::stop_token st);
    bool try_connect();
    void signal_reconnect();

    SrtOutputConfig   cfg_;
    AVCodecContext*   vctx_;
    AVCodecContext*   actx_;

    // Guards `out_`. Workers hold shared (read) lock; the reconnect thread
    // holds exclusive (write) lock while swapping out_.
    mutable std::shared_mutex         mtx_;
    std::unique_ptr<SrtOutput>        out_;   // null while disconnected

    std::atomic<bool>                 need_reconnect_{true};  // start by connecting
    std::condition_variable_any       reconnect_cv_;
    std::jthread                      reconnect_thread_;

    std::atomic<bool>                 connected_{false};
    std::atomic<int>                  reconnect_count_{0};
    std::chrono::milliseconds         initial_backoff_;
    std::chrono::milliseconds         max_backoff_;

    // A single rejected packet (e.g. a muxer-level validation error like a
    // non-monotonic-dts check) does NOT mean the connection itself is dead —
    // av_write_frame/av_interleaved_write_frame can return a negative code for
    // one bad packet while leaving the underlying socket perfectly usable for
    // the next one. Tearing down and re-establishing the whole connection on
    // every single rejected packet, when the rejection itself recurs on the
    // first packet of any fresh connection (observed with the RTSP muxer),
    // produces an infinite reconnect loop that never delivers a single frame.
    // Only escalate to a real reconnect after several CONSECUTIVE failures.
    static constexpr int              kConsecutiveFailureThreshold = 10;
    std::atomic<int>                  consecutive_failures_{0};
};

// ---------------------------------------------------------------------------
// DualSrtOutput  (SMPTE 2022-7 sender)
// ---------------------------------------------------------------------------

class DualSrtOutput {
public:
    // path1 and path2 should use different network paths (different ISPs /
    // interfaces). Use different destination ports or hosts; same content.
    DualSrtOutput(
        SrtOutputConfig path1_cfg,
        SrtOutputConfig path2_cfg,
        AVCodecContext* vctx,
        AVCodecContext* actx = nullptr);

    ~DualSrtOutput();

    DualSrtOutput(const DualSrtOutput&)            = delete;
    DualSrtOutput& operator=(const DualSrtOutput&) = delete;

    // Sends the packet to both paths. The packet is ref-copied for the second
    // path so libavformat can consume/modify it independently.
    void write_video(AVPacket* pkt);
    void write_audio(AVPacket* pkt);

    bool path1_connected() const { return p1_.is_connected(); }
    bool path2_connected() const { return p2_.is_connected(); }
    int  path1_reconnects() const { return p1_.reconnect_count(); }
    int  path2_reconnects() const { return p2_.reconnect_count(); }

private:
    ReconnectingSrtOutput p1_;
    ReconnectingSrtOutput p2_;
};

// ---------------------------------------------------------------------------
// RedundancyReceiver  (SMPTE 2022-7 receiver half)
// ---------------------------------------------------------------------------

class RedundancyReceiver {
public:
    using EmitFn = std::function<void(AVPacket*)>;

    // window_ms: how long to hold a packet before outputting it even if the
    // duplicate from the other path hasn't arrived. Must be > max path-delay
    // difference between the two SRT paths (typically 5–50ms for two ISPs
    // in the same city; 100ms is a safe default).
    //
    // video_stream_index / audio_stream_index: the stream indices as assigned
    // by the MPEG-TS demuxer. Usually 0 = video, 1 = audio; set to -1 to
    // disable the respective callback.
    RedundancyReceiver(
        std::chrono::milliseconds window,
        int                       video_stream_index,
        int                       audio_stream_index,
        EmitFn                    emit_video,
        EmitFn                    emit_audio);

    ~RedundancyReceiver();

    RedundancyReceiver(const RedundancyReceiver&)            = delete;
    RedundancyReceiver& operator=(const RedundancyReceiver&) = delete;

    // Called by both SrtInput instances (from their reader threads).
    // Takes ownership of pkt via av_packet_ref — caller must not free it.
    void push(int path_id, AVPacket* pkt);

private:
    struct Entry {
        AVPacket*                                pkt;
        int                                      stream_index;
        int64_t                                  pts;   // dedup key; AV_NOPTS → dts
        std::chrono::steady_clock::time_point    arrived;
    };

    struct PtsKey {
        int     stream_index;
        int64_t pts;
        bool operator==(const PtsKey& o) const noexcept {
            return stream_index == o.stream_index && pts == o.pts;
        }
    };
    struct PtsKeyHash {
        std::size_t operator()(const PtsKey& k) const noexcept {
            // Mix stream_index and pts bits.
            auto h1 = std::hash<int64_t>{}(k.pts);
            auto h2 = std::hash<int>{}(k.stream_index);
            return h1 ^ (h2 * 0x9e3779b97f4a7c15ULL);
        }
    };

    void output_loop(std::stop_token st);
    void evict_seen(std::chrono::steady_clock::time_point now);

    std::chrono::milliseconds  window_;
    int                        vsi_;         // video stream index
    int                        asi_;         // audio stream index
    EmitFn                     emit_video_;
    EmitFn                     emit_audio_;

    // Buffer sorted by pts (we sort on each drain — small N).
    std::deque<Entry>          buf_;
    // Seen-PTS set: keys evicted after 2×window to handle very late arrivals.
    struct SeenEntry { PtsKey key; std::chrono::steady_clock::time_point evict_at; };
    std::deque<SeenEntry>      seen_evict_;  // FIFO for eviction
    std::unordered_set<PtsKey, PtsKeyHash> seen_;

    std::mutex                 mtx_;
    std::condition_variable    cv_;
    std::jthread               output_thread_;
};

} // namespace sdi
