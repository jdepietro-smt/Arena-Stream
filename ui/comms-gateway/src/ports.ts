// Gateway ports: each one bridges a comms-system audio path to one Arena channel.
//
//   comms system -> [source] -> inGain -> (VOX look-ahead delay) -> channelTx(ch)   key/unkey via VOX
//   channelRx(ch) -> outGain -> [sink] -> comms system
//
// A partyline has no push-to-talk, so the gateway keys the Arena channel with a
// voice-activity detector. A short look-ahead delay lets the VOX open before the
// first syllable reaches the network.

import type { CommsEngine } from '@engine'

export type SourceKind = 'device' | 'rtp' | 'tone'
export type PcmFormat = 'L24' | 'L16'

export interface RtpCfg {
  rxAddr: string; rxPort: number; rxFormat: PcmFormat; rxChannels: number; rxChannel: number; rxPayloadType: number
  txAddr: string; txPort: number; txFormat: PcmFormat; txPayloadType: number; ptimeMs: number
  bufferMs: number
}
export interface PortCfg {
  id: string
  name: string
  enabled: boolean
  channel: string
  source: SourceKind
  /** 1-based device channel numbers (source: 'device'). */
  inCh: number
  outCh: number
  rtp: RtpCfg
  vox: { thresholdDb: number; hangMs: number; echoGuard: boolean }
  inGainDb: number
  outGainDb: number
}
export interface DeviceCfg { inputId: string; outputId: string; inputChannels: number; outputChannels: number }
export interface GatewayConfig {
  server: string; username: string; password: string; autoConnect: boolean
  device: DeviceCfg
  ports: PortCfg[]
}

export const defaultRtp = (): RtpCfg => ({
  rxAddr: '239.69.0.1', rxPort: 5004, rxFormat: 'L24', rxChannels: 1, rxChannel: 0, rxPayloadType: 97,
  txAddr: '239.69.0.2', txPort: 5004, txFormat: 'L24', txPayloadType: 97, ptimeMs: 1, bufferMs: 40,
})

export const newPort = (n: number): PortCfg => ({
  id: `p${Date.now().toString(36)}${n}`, name: `Port ${n}`, enabled: true, channel: '', source: 'device',
  inCh: n, outCh: n, rtp: defaultRtp(), vox: { thresholdDb: -45, hangMs: 400, echoGuard: true }, inGainDb: 0, outGainDb: 0,
})

export const defaultConfig = (): GatewayConfig => ({
  server: 'ws://localhost:8900', username: '', password: '', autoConnect: true,
  device: { inputId: '', outputId: '', inputChannels: 2, outputChannels: 2 },
  ports: [],
})

/** Settings that need the audio graph rebuilt when they change (the rest apply live). */
export function structuralKey(cfg: GatewayConfig): string {
  return JSON.stringify({
    d: cfg.device,
    p: cfg.ports.map(p => ({
      id: p.id, e: p.enabled, c: p.channel, s: p.source, i: p.inCh, o: p.outCh,
      r: p.source === 'rtp' ? p.rtp : null,
    })),
  })
}

declare global {
  interface Window {
    gw?: {
      getConfig(): Promise<GatewayConfig | null>
      setConfig(c: GatewayConfig): Promise<void>
      rtpOpen(id: string, c: RtpCfg): Promise<{ ok: boolean; error?: string }>
      rtpClose(id: string): Promise<void>
      rtpTx(id: string, samples: Float32Array): void
      onRtpRx(cb: (id: string, s: Float32Array) => void): void
      onRtpStats(cb: (id: string, s: { packets: number; lost: number; late: number }) => void): void
    }
  }
}

const dbToGain = (db: number) => Math.pow(10, db / 20)
const SILENCE_DB = -120

export interface PortRuntime {
  cfg: PortCfg
  error: string
  open: boolean                // VOX currently keying the channel
  access: 'ok' | 'listen-only' | 'talk-only' | 'none'
  rtpStats: { packets: number; lost: number; late: number } | null
  inDb(): number
  outDb(): number
  setTone(on: boolean): void
  tone: boolean
}

class Port implements PortRuntime {
  error = ''
  open = false
  tone = false
  access: PortRuntime['access'] = 'none'
  rtpStats: PortRuntime['rtpStats'] = null
  lastAbove = 0
  lastOut = 0
  nodes: AudioNode[] = []
  rxNode: AudioWorkletNode | null = null
  inAn!: AnalyserNode
  outAn!: AnalyserNode
  inGain!: GainNode
  outGain!: GainNode
  toneGain!: GainNode
  private buf = new Float32Array(1024)

