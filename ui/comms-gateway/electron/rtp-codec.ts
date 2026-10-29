// RTP packet parsing and linear-PCM (AES67 L24 / L16, big-endian) conversion.
// Pure functions, no I/O, so they can be unit-tested directly.

export type PcmFormat = 'L24' | 'L16'

export interface RtpPacket {
  payloadType: number
  sequence: number
  timestamp: number
  ssrc: number
  payload: Uint8Array
}

export const bytesPerSample = (f: PcmFormat) => (f === 'L24' ? 3 : 2)

/** Parse an RTP packet; null if it isn't RTP v2 or is truncated. */
export function parseRtp(buf: Uint8Array): RtpPacket | null {
  if (buf.length < 12 || buf[0] >> 6 !== 2) return null
  const csrcCount = buf[0] & 0x0f
  const hasExt = (buf[0] & 0x10) !== 0
  const hasPad = (buf[0] & 0x20) !== 0
  let offset = 12 + csrcCount * 4
  if (hasExt) {
    if (buf.length < offset + 4) return null
    offset += 4 + ((buf[offset + 2] << 8) | buf[offset + 3]) * 4
  }
  let end = buf.length
  if (hasPad) end -= buf[buf.length - 1]
  if (offset > end) return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return {
    payloadType: buf[1] & 0x7f,
    sequence: dv.getUint16(2),
    timestamp: dv.getUint32(4),
    ssrc: dv.getUint32(8),
    payload: buf.subarray(offset, end),
  }
}

/** Extract one channel of an interleaved L24/L16 payload as float samples in [-1, 1). */
export function decodeChannel(payload: Uint8Array, format: PcmFormat, channels: number, channel: number): Float32Array {
  const bps = bytesPerSample(format)
  const frame = bps * channels
  const frames = Math.floor(payload.length / frame)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const o = i * frame + channel * bps
    if (format === 'L24') {
      let v = (payload[o] << 16) | (payload[o + 1] << 8) | payload[o + 2]
      if (v & 0x800000) v -= 0x1000000
      out[i] = v / 8388608
    } else {
      let v = (payload[o] << 8) | payload[o + 1]
      if (v & 0x8000) v -= 0x10000
      out[i] = v / 32768
    }
  }
  return out
}

/** Encode mono float samples as an L24/L16 payload (clipped to full scale). */
export function encodeMono(samples: Float32Array, format: PcmFormat): Uint8Array {
  const bps = bytesPerSample(format)
  const out = new Uint8Array(samples.length * bps)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    if (format === 'L24') {
      const v = Math.round(s * 8388607) & 0xffffff
      out[i * 3] = v >> 16; out[i * 3 + 1] = (v >> 8) & 0xff; out[i * 3 + 2] = v & 0xff
    } else {
      const v = Math.round(s * 32767) & 0xffff
      out[i * 2] = v >> 8; out[i * 2 + 1] = v & 0xff
    }
  }
  return out
}

export function buildRtp(p: { payloadType: number; sequence: number; timestamp: number; ssrc: number; payload: Uint8Array }): Uint8Array {
  const out = new Uint8Array(12 + p.payload.length)
  const dv = new DataView(out.buffer)
  out[0] = 0x80
  out[1] = p.payloadType & 0x7f
  dv.setUint16(2, p.sequence & 0xffff)
  dv.setUint32(4, p.timestamp >>> 0)
  dv.setUint32(8, p.ssrc >>> 0)
  out.set(p.payload, 12)
  return out
}
