#pragma once
//
// PathDedupe: decides what to do with a packet when the same stream arrives over two network paths (two relays).
//
// First copy wins: whichever path delivers a packet first, it goes on at once, so a healthy pair costs no extra delay. The copy
// from the other path is a duplicate and is dropped. If one path loses a packet the other still has it, and if one path dies
// altogether the stream carries on from the other with no gap: that is the point of sending it twice.
//
// A packet is identified by its stream and timestamp (both paths carry the same bytes, so the same timestamps). A packet that
// turns up after a newer one of the same stream has already gone on is too late to be useful (the decoder cannot go back) and is
// dropped too. If timestamps jump back by seconds the sender was restarted: everything is forgotten and counting starts again.
//
// Pure logic, no FFmpeg or SRT, so it is tested on its own.
#include <cstdint>
#include <deque>
#include <unordered_map>
#include <unordered_set>

namespace sdi {

class PathDedupe {
public:
    enum Verdict { Fresh, Duplicate, Late };

    explicit PathDedupe(int64_t keep_us = 5'000'000, int64_t restart_back_us = 2'000'000)
        : keep_us_(keep_us), restart_back_us_(restart_back_us) {}

    // ts_us: the packet's decode timestamp in microseconds; now_us: any steady clock in microseconds.
    Verdict check(int stream, int64_t ts_us, int64_t now_us) {
        evict(now_us);
        const Key k{stream, ts_us};
        if (seen_.count(k)) return Duplicate;
        auto it = last_.find(stream);
        if (it != last_.end() && ts_us < it->second) {
            if (it->second - ts_us <= restart_back_us_) return Late;
            seen_.clear(); order_.clear(); last_.clear();                 // sender restarted: start over
        }
        last_[stream] = ts_us;
        seen_.insert(k);
        order_.push_back({k, now_us});
        return Fresh;
    }

private:
    struct Key {
        int stream; int64_t ts;
        bool operator==(const Key& o) const noexcept { return stream == o.stream && ts == o.ts; }
    };
    struct KeyHash {
        size_t operator()(const Key& k) const noexcept { return std::hash<int64_t>{}(k.ts) ^ (size_t(k.stream) * 0x9e3779b97f4a7c15ULL); }
    };
    void evict(int64_t now_us) {
        while (!order_.empty() && now_us - order_.front().at > keep_us_) { seen_.erase(order_.front().key); order_.pop_front(); }
    }
    struct Seen { Key key; int64_t at; };
    int64_t keep_us_, restart_back_us_;
    std::unordered_set<Key, KeyHash> seen_;
    std::deque<Seen> order_;
    std::unordered_map<int, int64_t> last_;
};

} // namespace sdi
