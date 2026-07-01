#pragma once
//
// SrtInput — SRT source + MPEG-TS demux.
//
// Wraps libavformat to read a MPEG-TS stream from an SRT URI (either
// listener or caller mode) and deliver raw encoded AVPackets to a callback.
// Operates at the transport layer — no decoding, no SDI output. Intended
// for use by:
//
//   1. The 2022-7 receiver (sdi_receive binary) which merges two paths
//      before passing packets downstream.
//   2. Any future receiver pipeline that needs encoded-packet access.
//
// The callback receives AVPacket* that the caller must NOT free. The packet
// is valid only for the duration of the callback. Copy with av_packet_ref
// if you need to hold it longer.

#include <atomic>
#include <functional>
#include <string>
#include <thread>

extern "C" {
#include <libavformat/avformat.h>
}

namespace sdi {

class SrtInput {
public:
    struct Config {
        std::string uri;          // srt://host:port  or  srt://:port?mode=listener
        int         latency_ms  = 150;
        std::string passphrase;
    };

    // Callback is called from the reader thread with each packet.
    // stream_index matches the demuxed MPEG-TS PID (usually 0=video, 1=audio).
    using PacketCallback = std::function<void(AVPacket* pkt, int stream_index)>;

    explicit SrtInput(Config cfg, PacketCallback cb);
    ~SrtInput();

    SrtInput(const SrtInput&)            = delete;
    SrtInput& operator=(const SrtInput&) = delete;

    // Start the background reader thread. Returns false immediately if the
    // URI is obviously malformed.
    bool start();

    // Signal stop and join the reader thread. Blocks until reader exits.
    void stop();

    bool is_running() const { return running_.load(); }

    // Stream indices as assigned by the MPEG-TS demuxer on first open.
    // Valid after at least one packet has arrived. -1 = not yet known.
    int video_stream_index() const { return vsi_.load(); }
    int audio_stream_index() const { return asi_.load(); }

private:
    void reader_loop(std::stop_token st);

    // interrupt_callback registered with AVFormatContext — returns 1 when
    // the stop token fires so av_read_frame unblocks promptly.
    static int interrupt_cb(void* opaque);

    Config          cfg_;
    PacketCallback  cb_;

    AVFormatContext*  fmt_      = nullptr;
    std::atomic<int>  vsi_{-1};
    std::atomic<int>  asi_{-1};
    std::atomic<bool> abort_{false};   // used by the interrupt callback
    std::atomic<bool> running_{false};

    std::jthread      reader_thread_;
};

} // namespace sdi
