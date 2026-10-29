// AudioWorklet processors bridging network audio (RTP) and the Web Audio graph.
//
// rtp-rx : receives sample batches from the main process into a ring buffer and plays
//          them out. There is no shared clock with the sender (no PTP), so the buffer
//          is kept near a target fill: one sample is dropped per quantum when it runs
//          long (inaudible), and on underrun it outputs silence and re-primes.
// rtp-tx : taps its input and posts ~10 ms blocks back to the main thread for packetising.

class RtpRx extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions || {}
    this.cap = 48000
    this.buf = new Float32Array(this.cap)
    this.r = 0
    this.w = 0
    this.fill = 0
    this.target = o.targetSamples || 1920 // 40 ms
    this.primed = false
    this.port.onmessage = e => {
      const s = e.data
      for (let i = 0; i < s.length; i++) {
        if (this.fill >= this.cap) { this.r = (this.r + 1) % this.cap; this.fill-- } // overflow: drop oldest
        this.buf[this.w] = s[i]
        this.w = (this.w + 1) % this.cap
        this.fill++
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    const n = out.length
    if (!this.primed) {
      if (this.fill >= this.target) this.primed = true
      else { out.fill(0); return true }
    }
    if (this.fill < n) { this.primed = false; out.fill(0); return true } // underrun
    for (let i = 0; i < n; i++) { out[i] = this.buf[this.r]; this.r = (this.r + 1) % this.cap }
    this.fill -= n
    if (this.fill > this.target + 480) { this.r = (this.r + 1) % this.cap; this.fill-- } // drift: shed a sample
    return true
  }
}

class RtpTx extends AudioWorkletProcessor {
  constructor() {
    super()
    this.acc = new Float32Array(480)
    this.n = 0
  }

  process(inputs) {
    const inp = inputs[0] && inputs[0][0]
    for (let i = 0; i < 128; i++) {
      this.acc[this.n++] = inp ? inp[i] : 0 // silence keeps the stream alive when nothing is connected
      if (this.n === this.acc.length) { this.port.postMessage(this.acc.slice()); this.n = 0 }
    }
    return true
  }
}

registerProcessor('rtp-rx', RtpRx)
registerProcessor('rtp-tx', RtpTx)
