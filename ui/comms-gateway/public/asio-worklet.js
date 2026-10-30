// AudioWorklet processors for the ASIO bridge (see electron/asio.ts).
//
//   asio-in:  device input channels (posted from the main process as planar blocks) -> N audio outputs, one per device input.
//             A small FIFO absorbs the difference between the interface clock and this audio context's clock.
//   asio-out: M audio inputs (one per device output) -> posted back to the main process as planar 128-frame blocks.

class AsioIn extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.n = options.outputChannelCount[0]
    this.cap = 16384
    this.rings = Array.from({ length: this.n }, () => new Float32Array(this.cap))
    this.r = 0
    this.w = 0
    this.count = 0
    this.target = (options.processorOptions && options.processorOptions.targetSamples) || 512
    this.primed = false
    this.dry = 0 // times the cushion ran out (audible as a dropout)
    this.trims = 0 // times it was far ahead and skipped back (audible as a click)
    this.sent = 0
    this.port.onmessage = e => this.push(e.data)
  }

  push(data) {
    const planar = data instanceof Float32Array ? data : new Float32Array(data.buffer ? data.buffer : data)
    const frames = Math.floor(planar.length / this.n)
    if (!frames) return
    // Overflow drops the oldest audio.
    const over = this.count + frames - this.cap
    if (over > 0) { this.r = (this.r + over) % this.cap; this.count -= over }
    const first = Math.min(frames, this.cap - this.w) // up to the end of the ring, then wrap
    for (let c = 0; c < this.n; c++) {
      const ring = this.rings[c]
      ring.set(planar.subarray(c * frames, c * frames + first), this.w)
      if (first < frames) ring.set(planar.subarray(c * frames + first, (c + 1) * frames), 0)
    }
    this.w = (this.w + frames) % this.cap
    this.count += frames
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const len = out[0].length
    if (!this.primed) {
      if (this.count >= this.target) this.primed = true
      else return true // silence until a little audio has built up
    }
    if (this.count < len) { this.primed = false; this.dry++; return true } // ran dry: silence, then rebuild the cushion
    // The interface clock can run a touch faster than ours: if we are far ahead, skip back to the cushion.
    if (this.count > this.target * 6) {
      const drop = this.count - this.target * 2
      this.r = (this.r + drop) % this.cap
      this.count -= drop
      this.trims++
    }
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < this.n; c++) out[c][i] = this.rings[c][this.r]
      this.r = (this.r + 1) % this.cap
    }
    this.count -= len
    if ((this.sent += len) >= 48000) { this.sent = 0; this.port.postMessage({ stat: true, dry: this.dry, trims: this.trims }) }
    return true
  }
}

class AsioOut extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.n = (options.processorOptions && options.processorOptions.channels) || 1
  }

  process(inputs) {
    const inp = inputs[0]
    const len = (inp[0] && inp[0].length) || 128
    const block = new Float32Array(this.n * len)
    for (let c = 0; c < this.n; c++) if (inp[c]) block.set(inp[c], c * len)
    this.port.postMessage(block, [block.buffer])
    return true
  }
}

registerProcessor('asio-in', AsioIn)
registerProcessor('asio-out', AsioOut)
