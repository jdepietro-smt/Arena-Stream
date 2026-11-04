#pragma once
//
// Enumerate capture/output cards as JSON on stdout: [{"index","device","channel","name","backend"}].
// The AJA probe runs on a bounded-wait thread (a machine without the ajantv2 driver can hang in
// CNTV2Card::Open) and inside SEH on Windows, so a missing driver never blocks or crashes the list.

#include <chrono>
#include <cstdlib>
#include <future>
#include <iostream>
#include <memory>
#include <new>
#include <string>
#include <tuple>
#include <vector>

#ifdef _WIN32
#  include <windows.h>
#endif
#ifdef SDI_WITH_AJA
#  include "ntv2card.h"
#  include "ntv2devicefeatures.h"
#  include "ntv2utils.h"
#endif
#ifdef SDI_WITH_DECKLINK
#  include "decklink_device.h"
#endif

namespace sdi::devlist {

inline std::string json_str(const std::string& s) {
    std::string out;
    for (unsigned char c : s) {
        if (c == '"' || c == 0x5C) { out += char(0x5C); out += char(c); }
        else if (c >= 0x20)        { out += char(c); }
    }
    return out;
}

#if defined(SDI_WITH_AJA) && defined(_WIN32)
// Everything risky — constructing CNTV2Card, Open, GetDeviceID,
// GetNumVideoChannels, Close — is inside ONE __try block using a heap
// pointer rather than a stack object, since MSVC forbids __try/__except in
// any function containing a local object with a non-trivial destructor
// (raw pointers don't have one, so this is allowed). An earlier version
// only wrapped card->Open() itself, with the CNTV2Card constructed on the
// caller's stack outside the guard — but on a machine with no ajantv2
// driver installed at all, the crash confirmed in the field can happen
// as early as CONSTRUCTING the object, before Open() is ever called, which
// that version didn't cover. This wraps the whole lifecycle so nothing
// AJA-related can take the process down regardless of exactly where the
// driver-absence fault actually triggers.
inline bool aja_probe_index_safe(int index, NTV2DeviceID& devId, ULWord& numCh) {
    // A plain `new`/`delete` CNTV2Card* still tripped MSVC's C2712 — the
    // `new` expression itself needs unwind support to avoid leaking on a
    // throwing constructor, which is exactly the "object unwinding" the
    // restriction means. Placement-new into raw malloc'd memory has no
    // such implicit cleanup, so there's nothing for the compiler to object to.
    void* mem = std::malloc(sizeof(CNTV2Card));
    if (!mem) return false;
    bool ok = false;
    __try {
        CNTV2Card* card = new (mem) CNTV2Card();
        ok = card->Open(UWord(index)) != 0;
        if (ok) {
            devId = card->GetDeviceID();
            numCh = ::NTV2DeviceGetNumVideoChannels(devId);
            card->Close();
        }
        card->~CNTV2Card();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ok = false;   // leaks the placement-constructed card if the fault hit
                      // mid-construction — a one-shot CLI process about to
                      // exit anyway, harmless.
    }
    std::free(mem);
    return ok;
}
#endif

// Enumerate all SDI outputs and print JSON to stdout, then exit — same
// convention and format as arena_stream's --list, so the decoder UI's
// device picker can reuse the exact same rendering code.
inline void list_devices() {
    std::cout << "[\n";
    bool first = true;
    int global_idx = 0;

    auto emit = [&](int device, int channel, const std::string& name, const std::string& backend) {
        if (!first) std::cout << ",\n";
        first = false;
        std::cout << "  {\"index\":"    << global_idx++
                  << ",\"device\":"    << device
                  << ",\"channel\":"   << channel
                  << ",\"name\":\""    << json_str(name) << "\""
                  << ",\"backend\":\"" << backend << "\"}";
    };

#ifdef SDI_WITH_AJA
    // CNTV2Card::Open() is expected to fail fast when no AJA card/driver is
    // present, but on a machine with no ajantv2 driver installed at all
    // (e.g. a DeckLink-only box) it can hang instead of returning quickly —
    // confirmed in the field: --list printed the opening "[" and then never
    // returned at all, blocking DeckLink enumeration from ever running.
    // Running the probe on its own thread with a bounded wait means a stuck
    // AJA driver can never again block finding out about a DeckLink card
    // that's actually present and working. Results are collected into a
    // heap-owned vector (not captured by reference into emit/first/
    // global_idx) so it stays safe to read even if the probing thread never
    // actually finishes and we move on without it.
    auto aja_found = std::make_shared<std::vector<std::tuple<int,int,std::string>>>();
    // Heap-allocated and deliberately leaked in the timeout branch below —
    // std::future's destructor (for a future from std::async) BLOCKS until
    // the thread finishes. Letting a local std::future go out of scope while
    // its thread is still stuck would silently re-introduce the exact hang
    // this code exists to avoid, just delayed to the end of this function
    // instead of at the wait_for call. This is a one-shot --list command
    // that's about to exit anyway, so leaking a still-stuck probe thread is
    // harmless — the OS reclaims it when the process exits.
    auto* aja_task = new std::future<void>(std::async(std::launch::async, [aja_found]() {
        for (int i = 0; i < 8; ++i) {
            NTV2DeviceID devId; ULWord num_ch;
#ifdef _WIN32
            if (!aja_probe_index_safe(i, devId, num_ch)) break;
#else
            CNTV2Card card;
            if (!card.Open(UWord(i))) break;
            devId = card.GetDeviceID();
            num_ch = ::NTV2DeviceGetNumVideoChannels(devId);
            card.Close();
#endif
            const std::string card_name = ::NTV2DeviceIDToString(devId) + " #" + std::to_string(i);
            for (ULWord ch = 1; ch <= num_ch && ch <= 8; ++ch)
                aja_found->emplace_back(i, int(ch), card_name + " SDI " + std::to_string(ch));
        }
    }));
    if (aja_task->wait_for(std::chrono::seconds(3)) == std::future_status::timeout) {
        std::cerr << "sdi_decoder: AJA device probe did not respond within 3s — "
                     "skipping it and continuing with other backends. This usually means "
                     "the ajantv2 driver isn't installed/running on this machine.\n";
        // Leak aja_task on purpose — see comment above.
    } else {
        for (auto& [device, channel, name] : *aja_found)
            emit(device, channel, name, "aja");
        delete aja_task;
    }
#endif

#ifdef SDI_WITH_DECKLINK
    sdi::decklink_list_devices(emit);
#endif

    std::cout << "\n]\n";
}

} // namespace sdi::devlist
