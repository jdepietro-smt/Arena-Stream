#pragma once
//
// Pixel access for DeckLink video frames, SDK 14.3 and newer.
//
// Until 14.3 a frame's bytes came from IDeckLinkVideoFrame::GetBytes(). Newer drivers moved that to
// a separate IDeckLinkVideoBuffer interface that has to be queried for and wrapped in
// StartAccess/EndAccess (the driver may keep frames in memory that is not CPU-mappable until asked).
// An app built on the old API gets no bytes (or crashes) on such a driver. Include after
// DeckLinkAPI.h.

#ifdef SDI_WITH_DECKLINK

namespace sdi {

class DeckLinkBytes {
public:
    // `frame` is any DeckLink video frame (input, output or mutable). The access is released on destruction.
    DeckLinkBytes(IUnknown* frame, BMDBufferAccessFlags flags) : flags_(flags) {
        if (!frame) return;
        if (frame->QueryInterface(IID_IDeckLinkVideoBuffer, reinterpret_cast<void**>(&buf_)) != S_OK || !buf_) { buf_ = nullptr; return; }
        if (buf_->StartAccess(flags_) != S_OK) return;
        started_ = true;
        if (buf_->GetBytes(&bytes_) != S_OK) bytes_ = nullptr;
    }
    ~DeckLinkBytes() {
        if (buf_) { if (started_) buf_->EndAccess(flags_); buf_->Release(); }
    }
    DeckLinkBytes(const DeckLinkBytes&)            = delete;
    DeckLinkBytes& operator=(const DeckLinkBytes&) = delete;

    void* data() const { return bytes_; }
    explicit operator bool() const { return bytes_ != nullptr; }

private:
    IDeckLinkVideoBuffer*  buf_     = nullptr;
    BMDBufferAccessFlags   flags_;
    bool                   started_ = false;
    void*                  bytes_   = nullptr;
};

} // namespace sdi

#endif
