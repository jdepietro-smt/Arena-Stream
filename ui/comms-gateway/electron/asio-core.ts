// Pure audio-buffer helpers for the ASIO bridge (no Electron, no native code), so they can be unit-tested.

/** A fixed-size ring of samples for one channel. Overflow drops the oldest samples; underflow reads silence. */
export class SampleRing {
  private buf: Float32Array
  private r = 0
  private w = 0
  private count = 0

  constructor(readonly capacity: number) { this.buf = new Float32Array(capacity) }

  get length() { return this.count }

  push(samples: ArrayLike<number>) {
    for (let i = 0; i < samples.length; i++) {
      if (this.count === this.capacity) { this.r = (this.r + 1) % this.capacity; this.count-- }
      this.buf[this.w] = samples[i]
      this.w = (this.w + 1) % this.capacity
      this.count++
    }
  }

  /** Read `n` samples into `out` at `offset`, zero-filling what is missing. Returns how many real samples it had. */
  pull(out: Float32Array, offset: number, n: number, stride = 1): number {
    const have = Math.min(n, this.count)
    for (let i = 0; i < n; i++) {
      if (i < have) { out[offset + i * stride] = this.buf[this.r]; this.r = (this.r + 1) % this.capacity } else out[offset + i * stride] = 0
    }
    this.count -= have
    return have
  }

  /** Keep only the newest `keep` samples (used to hold latency down when the sender runs ahead of the device clock). */
  trim(keep: number) {
    if (this.count <= keep) return
    const drop = this.count - keep
    this.r = (this.r + drop) % this.capacity
    this.count -= drop
  }

  clear() { this.r = this.w = this.count = 0 }
}

/** Interleaved device input (frames x channels) to planar (channel-major), keeping only the first `keep` channels. */
export function deinterleave(input: Float32Array, frames: number, channels: number, keep = channels): Float32Array {
  const n = Math.min(keep, channels)
  const out = new Float32Array(n * frames)
  for (let f = 0; f < frames; f++) {
    const base = f * channels
    for (let c = 0; c < n; c++) out[c * frames + f] = input[base + c]
  }
  return out
}

/**
 * Pull one device buffer of output out of per-channel rings, interleaved. If a channel has built up more than `high`
 * samples it is trimmed to `target` first, so a sender running slightly fast cannot add delay without limit.
 */
export function interleaveFromRings(rings: SampleRing[], frames: number, out: Float32Array, high: number, target: number) {
  const channels = rings.length
  for (let c = 0; c < channels; c++) {
    if (rings[c].length > high) rings[c].trim(target)
    rings[c].pull(out, c, frames, channels)
  }
}
