// SrtInput — SRT listener/caller → MPEG-TS demux → raw AVPacket callbacks.
// See srt_input.h for the API contract.

#include "srt_input.h"

#include <chrono>
#include <iostream>
#include <thread>

namespace sdi {

// ---------------------------------------------------------------------------
// interrupt callback — lets av_read_frame return promptly when stopping.
// ---------------------------------------------------------------------------
int SrtInput::interrupt_cb(void* opaque) {
    const auto* flag = static_cast<std::atomic<bool>*>(opaque);
    return flag->load(std::memory_order_acquire) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Construction / destruction
// ---------------------------------------------------------------------------

SrtInput::SrtInput(Config cfg, PacketCallback cb)
    : cfg_(std::move(cfg)), cb_(std::move(cb)) {}

SrtInput::~SrtInput() { stop(); }

bool SrtInput::start() {
    if (running_.load()) return true;
    reader_thread_ = std::jthread([this](std::stop_token st) { reader_loop(st); });
    return true;
}

void SrtInput::stop() {
    abort_.store(true, std::memory_order_release);
    if (reader_thread_.joinable()) {
        reader_thread_.request_stop();
        reader_thread_.join();
    }
}

// ---------------------------------------------------------------------------
// Reader loop
// ---------------------------------------------------------------------------

void SrtInput::reader_loop(std::stop_token st) {
    running_.store(true);
    auto backoff = std::chrono::seconds{1};

    while (!st.stop_requested()) {
        abort_.store(false, std::memory_order_release);

        // Build the URL — SRT latency and optional passphrase go in the query.
        std::string url = cfg_.uri;
        url += (url.find('?') == std::string::npos) ? "?" : "&";
        url += "latency=" + std::to_string(cfg_.latency_ms * 1000);
        if (!cfg_.passphrase.empty())
            url += "&passphrase=" + cfg_.passphrase + "&pbkeylen=16";

        // Open input.
        fmt_ = avformat_alloc_context();
        if (!fmt_) {
            std::cerr << "srt_input [" << cfg_.uri << "]: avformat_alloc_context failed\n";
            break;
        }

        // Register interrupt callback so we can abort av_read_frame.
        fmt_->interrupt_callback.callback = &SrtInput::interrupt_cb;
        fmt_->interrupt_callback.opaque   = &abort_;

        AVDictionary* opts = nullptr;
        // Generous timeout for initial connect (listener mode can wait a while).
        av_dict_set_int(&opts, "timeout", 10'000'000, 0); // 10s in microseconds

        std::cerr << "srt_input [" << cfg_.uri << "]: opening...\n";
        int ret = avformat_open_input(&fmt_, url.c_str(), nullptr, &opts);
        av_dict_free(&opts);

        if (ret < 0 || st.stop_requested()) {
            char errbuf[128];
            av_strerror(ret, errbuf, sizeof(errbuf));
            std::cerr << "srt_input [" << cfg_.uri << "]: open failed: " << errbuf << "\n";
            avformat_close_input(&fmt_);
            fmt_ = nullptr;
            std::this_thread::sleep_for(backoff);
            backoff = std::min(backoff * 2, std::chrono::seconds{30});
            continue;
        }

        if (avformat_find_stream_info(fmt_, nullptr) < 0) {
            std::cerr << "srt_input [" << cfg_.uri << "]: find_stream_info failed\n";
            avformat_close_input(&fmt_);
            fmt_ = nullptr;
            continue;
        }

        // Identify video and audio stream indices.
        int vsi = -1, asi = -1;
        for (unsigned i = 0; i < fmt_->nb_streams; ++i) {
            const auto mt = fmt_->streams[i]->codecpar->codec_type;
            if (vsi < 0 && mt == AVMEDIA_TYPE_VIDEO) vsi = int(i);
            if (asi < 0 && mt == AVMEDIA_TYPE_AUDIO) asi = int(i);
        }
        vsi_.store(vsi); asi_.store(asi);
        std::cerr << "srt_input [" << cfg_.uri << "]: connected "
                  << "(video=" << vsi << " audio=" << asi << ")\n";

        backoff = std::chrono::seconds{1};  // reset after successful open

        // Read loop.
        AVPacket* pkt = av_packet_alloc();
        while (!st.stop_requested()) {
            ret = av_read_frame(fmt_, pkt);
            if (ret == AVERROR(EAGAIN)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
                continue;
            }
            if (ret < 0) break;  // EOF or network error → reconnect

            cb_(pkt, pkt->stream_index);
            av_packet_unref(pkt);
        }
        av_packet_free(&pkt);

        std::cerr << "srt_input [" << cfg_.uri << "]: stream ended — reconnecting\n";
        avformat_close_input(&fmt_);
        fmt_ = nullptr;
    }

    running_.store(false);
    if (fmt_) {
        avformat_close_input(&fmt_);
        fmt_ = nullptr;
    }
}

} // namespace sdi
