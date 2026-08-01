#pragma once
//
// Bounded MPSC queue for handing frames from capture callback → encoder
// thread. Drops oldest on overflow because in a real-time pipeline it is
// always better to drop a frame than to stall the capture callback — the
// SDI clock will not wait.

#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>

namespace sdi {

template <typename T>
class FrameQueue {
public:
    explicit FrameQueue(size_t capacity)
        : capacity_(capacity) {}

    // Push a frame. If queue is full, drops the oldest frame and increments
    // the drop counter. Never blocks.
    void push(T&& item) {
        std::lock_guard lk(m_);
        if (closed_) return;
        if (q_.size() >= capacity_) {
            q_.pop_front();
            ++dropped_;
        }
        q_.push_back(std::move(item));
        cv_.notify_one();
    }

    // Blocking pop. Returns std::nullopt once close() has been called and
    // the queue has drained.
    std::optional<T> pop() {
        std::unique_lock lk(m_);
        cv_.wait(lk, [&] { return !q_.empty() || closed_; });
        if (q_.empty()) return std::nullopt;
        T item = std::move(q_.front());
        q_.pop_front();
        return item;
    }

    // Non-blocking pop. Returns std::nullopt immediately if the queue is
    // empty — for consumers running on a driver/SDK callback thread (e.g.
    // DeckLink's ScheduledFrameCompleted) that must never block: if the
    // decoder hasn't produced a frame yet, the caller re-schedules the
    // previous frame rather than stalling the SDI output clock.
    std::optional<T> try_pop() {
        std::lock_guard lk(m_);
        if (q_.empty()) return std::nullopt;
        T item = std::move(q_.front());
        q_.pop_front();
        return item;
    }

    // Discard all currently queued items without closing the queue.
    // Used to drop a backlog that accumulated while no consumer was running
    // (e.g. during encoder prewarm) so consumers resume from "now" instead of
    // replaying a queue's worth of stale frames.
    void clear() {
        std::lock_guard lk(m_);
        q_.clear();
    }

    void close() {
        {
            std::lock_guard lk(m_);
            closed_ = true;
        }
        cv_.notify_all();
    }

    uint64_t dropped() const {
        std::lock_guard lk(m_);
        return dropped_;
    }

    size_t size() const {
        std::lock_guard lk(m_);
        return q_.size();
    }

private:
    mutable std::mutex       m_;
    std::condition_variable  cv_;
    std::deque<T>            q_;
    size_t                   capacity_;
    uint64_t                 dropped_ = 0;
    bool                     closed_  = false;
};

} // namespace sdi
