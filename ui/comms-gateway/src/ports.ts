// Gateway ports: each one bridges a comms-system audio path to one Arena channel.
//
//   comms system -> [source] -> inGain -> (VOX look-ahead delay) -> channelTx(ch)   key/unkey via VOX
//   channelRx(ch) -> outGain -> [sink] -> comms system
//
// A partyline has no push-to-talk, so the gateway keys the Arena channel with a
// voice-activity detector. A short look-ahead delay lets the VOX open before the
// first syllable reaches the network.

import type { CommsEngine } from '@engine'

export type SourceKind = 'device' | 'asio' | 'rtp' | 'tone'
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
  /** 1-based device channel numbers (source: 'device'), within the device this port uses. */
  inCh: number
  outCh: number
  /**
   * Per-port audio devices (source: 'device'); blank = the shared device. This lets an interface that Windows shows as many
   * stereo devices (a Focusrite: "Analogue 1 + 2", "Analogue 3 + 4", ...) feed many ports: pick the pair, then channel 1 or 2.
   */
  inputId?: string
  outputId?: string
  /** Which ASIO interface (AsioCfg.id) the input / output channel belongs to (source: 'asio'); blank = the first one. */
  inDev?: string
  outDev?: string
  rtp: RtpCfg
  vox: { thresholdDb: number; hangMs: number; echoGuard: boolean }
  inGainDb: number
  outGainDb: number
}
/** An ASIO driver the desktop app can open (a Focusrite, Dante Virtual Soundcard, ...). */
export interface AsioDevice { id: number; name: string; inputChannels: number; outputChannels: number; sampleRates: number[] }
export interface AsioOpenResult {
  ok: boolean; error?: string; driver?: string
  /** Channels the driver offers, and how many were opened for the ports in use. */
  inputChannels?: number; outputChannels?: number; openedIn?: number; openedOut?: number
  frames?: number; latencyFrames?: number
}
/** One ASIO interface: which driver, its buffer size, and your names for its channels (index 0 = channel 1). */
export interface AsioCfg { id: string; driver: string; deviceId: number; frames: number; inputNames: string[]; outputNames: string[] }
export const newAsio = (n: number): AsioCfg => ({ id: `a${Date.now().toString(36)}${n}`, driver: '', deviceId: -1, frames: 256, inputNames: [], outputNames: [] })
interface AsioGraph { splitter: ChannelSplitterNode | null; chans: number; merger: ChannelMergerNode | null; outs: number; devIn: number; devOut: number }
export interface DeviceCfg { inputId: string; outputId: string; inputChannels: number; outputChannels: number }
export interface GatewayConfig {
  /** How this gateway shows up in the server's list of people. */
  name: string
  server: string; username: string; password: string; autoConnect: boolean
  device: DeviceCfg
  asio: AsioCfg[]
  ports: PortCfg[]
}

export const defaultRtp = (): RtpCfg => ({
  rxAddr: '239.69.0.1', rxPort: 5004, rxFormat: 'L24', rxChannels: 1, rxChannel: 0, rxPayloadType: 97,
  txAddr: '239.69.0.2', txPort: 5004, txFormat: 'L24', txPayloadType: 97, ptimeMs: 1, bufferMs: 40,
})

export const newPort = (n: number): PortCfg => ({
  id: `p${Date.now().toString(36)}${n}`, name: `Port ${n}`, enabled: true, channel: '', source: 'device',
  inCh: n, outCh: n, inputId: '', outputId: '', rtp: defaultRtp(), vox: { thresholdDb: -45, hangMs: 400, echoGuard: true }, inGainDb: 0, outGainDb: 0,
})

export const defaultConfig = (): GatewayConfig => ({
  name: 'Gateway', server: '', username: '', password: '', autoConnect: true,
  device: { inputId: '', outputId: '', inputChannels: 2, outputChannels: 2 },
  asio: [],
  ports: [],
})

