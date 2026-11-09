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

#include <cstring>

namespace sdi {

inline bool same_iid(REFIID a, REFIID b) {
#ifdef _WIN32
    return IsEqualIID(a, b) != 0;
#else
    return std::memcmp(&a, &b, sizeof(a)) == 0;
#endif
}

// A COM object must hand itself back for IUnknown and for its own interface, and must clear the
// out-pointer when it refuses. Drivers from 14.3 on query callbacks this way; an object that
// returns E_NOINTERFACE for everything (leaving the pointer unset) makes the driver dereference
// garbage and crash the whole process with 0xC0000005.
template <typename Self, typename Iface>
inline HRESULT query_interface(Self* self, REFIID iid, REFIID own_iid, void** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (same_iid(iid, IID_IUnknown) || same_iid(iid, own_iid)) {
        *out = static_cast<Iface*>(self);
        self->AddRef();
        return S_OK;
    }
    return E_NOINTERFACE;
}

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
