// UDP RTP receive/send for AES67-style linear PCM (48 kHz). No PTP: the receiving
// side absorbs clock drift in the renderer's worklet (see public/rtp-worklet.js).

import * as dgram from 'dgram'
import { buildRtp, decodeChannel, encodeMono, parseRtp, PcmFormat } from './rtp-codec'

export const SAMPLE_RATE = 48000
const isMulticast = (addr: string) => {
  const first = Number(addr.split('.')[0])
  return first >= 224 && first <= 239
}

export interface RxOptions {
  address?: string        // multicast group, or empty for unicast
  port: number
  format: PcmFormat
  channels: number        // channels interleaved in the incoming stream
  channel: number         // 0-based channel to extract
  payloadType?: number    // ignore other payload types when set
  onSamples: (samples: Float32Array) => void
  onStats?: (s: RxStats) => void
}
export interface RxStats { packets: number; lost: number; late: number }

export class RtpReceiver {
  private sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  private expectSeq: number | null = null
  private stats: RxStats = { packets: 0, lost: 0, late: 0 }
  private batch: Float32Array[] = []
  private batched = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null

  constructor(private o: RxOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock.once('error', reject)
      this.sock.on('message', msg => this.onPacket(msg))
      this.sock.bind(this.o.port, () => {
        this.sock.off('error', reject)
        this.sock.on('error', e => console.warn('[gateway rtp rx]', e.message))
        try {
          if (this.o.address && isMulticast(this.o.address)) this.sock.addMembership(this.o.address)
        } catch (e) { return reject(e) }
        if (this.o.onStats) this.statsTimer = setInterval(() => this.o.onStats!({ ...this.stats }), 1000)
        resolve()
      })
    })
  }

  private onPacket(msg: Buffer) {
    const p = parseRtp(msg)
    if (!p || (this.o.payloadType != null && p.payloadType !== this.o.payloadType)) return
    this.stats.packets++
    if (this.expectSeq != null) {
      const gap = (p.sequence - this.expectSeq) & 0xffff
      if (gap > 0 && gap < 0x8000) this.stats.lost += gap
      else if (gap >= 0x8000) { this.stats.late++; return }   // reordered/duplicate: drop
    }
    this.expectSeq = (p.sequence + 1) & 0xffff
    const s = decodeChannel(p.payload, this.o.format, this.o.channels, this.o.channel)
    this.batch.push(s)
    this.batched += s.length
    // Hand over ~10 ms at a time so IPC stays at ~100 messages/s however short the packet time is.
    if (this.batched >= 480) this.flush()
  }

  private flush() {
    const out = new Float32Array(this.batched)
    let o = 0
    for (const b of this.batch) { out.set(b, o); o += b.length }
    this.batch = []
    this.batched = 0
    this.o.onSamples(out)
  }

  stop() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    try { this.sock.close() } catch { /* already closed */ }
  }
}

export interface TxOptions {
  address: string
  port: number
  format: PcmFormat
  payloadType: number
  ptimeMs: number         // AES67 default is 1 ms
  ttl?: number
}

export class RtpSender {
  private sock = dgram.createSocket('udp4')
  private queue: Float32Array[] = []
  private queued = 0
  private seq = Math.floor(Math.random() * 0xffff)
  private ts = Math.floor(Math.random() * 0xffffffff)
  private ssrc = Math.floor(Math.random() * 0xffffffff)
  private timer: ReturnType<typeof setInterval>
  private frame: number
  sent = 0

  constructor(private o: TxOptions) {
    this.frame = Math.max(1, Math.round((SAMPLE_RATE * o.ptimeMs) / 1000))
    this.sock.bind(0, () => {
      try { if (isMulticast(o.address)) this.sock.setMulticastTTL(o.ttl ?? 16) } catch { /* not bound yet */ }
    })
    this.sock.on('error', e => console.warn('[gateway rtp tx]', e.message))
    // Timers are coarse; send whatever whole packets the queue can fill each tick.
    this.timer = setInterval(() => this.drain(), 1)
  }

  push(samples: Float32Array) {
    this.queue.push(samples)
    this.queued += samples.length
    // Never let latency build: keep at most 200 ms queued.
    while (this.queued > SAMPLE_RATE * 0.2 && this.queue.length) this.queued -= this.queue.shift()!.length
  }

  private take(n: number): Float32Array {
    const out = new Float32Array(n)
    let o = 0
    while (o < n && this.queue.length) {
      const head = this.queue[0]
      const k = Math.min(head.length, n - o)
      out.set(head.subarray(0, k), o)
      o += k
      if (k === head.length) this.queue.shift(); else this.queue[0] = head.subarray(k)
    }
    this.queued -= n
    return out
  }

  private drain() {
    while (this.queued >= this.frame) {
      const payload = encodeMono(this.take(this.frame), this.o.format)
      const pkt = buildRtp({ payloadType: this.o.payloadType, sequence: this.seq, timestamp: this.ts, ssrc: this.ssrc, payload })
      this.sock.send(pkt, this.o.port, this.o.address)
      this.seq = (this.seq + 1) & 0xffff
      this.ts = (this.ts + this.frame) >>> 0
      this.sent++
    }
  }

  stop() {
    clearInterval(this.timer)
    try { this.sock.close() } catch { /* already closed */ }
  }
}