/** Settings that need the audio graph rebuilt when they change (the rest apply live). */
export function structuralKey(cfg: GatewayConfig): string {
  return JSON.stringify({
    d: cfg.device,
    a: (cfg.asio ?? []).map(a => ({ i: a.id, d: a.driver || a.deviceId, f: a.frames })),
    p: cfg.ports.map(p => ({
      id: p.id, e: p.enabled, c: p.channel, s: p.source, i: p.inCh, o: p.outCh, di: p.inDev ?? '', do: p.outDev ?? '', ii: p.inputId ?? '', oi: p.outputId ?? '',
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
      asioList(): Promise<{ ok: boolean; devices?: AsioDevice[]; error?: string }>
      asioOpen(slot: string, c: { deviceId: number; inputs: number; outputs: number; frames?: number }): Promise<AsioOpenResult>
      asioClose(slot?: string): Promise<void>
      asioTx(slot: string, planar: Float32Array): void
      onAsioRx(cb: ((slot: string, planar: Float32Array) => void) | null): void
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
  private streams: MediaStream[] = []
  private sinks: HTMLAudioElement[] = []
  private builtKey = ''
  private building = false
  private rtpBound = false
  /** What each interface opened as (by AsioCfg.id), and its driver's channel counts. */
  asioInfo = new Map<string, AsioOpenResult>()
  private asioNodes: AudioNode[] = []
  /** Peak level (0..1, slowly falling) of every interface input and output, for the routing grid's meters. */
  private asioPeaks = new Map<string, { in: Float32Array; out: Float32Array }>()
  asioLevelDb(id: string, kind: 'in' | 'out', i: number): number {
    const v = this.asioPeaks.get(id)?.[kind][i] ?? 0
    return v > 1e-5 ? 20 * Math.log10(v) : SILENCE_DB
  }

  constructor(private engine: CommsEngine, private onChange: () => void) {}

  get built() { return this.builtKey !== '' }
  isStale(cfg: GatewayConfig) { return this.builtKey !== structuralKey(cfg) }

  /** Fold one planar block (channel-major) into the per-channel peaks: instant rise, slow fall. */
  private trackPeaks(peaks: Float32Array, planar: Float32Array, chans: number) {
    const len = Math.floor(planar.length / chans)
    for (let c = 0; c < chans; c++) {
      let m = 0
      for (let i = c * len, e = i + len; i < e; i++) { const a = planar[i] < 0 ? -planar[i] : planar[i]; if (a > m) m = a }
      peaks[c] = Math.max(m, peaks[c] * 0.97)
    }
  }

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

      // ── audio devices: the shared one plus any a port picks for itself, each opened once ──
      type DevIn = { splitter: ChannelSplitterNode; chans: number }
      type DevOut = { merger: ChannelMergerNode; outs: number }
      const ins = new Map<string, DevIn>()
      const outs = new Map<string, DevOut>()
      const inErr = new Map<string, string>()
      const outErr = new Map<string, string>()
      const getIn = async (id: string): Promise<DevIn | undefined> => {
        if (ins.has(id) || inErr.has(id)) return ins.get(id)
        try {
          const shared = id === cfg.device.inputId
          const want = shared ? cfg.device.inputChannels : 2
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: id ? { exact: id } : undefined,
              channelCount: { ideal: want },
              echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            },
          })
          this.streams.push(stream)
          const chans = stream.getAudioTracks()[0].getSettings().channelCount ?? 1
          const src = ctx.createMediaStreamSource(stream)
          const splitter = ctx.createChannelSplitter(Math.max(chans, want))
          src.connect(splitter)
          ins.set(id, { splitter, chans })
        } catch (e) { inErr.set(id, `Input device: ${(e as Error).message}`) }
        return ins.get(id)
      }
      const getOut = async (id: string): Promise<DevOut | undefined> => {
        if (outs.has(id) || outErr.has(id)) return outs.get(id)
        try {
          if (id === cfg.device.outputId) {
            // The shared output is the audio context's own output, which can carry many channels.
            const setSink = (ctx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId
            if (id && setSink) await setSink.call(ctx, id)
            const n = Math.max(1, Math.min(ctx.destination.maxChannelCount || 2, cfg.device.outputChannels))
            ctx.destination.channelCount = n
            ctx.destination.channelInterpretation = 'discrete'
            const merger = ctx.createChannelMerger(n)
            merger.connect(ctx.destination)
            outs.set(id, { merger, outs: n })
          } else {
            // Any other output device gets a stereo path through its own audio element.
            const dest = ctx.createMediaStreamDestination()
            dest.channelCount = 2
            dest.channelCountMode = 'explicit'
            dest.channelInterpretation = 'discrete'
            const merger = ctx.createChannelMerger(2)
            merger.connect(dest)
            const el = new Audio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
            el.srcObject = dest.stream
            if (id && el.setSinkId) await el.setSinkId(id)
            await el.play().catch(() => { /* started by the first audio */ })
            this.sinks.push(el)
            outs.set(id, { merger, outs: 2 })
          }
        } catch (e) { outErr.set(id, `Output device: ${(e as Error).message}`) }
        return outs.get(id)
      }

      // ── ASIO: every channel of every interface, each bridged by the desktop app ──
      const asio = new Map<string, AsioGraph>()
      const wanted = (cfg.asio ?? []).filter(a => a.driver || a.deviceId >= 0)
      if (wanted.length && !window.gw?.asioOpen) {
        if (active.some(p => p.source === 'asio')) this.deviceError ||= 'ASIO needs the desktop app'
      } else if (wanted.length) {
        const listed = (await window.gw!.asioList()).devices ?? []
        const handlers = new Map<string, (buf: Float32Array) => void>()
        window.gw!.onAsioRx((slot, buf) => handlers.get(slot)?.(buf))
        let moduleLoaded = false
        for (const a of wanted) {
          // The driver is found by name (its number can change between boots), then by the number saved with it.
          const dev = listed.find(d => d.name === a.driver) ?? listed.find(d => d.id === a.deviceId)
          const using = active.some(p => p.source === 'asio' && (p.inDev || cfg.asio[0].id) === a.id || p.source === 'asio' && (p.outDev || cfg.asio[0].id) === a.id)
          if (!dev) { if (using) this.deviceError ||= `ASIO driver "${a.driver || a.deviceId}" is not available. Is the interface plugged in and switched on?`; continue }
          // The whole interface is opened even with nothing routed yet, so the grid's meters show activity.
          const res = await window.gw!.asioOpen(a.id, { deviceId: dev.id, inputs: 64, outputs: 64, frames: a.frames })
          this.asioInfo.set(a.id, res)
          if (!res.ok) { this.deviceError ||= `ASIO ${dev.name}: ${res.error}`; continue }
          if (!moduleLoaded) { await ctx.audioWorklet.addModule('asio-worklet.js'); moduleLoaded = true }
          const g: AsioGraph = { splitter: null, chans: res.openedIn ?? 0, merger: null, outs: res.openedOut ?? 0, devIn: res.inputChannels ?? 0, devOut: res.outputChannels ?? 0 }
          const peaks = { in: new Float32Array(res.openedIn ?? 0), out: new Float32Array(res.openedOut ?? 0) }
          this.asioPeaks.set(a.id, peaks)
          if ((res.openedIn ?? 0) > 0) {
            const nIn = res.openedIn!
            const inNode = new AudioWorkletNode(ctx, 'asio-in', {
              numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [nIn], processorOptions: { targetSamples: 512 },
            })
            handlers.set(a.id, buf => {
              this.trackPeaks(peaks.in, buf, nIn)
              inNode.port.postMessage(buf, [buf.buffer])
            })
            const splitter = ctx.createChannelSplitter(nIn)
            inNode.connect(splitter)
            g.splitter = splitter
            this.asioNodes.push(inNode, splitter)
          }
          if ((res.openedOut ?? 0) > 0) {
            const nOut = res.openedOut!
            const outNode = new AudioWorkletNode(ctx, 'asio-out', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: nOut,
              channelCountMode: 'explicit', channelInterpretation: 'discrete', processorOptions: { channels: nOut },
            })
            outNode.port.onmessage = e => {
              const blk = e.data as Float32Array
              this.trackPeaks(peaks.out, blk, nOut)
              window.gw?.asioTx(a.id, blk)
            }
            const merger = ctx.createChannelMerger(nOut)
            merger.connect(outNode)
            const sink = ctx.createGain()
            sink.gain.value = 0 // keeps the node pulled by the graph without making any sound
            outNode.connect(sink).connect(ctx.destination)
            g.merger = merger
            this.asioNodes.push(outNode, sink, merger)
          }
          asio.set(a.id, g)
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
        try {
          let inDev: DevIn | undefined
          let outDev: DevOut | undefined
          if (cfgPort.source === 'device') {
            inDev = await getIn(cfgPort.inputId || cfg.device.inputId)
            outDev = await getOut(cfgPort.outputId || cfg.device.outputId)
          }
          await this.wirePort(ctx, p, inDev, outDev, asio, cfg.asio?.[0]?.id ?? '')
        } catch (e) { p.error = (e as Error).message }
      }
      this.deviceError = [...new Set([...inErr.values(), ...outErr.values()])].join('. ')

      this.timer = setInterval(() => this.voxTick(), 20)
    } finally {
      this.building = false
      this.onChange()
    }
  }

  private async wirePort(ctx: AudioContext, p: Port, inDev?: { splitter: ChannelSplitterNode; chans: number }, outDev?: { merger: ChannelMergerNode; outs: number }, asio?: Map<string, AsioGraph>, firstAsio = '') {
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
      if (!inDev) p.error = 'Input device not available'
      else if (c.inCh < 1 || c.inCh > inDev.chans) p.error = `Input channel ${c.inCh} not available (this device gives ${inDev.chans})`
      else inDev.splitter.connect(p.inGain, c.inCh - 1)
      if (!outDev) p.error = p.error || 'Output device not available'
      else if (c.outCh < 1 || c.outCh > outDev.outs) p.error = p.error || `Output channel ${c.outCh} not available (this device has ${outDev.outs} outputs)`
      else p.outGain.connect(outDev.merger, 0, c.outCh - 1)
    } else if (c.source === 'asio') {
      const gi = asio?.get(c.inDev || firstAsio)
      const go = asio?.get(c.outDev || firstAsio)
      if (c.inCh < 1) { /* no input routed */ } else if (!gi) p.error = 'ASIO interface not available'
      else if (!gi.splitter || c.inCh > gi.chans) p.error = `ASIO input ${c.inCh} not available (this driver has ${gi.devIn})`
      else gi.splitter.connect(p.inGain, c.inCh - 1)
      if (c.outCh < 1) { /* no output routed */ } else if (!go) p.error = p.error || 'ASIO interface not available'
      else if (!go.merger || c.outCh > go.outs) p.error = p.error || `ASIO output ${c.outCh} not available (this driver has ${go.devOut})`
      else p.outGain.connect(go.merger, 0, c.outCh - 1)
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
    for (const st of this.streams) st.getTracks().forEach(t => t.stop())
    this.streams = []
    for (const el of this.sinks) { el.pause(); el.srcObject = null }
    this.sinks = []
    if (this.asioNodes.length || this.asioInfo.size) {
      window.gw?.onAsioRx(null)
      void window.gw?.asioClose()
      for (const n of this.asioNodes) n.disconnect()
      this.asioNodes = []
      this.asioInfo.clear()
      this.asioPeaks.clear()
    }
    this.builtKey = ''
  }
}
