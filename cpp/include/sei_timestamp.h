#pragma once
// SEI timestamp injection / extraction for glass-to-glass latency measurement.
//
// The encoder embeds the wall-clock capture time as a H.264 SEI
// user_data_unregistered NAL on every frame (not just keyframes, so latency
// updates every frame).  The decoder extracts it and computes delta from now.
//
// RBSP emulation prevention is applied correctly so the timestamp bytes never
// corrupt the bitstream even when they contain 0x00 0x00 0x00/01/02/03.

#include <chrono>
#include <cstdint>
#include <cstring>
#include <vector>

namespace sdi {

// 16-byte UUID identifying our custom SEI
static constexpr uint8_t SEI_UUID[16] = {
    0x53,0x44,0x49,0x4C,0x41,0x54,0x00,0x01,
    0xAB,0xCD,0xEF,0x01,0x23,0x45,0x67,0x89,
};

// Apply RBSP emulation prevention: insert 0x03 before 0x00/0x01/0x02/0x03
// following two consecutive 0x00 bytes.
static inline std::vector<uint8_t> rbsp_encode(const uint8_t* in, int len) {
    std::vector<uint8_t> out;
    out.reserve(len + 4);
    int zeros = 0;
    for (int i = 0; i < len; ++i) {
        if (zeros >= 2 && (in[i] <= 3)) {
            out.push_back(0x03);  // emulation prevention
            zeros = 0;
        }
        out.push_back(in[i]);
        zeros = (in[i] == 0) ? zeros + 1 : 0;
    }
    return out;
}

// Remove RBSP emulation prevention bytes (0x03 between 00 00 and 00/01/02/03).
static inline std::vector<uint8_t> rbsp_decode(const uint8_t* in, int len) {
    std::vector<uint8_t> out;
    out.reserve(len);
    for (int i = 0; i < len; ++i) {
        if (i + 2 < len && in[i] == 0 && in[i+1] == 0 && in[i+2] == 0x03) {
            out.push_back(0); out.push_back(0);
            i += 2;  // skip the 0x03
        } else {
            out.push_back(in[i]);
        }
    }
    return out;
}

// Build a complete Annex-B SEI NAL containing our UUID + 8-byte timestamp.
// Returns the raw bytes including the 4-byte start code.
static inline std::vector<uint8_t> make_sei_nal(int64_t ts_ms) {
    // Raw payload: UUID(16) + timestamp(8) = 24 bytes
    uint8_t payload[24];
    std::memcpy(payload, SEI_UUID, 16);
    for (int i = 0; i < 8; ++i)
        payload[16 + i] = (uint8_t)(ts_ms >> (56 - 8*i));

    // RBSP-encode the payload
    auto enc = rbsp_encode(payload, 24);

    // SEI size field: encoded payload size (uses 0xFF-prefix encoding for >255)
    // Our payload is always small (<64 bytes after encoding) so single byte suffices.
    const int payload_size = (int)enc.size();

    // Full NAL: start_code(4) + nal_type(1) + sei_type(1) + size(1) + payload + stop_bit(1)
    std::vector<uint8_t> nal;
    nal.reserve(4 + 1 + 1 + 1 + payload_size + 1);
    nal.push_back(0x00); nal.push_back(0x00);
    nal.push_back(0x00); nal.push_back(0x01);  // start code
    nal.push_back(0x06);                         // NAL unit type 6 = SEI
    nal.push_back(0x05);                         // SEI type 5 = user_data_unregistered
    nal.push_back((uint8_t)payload_size);         // payload size (post-RBSP-encoding)
    nal.insert(nal.end(), enc.begin(), enc.end());
    nal.push_back(0x80);                         // RBSP trailing stop bit
    return nal;
}

// Scan an Annex-B H.264 bitstream for our custom SEI NAL.
// Returns the capture timestamp in ms, or -1 if not found.
static inline int64_t extract_sei_timestamp(const uint8_t* data, int size) {
    for (int i = 0; i + 8 < size; ++i) {
        // Look for: 00 00 [00] 01 06 05 XX
        bool has_start = false;
        int nal_start = 0;
        if (i + 3 < size && data[i]==0 && data[i+1]==0 && data[i+2]==0 && data[i+3]==1) {
            has_start = true; nal_start = i + 4;
        } else if (i + 2 < size && data[i]==0 && data[i+1]==0 && data[i+2]==1) {
            has_start = true; nal_start = i + 3;
        }
        if (!has_start) continue;

        // nal_start points to the NAL header byte
        if (nal_start + 3 >= size)  continue;
        if ((data[nal_start] & 0x1F) != 0x06) continue;  // not SEI
        if (data[nal_start+1] != 0x05)         continue;  // not user_data_unregistered

        // payload_size byte
        const int psz = data[nal_start+2];
        if (nal_start + 3 + psz > size) continue;

        // RBSP-decode the payload
        auto dec = rbsp_decode(data + nal_start + 3, psz);
        if ((int)dec.size() < 24) continue;

        // Check UUID
        if (std::memcmp(dec.data(), SEI_UUID, 16) != 0) continue;

        // Extract timestamp
        int64_t ts = 0;
        for (int b = 0; b < 8; ++b)
            ts = (ts << 8) | dec[16 + b];
        return ts;
    }
    return -1;
}

// Get current wall-clock time in milliseconds (Unix epoch).
static inline int64_t wall_clock_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

} // namespace sdi