  constructor(public cfg: PortCfg) {}

  private level(an: AnalyserNode): number {
    an.getFloatTimeDomainData(this.buf)
    let peak = 0
    for (const v of this.buf) { const a = Math.abs(v); if (a > peak) peak = a }
    return peak > 1e-6 ? 20 * Math.log10(peak) : SILENCE_DB
  }
  inDb() { return this.inAn ? this.level(this.inAn) : SILENCE_DB }
  outDb() { return this.outAn ? this.level(this.outAn) : SILENCE_DB }
  setTone(on: boolean) { this.tone = on; if (this.toneGain) this.toneGain.gain.value = on ? 0.2 : 0 }
}

export class GatewayRuntime {
  ports: Port[] = []
  deviceError = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private stream: MediaStream | null = null
  private builtKey = ''
  private building = false
  private rtpBound = false

  constructor(private engine: CommsEngine, private onChange: () => void) {}

  get built() { return this.builtKey !== '' }
  isStale(cfg: GatewayConfig) { return this.builtKey !== structuralKey(cfg) }

  /** Create the audio graph for every enabled port. Needs the engine connected (its context exists). */
  async build(cfg: GatewayConfig): Promise<void> {
    if (this.building) return
    this.building = true
    try {
      this.teardown()
      this.builtKey = structuralKey(cfg)
      const ctx = this.engine.audioContext
      if (!ctx) throw new Error('Audio context not ready')
      const active = cfg.ports.filter(p => p.enabled)
      this.deviceError = ''

      // ── shared device input/output ──
      let splitter: ChannelSplitterNode | null = null
      let merger: ChannelMergerNode | null = null
      let inChans = 0
      if (active.some(p => p.source === 'device')) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: cfg.device.inputId ? { exact: cfg.device.inputId } : undefined,
              channelCount: { ideal: cfg.device.inputChannels },
              echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            },
          })
          inChans = this.stream.getAudioTracks()[0].getSettings().channelCount ?? 1
          const src = ctx.createMediaStreamSource(this.stream)
          splitter = ctx.createChannelSplitter(Math.max(inChans, cfg.device.inputChannels))
          src.connect(splitter)
          const setSink = (ctx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId
          if (cfg.device.outputId && setSink) await setSink.call(ctx, cfg.device.outputId)
          const outCh = Math.max(1, Math.min(ctx.destination.maxChannelCount || 2, cfg.device.outputChannels))
          ctx.destination.channelCount = outCh
          ctx.destination.channelInterpretation = 'discrete'
          merger = ctx.createChannelMerger(outCh)
          merger.connect(ctx.destination)
        } catch (e) {
          this.deviceError = `Audio device: ${(e as Error).message}`
        }
      }

      const needRtp = active.some(p => p.source === 'rtp')
      if (needRtp) {
        if (!window.gw) this.deviceError ||= 'Network audio (RTP) needs the desktop app'
        else {
          await ctx.audioWorklet.addModule('rtp-worklet.js')
          this.bindRtpEvents()
        }
      }

      for (const cfgPort of active) {
        const p = new Port(cfgPort)
        this.ports.push(p)
        try { await this.wirePort(ctx, p, splitter, merger, inChans) } catch (e) { p.error = (e as Error).message }
      }

      this.timer = setInterval(() => this.voxTick(), 20)
    } finally {
      this.building = false
      this.onChange()
    }
  }

  private async wirePort(ctx: AudioContext, p: Port, splitter: ChannelSplitterNode | null, merger: ChannelMergerNode | null, inChans: number) {
    const c = p.cfg
    if (!c.channel) { p.error = 'Pick an Arena channel'; return }

    // Common input chain: source -> inGain -> analyser, and -> look-ahead delay -> channel transmit bus.
    p.inGain = ctx.createGain(); p.inGain.gain.value = dbToGain(c.inGainDb)
    p.inAn = ctx.createAnalyser(); p.inAn.fftSize = 1024; p.inAn.smoothingTimeConstant = 0
    const delay = ctx.createDelay(0.1); delay.delayTime.value = 0.03
    p.inGain.connect(p.inAn)
    p.inGain.connect(delay)
    delay.connect(this.engine.channelTx(c.channel))
    // Built-in test tone (1 kHz) for commissioning, injected ahead of the gain stage.
    const osc = ctx.createOscillator(); osc.frequency.value = 1000
    p.toneGain = ctx.createGain(); p.toneGain.gain.value = 0
    osc.connect(p.toneGain).connect(p.inGain); osc.start()

    // Common output chain: channel receive bus -> outGain -> analyser (and sink).
    p.outGain = ctx.createGain(); p.outGain.gain.value = dbToGain(c.outGainDb)
    p.outAn = ctx.createAnalyser(); p.outAn.fftSize = 1024; p.outAn.smoothingTimeConstant = 0
    this.engine.channelRx(c.channel).connect(p.outGain)
    p.outGain.connect(p.outAn)

    if (c.source === 'device') {
      if (!splitter || !merger) { p.error = 'Audio device not available'; return }
      if (c.inCh < 1 || c.inCh > inChans) p.error = `Input channel ${c.inCh} not available (device gives ${inChans})`
      else splitter.connect(p.inGain, c.inCh - 1)
      if (c.outCh < 1 || c.outCh > merger.numberOfInputs) p.error = p.error || `Output channel ${c.outCh} not available (${merger.numberOfInputs} outputs)`
      else p.outGain.connect(merger, 0, c.outCh - 1)
    } else if (c.source === 'rtp') {
      const r = c.rtp
      const res = await window.gw!.rtpOpen(c.id, r)
      if (!res.ok) { p.error = `Network audio: ${res.error}`; return }
      p.rxNode = new AudioWorkletNode(ctx, 'rtp-rx', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { targetSamples: Math.round((r.bufferMs / 1000) * 48000) },
      })
      p.rxNode.connect(p.inGain)
      const tx = new AudioWorkletNode(ctx, 'rtp-tx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      tx.port.onmessage = e => window.gw!.rtpTx(c.id, e.data as Float32Array)
      p.outGain.connect(tx)
      const sink = ctx.createGain(); sink.gain.value = 0 // keeps the tap pulled by the graph without making sound
      tx.connect(sink).connect(ctx.destination)
    }
    // 'tone' sources have no external audio: test tone in, meters out.
  }

  private bindRtpEvents() {
    if (this.rtpBound || !window.gw) return
    this.rtpBound = true
    window.gw.onRtpRx((id, s) => { this.ports.find(p => p.cfg.id === id)?.rxNode?.port.postMessage(s) })
    window.gw.onRtpStats((id, s) => { const p = this.ports.find(q => q.cfg.id === id); if (p) p.rtpStats = s })
  }

  /** Apply live-adjustable settings without rebuilding. */
  updateParams(cfg: GatewayConfig) {
    for (const p of this.ports) {
      const next = cfg.ports.find(x => x.id === p.cfg.id)
      if (!next) continue
      p.cfg = next
      if (p.inGain) p.inGain.gain.value = dbToGain(next.inGainDb)
      if (p.outGain) p.outGain.gain.value = dbToGain(next.outGainDb)
    }
  }

  /** Voice-activity keying of each port's Arena channel. */
  private voxTick() {
    const now = performance.now()
    let changed = false
    const chans = this.engine.channels.filter(c => !c.music) // music channels are not carried by the gateway
    for (const p of this.ports) {
      const ch = chans.find(c => c.id === p.cfg.channel)
      const access: Port['access'] = !ch ? 'none' : ch.canTalk && ch.canListen ? 'ok' : ch.canTalk ? 'talk-only' : ch.canListen ? 'listen-only' : 'none'
      if (access !== p.access) { p.access = access; changed = true }
      if (!p.inAn) continue
      const v = p.cfg.vox
      const outDb = p.outDb()
      if (outDb > -50) p.lastOut = now
      // Echo guard: while the Arena side is playing into the comms system, ignore what comes back.
      const guarded = v.echoGuard && now - p.lastOut < 250
      const above = !guarded && p.inDb() > v.thresholdDb
      if (above) p.lastAbove = now
      const want = (ch?.canTalk ?? false) && (above || (p.open && now - p.lastAbove < v.hangMs))
      // The engine drops held keys on a server reconnect, so compare with its real state, not just ours.
      const keyed = this.engine.talkSet.has(p.cfg.channel)
      if (want && !keyed) this.engine.press(p.cfg.channel)
      else if (!want && keyed) this.engine.release(p.cfg.channel)
      if (want !== p.open) { p.open = want; changed = true }
    }
    if (changed) this.onChange()
  }

  teardown() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const p of this.ports) {
      if (p.open) this.engine.release(p.cfg.channel)
      if (p.cfg.source === 'rtp') void window.gw?.rtpClose(p.cfg.id)
      p.rxNode?.disconnect()
    }
    this.ports = []
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    this.builtKey = ''
  }
}
