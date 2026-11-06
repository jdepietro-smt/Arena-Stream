#pragma once
//
// RateAdapter: lowers the video bitrate when the network is not keeping up, and gives it back
// when it is.
//
// Fed once a second with the sender's cumulative SRT counters (packets sent, packets re-sent,
// packets dropped as too late). Re-sending more than ~2% of packets, or any packet the sender
// had to drop because it could no longer arrive in time, means the link cannot carry the
// current rate. The bitrate then steps down 15% (at most once per 3 s, never below half of what
// the user asked for). After 15 clean seconds it climbs back 8% at a time, and every 5 s after
// that, up to the requested rate. A change the user makes to the bitrate resets the target.
//
// Pure logic: no SRT, no encoder, so it is testable on its own.

#include <algorithm>
#include <cstdint>

namespace sdi {

class RateAdapter {
public:
    RateAdapter(int target_kbps, bool enabled) : target_(target_kbps), cur_(target_kbps), enabled_(enabled) {}

    // Returns the bitrate to switch to, or 0 for no change.
    int tick(int64_t sent, int64_t retrans, int64_t drops) {
        if (!have_) { last_sent_ = sent; last_retrans_ = retrans; last_drops_ = drops; have_ = true; return 0; }
        const int64_t ds = sent - last_sent_, dr = retrans - last_retrans_, dd = drops - last_drops_;
        last_sent_ = sent; last_retrans_ = retrans; last_drops_ = drops;
        if (ds < 0 || dr < 0 || dd < 0) return 0;               // a connection came or went: counters restarted

        loss_ = ds > 20 ? 100.0 * double(dr) / double(ds) : 0.0;
        loss_ema_ += 0.3 * (loss_ - loss_ema_);
        if (dd > 0) drop_age_ = 0; else if (drop_age_ < 1000000) ++drop_age_;
        if (cool_ > 0) --cool_;

        const bool bad = loss_ > 2.0 || dd > 0;
        if (bad) {
            good_ = 0;
            const int floor = std::max(1500, target_ / 2);
            if (enabled_ && cool_ == 0 && cur_ > floor) {
                cur_ = std::max(floor, int(cur_ * 0.85));
                cool_ = 3;
                return cur_;
            }
        } else {
            ++good_;
            if (enabled_ && cur_ < target_ && good_ >= 15) {
                cur_ = std::min(target_, int(cur_ * 1.08) + 1);
                good_ = 10;                                      // next step in 5 s
                return cur_;
            }
        }
        return 0;
    }

    void set_target(int kbps) { target_ = cur_ = kbps; good_ = 0; cool_ = 0; }

    int    current()  const { return cur_; }
    int    target()   const { return target_; }
    bool   reduced()  const { return cur_ < target_; }
    bool   enabled()  const { return enabled_; }
    double loss_pct() const { return loss_; }        // re-sent / sent over the last second
    double loss_avg() const { return loss_ema_; }    // smoothed over several seconds
    bool   drops_recent() const { return drop_age_ < 30; }   // a too-late drop in the last 30 s

private:
    int     target_, cur_;
    bool    enabled_;
    bool    have_ = false;
    int64_t last_sent_ = 0, last_retrans_ = 0, last_drops_ = 0;
    double  loss_ = 0, loss_ema_ = 0;
    int     good_ = 0, cool_ = 0, drop_age_ = 1000000;
};

} // namespace sdi
