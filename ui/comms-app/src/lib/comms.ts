import { Room, RoomEvent, Track, RemoteAudioTrack, LocalTrackPublication } from 'livekit-client'

// Arena Comms engine: signaling socket + WebRTC audio mesh + talk/listen routing.
//
// Audio graph:   mic -> micGain -+-> analyser (meter)
//                                +-> peerGain[a] -> dest[a] -> RTCPeerConnection[a]
//                                +-> peerGain[b] -> dest[b] -> RTCPeerConnection[b]
// A peer's gain is 1 only while I'm talking on a channel that peer listens to
// (or talking directly to them), so nothing but silence is ever sent otherwise.

export interface Channel { id: string; name: string; color: string; ifb?: boolean; music?: boolean; withMusic?: boolean; stream?: boolean; link?: string; noDuck?: boolean; duck?: number; canTalk: boolean; canListen: boolean; canMusic?: boolean }
export type MediaMode = 'mesh' | 'sfu'
/** Where the music I send comes from: an input device (virtual cable / loopback) or shared tab/system audio. */
export type MusicSource = { kind: 'device'; deviceId: string } | { kind: 'display' } | { kind: 'stream' }
interface MusicTx {
  /** Capture sources have a MediaStream; the channel's stream URL is played through an audio element instead. */
  stream: MediaStream | null; el: HTMLAudioElement | null; src: AudioNode; gain: GainNode
  /** Watchdog for the channel stream (see startMusic). */
  watch?: ReturnType<typeof setInterval>
  dest: MediaStreamAudioDestinationNode; an: AnalyserNode; buf: Float32Array<ArrayBuffer>
}
export type StreamState = 'unknown' | 'live' | 'down' | 'stalled'
export interface ArenaStream { id: string; name: string; channel: string | null; state: StreamState }
export interface ArenaAlert { text: string; level: 'warn' | 'ok'; at: number; stream: string | null }
export type ProgramState = 'off' | 'connecting' | 'live' | 'error'
export interface PeerInfo { id: string; name: string; role: string; talk: string[]; listen: string[] }
export type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface JoinOptions {
  url: string
  name: string
  /** 'accounts': sign in with username/password. 'open': pick a name and a group. */
  auth: 'accounts' | 'open'
  username?: string
  password?: string
  /** A session token from an earlier sign-in: rejoin without the password. */
  token?: string
  group?: string
  pin: string
  micId?: string
  echoCancel: boolean
  /** Gateway mode: no microphone/speakers; audio enters and leaves through per-channel buses (SFU only). */
  gateway?: boolean
  /** Overrides the server-provided program feed (WHEP URL). */
  programUrl?: string
}

interface Peer {
  info: PeerInfo
  pc: RTCPeerConnection
  gain: GainNode
  dest: MediaStreamAudioDestinationNode
  voice: Voice | null
  initiator: boolean
  rttMs: number | null
  connState: RTCPeerConnectionState
}

type SinkCtx = { setSinkId?: (id: string) => Promise<void> }
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

/** One remote talker as heard here: source -> stereo pan -> level -> output bus. */
interface Voice {
  src: MediaStreamAudioSourceNode
  mono: GainNode
  pan: StereoPannerNode
  gain: GainNode
  hold: HTMLAudioElement // Chromium only feeds remote WebRTC audio to WebAudio if an element holds the stream
  ch: string             // SFU: the channel this track carries ('' = direct); mesh: unused
}

export interface SpatialConfig { on: boolean; spread: number; overrides: Record<string, number> }

const isUser = (t: string) => t.startsWith('u:')

/** Low-latency Opus: mono, 32 kbps, FEC + DTX, 10 ms minimum packet time. */
export function tuneOpus(sdp: string): string {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/.exec(sdp)
  if (!m) return sdp
  const pt = m[1]
  const params = 'minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000'
  const fmtp = new RegExp(`a=fmtp:${pt} [^\\r\\n]*`)
  if (fmtp.test(sdp)) return sdp.replace(fmtp, `a=fmtp:${pt} ${params}`)
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${params}`)
}

/** ws://host:8900 -> http://host:8900 (for /info and the admin page). */
export function httpBase(wsUrl: string): string {
  return wsUrl.trim().replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, '')
}

export class CommsEngine {
  status: Status = 'idle'
  error = ''
  myId = ''
  channels: Channel[] = []
  /** Gateway only: each group and the channels it can use. */
  groups: { id: string; name: string; channels: string[] }[] = []
  myName = ''
  myTitle = ''
  isAdmin = false
  listen = new Set<string>()
  held = new Set<string>()
  latched = new Set<string>()
  peers = new Map<string, Peer>()
  /** channel id -> {from, at} of the latest call signal */
  calls = new Map<string, { from: string; at: number }>()
  serverRttMs: number | null = null
  /** Session token for rejoining after a reload (accounts mode), and the code of the last error. */
  sessionToken: string | null = null
  errorCode = ''
  /** Who is sending on each music channel I may hear: channel id -> (peer id -> name). */
  musicSenders = new Map<string, Map<string, string>>()
  musicError = ''
  /** Secret that lets the server relay a music channel's stream URL to me (sent at join). */
  private musicKey = ''
  private musicRx = new Map<string, { ch: string; src: MediaStreamAudioSourceNode; hold: HTMLAudioElement }>()
  private musicRxGain = new Map<string, GainNode>()
  private musicTx = new Map<string, MusicTx>()
  private musicPubs = new Map<string, LocalTrackPublication>()
  /** Arena stream health, pushed by the server's stream monitor. */
  streams: ArenaStream[] = []
  /** Latest alert per channel ('' = not tied to a channel). */
  private alerts = new Map<string, ArenaAlert>()
  speakAlerts = true
  alertTones = true
  media: MediaMode = 'mesh'
  program: { name: string; url: string } | null = null
  programState: ProgramState = 'off'
  programError = ''
  programVolume = 0.8
  programMuted = false
  /** True while an IFB channel I listen to has a talker: program is ducked. */
  ducked = false
  masterVolume = 1
  /** Spatial audio: spread channels across the stereo field (key order, or per-channel overrides). */
  spatial: SpatialConfig = { on: false, spread: 0.7, overrides: {} }
  /** Per-channel listen level (0..1, default 1): the knob on each key. */
  private chLevels = new Map<string, number>()
  micVolume = 1

  private version = 0
  private listeners = new Set<() => void>()
  private ws: WebSocket | null = null
  private opts: JoinOptions | null = null
  private ice: RTCIceServer[] = []
  private ctx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private micSrc: MediaStreamAudioSourceNode | null = null
  private micGain: GainNode | null = null
  /** Release the microphone device while nobody is being talked to (see syncMic). */
  micIdleRelease = true
  private micIdleTimer: ReturnType<typeof setTimeout> | null = null
  private micOpening: Promise<void> | null = null
  private analyser: AnalyserNode | null = null
  private meterBuf: Float32Array<ArrayBuffer> | null = null
  private spkId = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private wantMuted = new Set<string>()
  private stopped = true
  private room: Room | null = null
  private sfuGains = new Map<string, GainNode>()
  private rxBus = new Map<string, GainNode>()
  private txBus = new Map<string, GainNode>()
  private gwSrc = new Map<string, { src: MediaStreamAudioSourceNode; hold: HTMLAudioElement }>()
  private sfuPubs = new Map<string, LocalTrackPublication>()
  private sfuSync: Promise<void> = Promise.resolve()
  private sfuVoices = new Map<string, Voice>()
  private mix: GainNode | null = null
  private mixAn: [AnalyserNode, AnalyserNode] | null = null
  private mixBuf = new Float32Array(512)
  private duckLevel = 1
  private duckTimer: ReturnType<typeof setTimeout> | null = null
  private progPc: RTCPeerConnection | null = null
  private progLocation: string | null = null
  private progWanted = false
  private progRetry: ReturnType<typeof setTimeout> | null = null
  private progHold: HTMLAudioElement | null = null
  private progOut: SinkAudio | null = null
  private progSrc: MediaStreamAudioSourceNode | null = null
  private progGain: GainNode | null = null
  private progAnalyser: AnalyserNode | null = null
  private progBuf: Float32Array<ArrayBuffer> | null = null
  private progPackets = -1
  private progMovedAt = 0

  // ── external-store plumbing for React ──────────────────────────────────────
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getVersion = () => this.version
  private emit() { this.version++; this.listeners.forEach(f => f()) }

  /** The audio context (gateways wire ports and devices straight into it). */
  get audioContext(): AudioContext | null { return this.ctx }

  /** Gateway: mix of everyone talking on this channel, as heard by the gateway. */
  channelRx(ch: string): GainNode {
    let g = this.rxBus.get(ch)
    if (!g) { g = this.ctx!.createGain(); this.rxBus.set(ch, g) }
    return g
  }

  /** Gateway: connect a port's input here; it is sent to the channel while the gateway is keyed (press/release). */
  channelTx(ch: string): GainNode {
    let g = this.txBus.get(ch)
    if (!g) { g = this.ctx!.createGain(); this.txBus.set(ch, g) }
    return g
  }

  get talkSet(): Set<string> { return new Set([...this.held, ...this.latched]) }
  get me(): { id: string } { return { id: this.myId } }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async join(opts: JoinOptions, mutedChannels: string[] = [], levels: Record<string, number> = {}) {
    this.leave()
    this.opts = opts
    this.stopped = false
    this.wantMuted = new Set(mutedChannels)
    this.chLevels = new Map(Object.entries(levels))
    this.status = 'connecting'
    this.error = ''
    this.errorCode = ''
    this.emit()
    try {
      await this.initAudio(opts.micId, opts.echoCancel)
    } catch (e) {
      this.fatal(`Microphone unavailable: ${(e as Error).message}`)
      return
    }
    this.openSocket()
  }

  leave() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.teardownSession()
    this.ws?.close()
    this.ws = null
    this.stopProgram()
    this.progGain = null
    this.progAnalyser = null
    this.progOut = null
    this.stopAllMusic(false)
    this.musicSenders.clear()
    this.musicRxGain.clear()
    if (this.micIdleTimer) clearTimeout(this.micIdleTimer)
    this.micIdleTimer = null
    this.closeMic()
    this.ctx?.close().catch(() => {})
    this.ctx = null
    this.rxBus.clear()
    this.txBus.clear()
    this.mix = null
    this.mixAn = null
    this.streams = []
    this.alerts.clear()
    this.micGain = null
    this.analyser = null
    this.held.clear()
    this.latched.clear()
    this.status = 'idle'
    this.emit()
  }

  private fatal(message: string) {
    this.stopped = true
    this.teardownSession()
    this.ws?.close()
    this.ws = null
    this.status = 'error'
    this.error = message
    this.emit()
  }

  private teardownSession() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id)
    this.pendingInfo.clear()
    void this.closeSfu()
    if (this.statsTimer) clearInterval(this.statsTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.statsTimer = this.pingTimer = null
  }

  // ── audio input / output ───────────────────────────────────────────────────
  private async initAudio(micId: string | undefined, echoCancel: boolean) {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
      if (this.spkId && !this.opts?.gateway) void (this.ctx as unknown as SinkCtx).setSinkId?.(this.spkId)?.catch?.(() => {})
    }
    // A page reload has no user gesture yet, so the browser may keep the context suspended; resume() would then
    // wait for the first click. Don't block joining on it: the UI asks for a click (see audioBlocked).
    this.ctx.onstatechange = () => this.emit()
    void this.ctx.resume().catch(() => {})
    if (this.opts?.gateway) {
      // Gateways take audio from ports, not a mic; keep a silent micGain so shared code paths still work.
      if (!this.micGain) this.micGain = this.ctx.createGain()
      return
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micId ? { exact: micId } : undefined,
        echoCancellation: echoCancel,
        noiseSuppression: echoCancel,
        autoGainControl: false,
        channelCount: 1,
      },
    })
    this.micStream?.getTracks().forEach(t => t.stop())
    this.micSrc?.disconnect()
    this.micStream = stream
    if (!this.micGain) {
      this.micGain = this.ctx.createGain()
      this.micGain.gain.value = this.micVolume
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.meterBuf = new Float32Array(this.analyser.fftSize)
      this.micGain.connect(this.analyser)
    }
    this.micSrc = this.ctx.createMediaStreamSource(stream)
    this.micSrc.connect(this.micGain)
  }

  async setMic(micId: string, echoCancel: boolean) {
    if (this.opts) { this.opts.micId = micId; this.opts.echoCancel = echoCancel }
    if (this.ctx) await this.initAudio(micId, echoCancel)
    this.syncMic()
  }

  /**
   * With micIdleRelease on, the microphone device is only open while I'm talking (held or latched,
   * on a channel or directly) plus a short linger so quick re-presses don't reopen it. Everything
   * downstream stays wired to micGain, so reopening just feeds it again. The cost is a small delay
   * on the first press after idle while the device starts. With it off, the mic stays open as before.
   */
  syncMic() {
    if (!this.ctx || this.opts?.gateway) return
    const timer = this.micIdleTimer
    if (!this.micIdleRelease || this.talkSet.size > 0) {
      if (timer) { clearTimeout(timer); this.micIdleTimer = null }
      if (!this.micStream) void this.openMic()
      return
    }
    if (this.micStream && !timer) {
      this.micIdleTimer = setTimeout(() => {
        this.micIdleTimer = null
        if (this.micIdleRelease && this.talkSet.size === 0) this.closeMic()
      }, 1200)
    }
  }

  private openMic(): Promise<void> {
    if (this.micOpening) return this.micOpening
    this.micOpening = this.initAudio(this.opts?.micId, this.opts?.echoCancel ?? true)
      .catch(e => {
        if (!this.ctx) { this.micStream?.getTracks().forEach(t => t.stop()); this.micStream = null } // left while opening
        else console.warn('[comms] could not reopen the microphone', e)
      })
      .finally(() => { this.micOpening = null })
    return this.micOpening
  }

  private closeMic() {
    this.micStream?.getTracks().forEach(t => t.stop())
    this.micStream = null
    this.micSrc?.disconnect()
    this.micSrc = null
  }

  setSpeaker(id: string) {
    this.spkId = id
    void (this.ctx as unknown as SinkCtx | null)?.setSinkId?.(id)?.catch?.(() => {})
    this.progOut?.setSinkId?.(id).catch(() => {})
  }

  setMasterVolume(v: number) {
    this.masterVolume = v
    this.applyVolumes()
    this.emit()
  }

  channelLevel(ch: string): number { return this.chLevels.get(ch) ?? (this.isMusic(ch) ? 0.6 : 1) }

  setChannelLevel(ch: string, v: number) {
    this.chLevels.set(ch, Math.min(1, Math.max(0, v)))
    this.applyVolumes()
    this.emit()
  }

  /** Levels by channel, for persisting between sessions. */
  channelLevels(): Record<string, number> { return Object.fromEntries(this.chLevels) }

  /**
   * Playback volume = master x channel level. SFU: every remote track is one channel, so it is exact.
   * Mesh: a peer's single stream carries whatever they are talking on, so use the loudest knob among the
   * channels they are talking on that I'm listening to (a direct call to me always plays at full level).
   */
  private peerLevel(info: PeerInfo): number {
    if (info.talk.includes(`u:${this.myId}`)) return 1
    const levels = info.talk.filter(t => !isUser(t) && this.listen.has(t)).map(t => this.channelLevel(t))
    return levels.length ? Math.max(...levels) : 1
  }

  private applyVolumes() {
    const ctx = this.ctx
    if (ctx) {
      const t = ctx.currentTime
      for (const p of this.peers.values()) {
        if (!p.voice) continue
        p.voice.gain.gain.setTargetAtTime(this.masterVolume * this.peerLevel(p.info), t, 0.02)
        p.voice.pan.pan.setTargetAtTime(this.peerPan(p.info), t, 0.02)
      }
      for (const v of this.sfuVoices.values()) {
        v.gain.gain.setTargetAtTime(this.masterVolume * (v.ch ? this.channelLevel(v.ch) : 1), t, 0.02)
        v.pan.pan.setTargetAtTime(v.ch ? this.channelPan(v.ch) : 0, t, 0.02)
      }
    }
    if (this.progOut) this.progOut.volume = this.masterVolume
    this.applyMusicGain()
  }

  // ── spatial audio ──────────────────────────────────────────────────────────
  setSpatial(p: Partial<SpatialConfig>) {
    this.spatial = { ...this.spatial, ...p }
    this.applyVolumes()
    this.emit()
  }

  /** Stereo position −1 (left) … +1 (right) for a channel. */
  channelPan(ch: string): number {
    const { on, spread, overrides } = this.spatial
    if (!on) return 0
    const o = overrides[ch]
    if (typeof o === 'number') return Math.max(-1, Math.min(1, o))
    return this.autoPan(ch)
  }

  /** Default position: channels spread left→right in key order, within ±spread. */
  autoPan(ch: string): number {
    const ids = this.channels.filter(c => !c.music).map(c => c.id)
    const i = ids.indexOf(ch)
    if (i < 0 || ids.length < 2) return 0
    return -this.spatial.spread + 2 * this.spatial.spread * (i / (ids.length - 1))
  }

  /** Mesh: a peer's one stream sits where its loudest-knob active channel sits; direct calls are centred. */
  private peerPan(info: PeerInfo): number {
    if (info.talk.includes(`u:${this.myId}`)) return 0
    const chans = info.talk.filter(t => !isUser(t) && this.listen.has(t))
    if (!chans.length) return 0
    const best = chans.reduce((a, b) => (this.channelLevel(b) > this.channelLevel(a) ? b : a))
    return this.channelPan(best)
  }

  private ensureMix() {
    const ctx = this.ctx!
    if (this.mix) return
    this.mix = ctx.createGain()
    this.mix.connect(ctx.destination)
    const split = ctx.createChannelSplitter(2)
    this.mix.connect(split)
    const l = ctx.createAnalyser(); const r = ctx.createAnalyser()
    l.fftSize = r.fftSize = 512
    split.connect(l, 0); split.connect(r, 1)
    this.mixAn = [l, r]
  }

  private makeVoice(stream: MediaStream, ch = ''): Voice {
    const ctx = this.ctx!
    this.ensureMix()
    const hold = new Audio()
    hold.muted = true
    hold.srcObject = stream
    void hold.play().catch(() => {})
    const src = ctx.createMediaStreamSource(stream)
    // Voices are mono (Opus is upmixed to two identical channels). Fold to mono first, otherwise a hard pan
    // would sum both copies and play twice as loud; x1.414 makes a centred voice as loud as an unpanned one.
    const mono = ctx.createGain()
    mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers'
    mono.gain.value = Math.SQRT2
    const pan = ctx.createStereoPanner()
    const gain = ctx.createGain()
    gain.gain.value = 0 // applyVolumes() raises it; avoids a click on first packets
    src.connect(mono).connect(pan).connect(gain).connect(this.mix!)
    return { src, mono, pan, gain, hold, ch }
  }

  private dropVoice(v: Voice) {
    v.src.disconnect(); v.mono.disconnect(); v.pan.disconnect(); v.gain.disconnect()
    v.hold.srcObject = null
  }

  /** Left/right peak of everything being played to the headset, 0..1 (for meters and tests). */
  outLevels(): [number, number] {
    if (!this.mixAn) return [0, 0]
    return this.mixAn.map(an => {
      an.getFloatTimeDomainData(this.mixBuf)
      let peak = 0
      for (const v of this.mixBuf) { const a = Math.abs(v); if (a > peak) peak = a }
      return peak
    }) as [number, number]
  }

  setMicVolume(v: number) {
    this.micVolume = v
    this.micGain?.gain.setTargetAtTime(v, this.ctx?.currentTime ?? 0, 0.01)
    this.emit()
  }

  /** RMS level 0..1 of the (post-gain) microphone, for a meter. */
  micLevel(): number {
    if (!this.analyser || !this.meterBuf) return 0
    this.analyser.getFloatTimeDomainData(this.meterBuf)
    let sum = 0
    for (const s of this.meterBuf) sum += s * s
    return Math.min(1, Math.sqrt(sum / this.meterBuf.length) * 3)
  }

  // ── signaling socket ───────────────────────────────────────────────────────
  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private openSocket() {
    const o = this.opts!
    let ws: WebSocket
    try { ws = new WebSocket(o.url) } catch (e) { return this.fatal(`Bad server URL: ${(e as Error).message}`) }
    this.ws = ws
    ws.onopen = () => this.send(o.auth === 'accounts'
      ? (o.token ? { type: 'join', token: o.token } : { type: 'join', username: o.username, password: o.password, ...(o.gateway ? { gateway: true, name: o.name } : {}) })
      : { type: 'join', name: o.name, group: o.group, pin: o.pin })
    ws.onmessage = ev => {
      try { this.onMessage(JSON.parse(ev.data as string)) } catch (e) { console.error('[comms] bad message', e) }
    }
    ws.onclose = ev => {
      if (this.ws !== ws) return
      this.teardownSession()
      if (this.stopped) return
      if (ev.reason === 'bad-pin' || ev.reason === 'bad-name' || ev.reason === 'full') return // fatal() already ran
      this.status = 'reconnecting'
      this.emit()
      this.reconnectTimer = setTimeout(() => { if (!this.stopped) this.openSocket() }, 1500)
    }
  }

  private onMessage(m: any) {
    switch (m.type) {
      case 'welcome': {
        this.myId = m.id
        if (m.session) { this.sessionToken = m.session; if (this.opts) this.opts.token = m.session } // renewed at every join
        this.channels = m.channels
        this.groups = m.groups ?? []
        this.myName = m.me.name
        this.streams = m.streams ?? []
        this.setMusicSenders(m.musicSenders)
        if (m.musicKey) this.musicKey = m.musicKey
        this.myTitle = m.me.title ?? ''
        this.isAdmin = !!m.me.admin
        this.ice = m.iceServers
        // Listen to everything the role may access except channels I muted before.
        this.listen = new Set((m.listen as string[]).filter(id => !this.wantMuted.has(id)))
        this.status = 'connected'
        // Re-assert state after a reconnect: latched talk survives, held doesn't.
        this.held.clear()
        this.pushState()
        this.media = m.media === 'sfu' ? 'sfu' : 'mesh'
        if (this.opts?.gateway && this.media !== 'sfu') {
          this.fatal('Gateway needs the server in SFU media mode (each channel must be its own track)')
          break
        }
        if (this.media === 'sfu') {
          for (const info of m.peers as PeerInfo[]) this.pendingInfo.set(info.id, info)
          void this.connectSfu(m.livekit)
        } else {
          for (const info of m.peers as PeerInfo[]) this.createPeer(info, true)
        }
        const url = this.opts?.programUrl?.trim() || m.program?.whepUrl
        this.program = url && !this.opts?.gateway ? { name: m.program?.name ?? 'PGM', url } : null
        if (this.program && !this.progWanted) this.startProgram()
        this.updateDuck()
        this.statsTimer = setInterval(() => this.pollStats(), 2000)
        this.pingTimer = setInterval(() => this.send({ type: 'ping', t: performance.now() }), 3000)
        this.emit()
        break
      }
      case 'error':
        this.errorCode = m.code ?? ''
        this.fatal(m.message)
        break
      case 'peer-join':
        // The newcomer sends us an offer; we just track presence until it does.
        this.pendingInfo.set(m.peer.id, m.peer)
        this.emit()
        break
      case 'peer-leave':
        this.pendingInfo.delete(m.id)
        this.dropPeer(m.id)
        this.emit()
        break
      case 'groups':
        this.groups = m.groups ?? []
        this.emit()
        break
      case 'directory': {
        // An admin changed this user's channels/permissions: adopt the server's view.
        this.channels = m.channels
        this.listen = new Set(m.listen as string[])
        this.setMusicSenders(m.musicSenders)
        for (const ch of [...this.musicTx.keys()]) {
          const c = this.channels.find(x => x.id === ch)
          if (!(c?.music || c?.withMusic) || !c.canMusic) this.stopMusic(ch, false) // no longer allowed to start music here
        }
        for (const set of [this.held, this.latched]) {
          for (const t of [...set]) if (!isUser(t) && !this.channels.find(c => c.id === t)?.canTalk) set.delete(t)
        }
        this.applyRouting()
        if (this.media === 'sfu') void this.syncSfuTracks()
        this.emit()
        break
      }
      case 'peer-update': {
        const info = this.peers.get(m.id)?.info ?? this.pendingInfo.get(m.id)
        if (info) { info.name = m.name; info.role = m.role }
        this.emit()
        break
      }
      case 'music':
        this.markMusicSender(m.channel, m.id, m.name, !!m.on)
        this.emit()
        break
      case 'streams':
        this.streams = m.streams
        this.emit()
        break
      case 'alert':
        this.onAlert(m)
        break
      case 'peer-state': {
        const p = this.peers.get(m.id)
        const info = p?.info ?? this.pendingInfo.get(m.id)
        if (info) { info.talk = m.talk; info.listen = m.listen }
        this.applyRouting()
        this.emit()
        break
      }
      case 'signal':
        void this.onSignal(m.from, m.data)
        break
      case 'call':
        this.onCall(m.from, m.channel)
        break
      case 'pong':
        this.serverRttMs = Math.round(performance.now() - m.t)
        this.emit()
        break
    }
  }

  /** Presence for peers that have joined but whose offer hasn't arrived yet. */
  pendingInfo = new Map<string, PeerInfo>()

  /** All known remote participants, connected or not. */
  roster(): PeerInfo[] {
    const out = new Map<string, PeerInfo>(this.pendingInfo)
    for (const [id, p] of this.peers) out.set(id, p.info)
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // ── WebRTC mesh ────────────────────────────────────────────────────────────
  private createPeer(info: PeerInfo, initiator: boolean): Peer {
    const ctx = this.ctx!
    this.pendingInfo.delete(info.id)
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' })
    const gain = ctx.createGain()
    gain.gain.value = 0
    const dest = ctx.createMediaStreamDestination()
    this.micGain!.connect(gain)
    gain.connect(dest)
    pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream)

    const peer: Peer = { info, pc, gain, dest, voice: null, initiator, rttMs: null, connState: pc.connectionState }
    this.peers.set(info.id, peer)

    pc.ontrack = e => {
      if (peer.voice) this.dropVoice(peer.voice)
      peer.voice = this.makeVoice(e.streams[0] ?? new MediaStream([e.track]))
      this.applyVolumes()
      // Keep the receive jitter buffer tight; SRT-style tuning knob for WebRTC.
      try { (e.receiver as any).jitterBufferTarget = 40 } catch { /* older Chromium */ }
    }
    pc.onicecandidate = e => {
      if (e.candidate) this.send({ type: 'signal', to: info.id, data: { candidate: e.candidate.toJSON() } })
    }
    pc.onconnectionstatechange = () => {
      peer.connState = pc.connectionState
      if (pc.connectionState === 'failed' && this.peers.get(info.id) === peer) {
        // Rebuild the link; only the original initiator re-offers so we never glare.
        const i = peer.info
        this.dropPeer(info.id)
        if (peer.initiator) this.createPeer(i, true)
        else this.pendingInfo.set(i.id, i)
      }
      this.emit()
    }

    if (initiator) void this.makeOffer(peer)
    this.applyRouting()
    return peer
  }

  private async makeOffer(p: Peer) {
    const offer = await p.pc.createOffer()
    await p.pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp ?? '') })
    this.send({ type: 'signal', to: p.info.id, data: { sdp: p.pc.localDescription } })
  }

  private async onSignal(from: string, data: any) {
    let peer = this.peers.get(from)
    try {
      if (data.sdp?.type === 'offer') {
        const info = this.pendingInfo.get(from) ?? { id: from, name: '…', role: '', talk: [], listen: [] }
        if (peer) { this.dropPeer(from) }
        peer = this.createPeer(info, false)
        await peer.pc.setRemoteDescription(data.sdp)
        const answer = await peer.pc.createAnswer()
        await peer.pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp ?? '') })
        this.send({ type: 'signal', to: from, data: { sdp: peer.pc.localDescription } })
      } else if (data.sdp?.type === 'answer' && peer) {
        await peer.pc.setRemoteDescription(data.sdp)
      } else if (data.candidate && peer) {
        await peer.pc.addIceCandidate(data.candidate)
      }
    } catch (e) {
      console.warn('[comms] signal error', e)
    }
  }

  private dropPeer(id: string) {
    const p = this.peers.get(id)
    if (!p) return
    this.peers.delete(id)
    p.pc.onconnectionstatechange = null
    p.pc.close()
    p.gain.disconnect()
    if (p.voice) this.dropVoice(p.voice)
  }

  private async pollStats() {
    for (const p of this.peers.values()) {
      try {
        const stats = await p.pc.getStats()
        stats.forEach(r => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime != null) {
            p.rttMs = Math.round(r.currentRoundTripTime * 1000)
          }
        })
      } catch { /* peer closed mid-poll */ }
    }
    await this.checkProgramStall()
    this.emit()
  }

  // ── SFU transport (LiveKit) ────────────────────────────────────────────────
  // One published audio track per channel (gain 0 unless I'm talking on it) plus
  // a `direct` track. The comms server decides which of them each listener is
  // subscribed to, so channel privacy is enforced server-side.
  private async connectSfu(lk: { url: string; token: string }) {
    const ctx = this.ctx
    if (!ctx || !this.micGain) return
    await this.closeSfu()
    const room = new Room({ adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: false })
    this.room = room
    room.on(RoomEvent.TrackSubscribed, (track, pub) => {
      if (track.kind !== Track.Kind.Audio) return
      if (this.opts?.gateway) {
        // Route into the channel's receive bus (mixing everyone talking there); direct calls are ignored.
        if (!pub.trackName.startsWith('ch:') || !track.sid) return
        const ms = new MediaStream([track.mediaStreamTrack])
        const hold = new Audio() // Chromium only feeds remote WebRTC audio to WebAudio if an element holds it
        hold.muted = true
        hold.srcObject = ms
        void hold.play().catch(() => {})
        const src = ctx.createMediaStreamSource(ms)
        src.connect(this.channelRx(pub.trackName.slice(3)))
        this.gwSrc.set(track.sid, { src, hold })
        return
      }
      if (pub.trackName.startsWith('music:')) { this.attachMusic(pub.trackName.slice(6), track); return }
      const sid = track.sid ?? String(this.sfuVoices.size)
      const ch = pub.trackName.startsWith('ch:') ? pub.trackName.slice(3) : ''
      this.sfuVoices.get(sid) && this.dropVoice(this.sfuVoices.get(sid)!)
      this.sfuVoices.set(sid, this.makeVoice(new MediaStream([track.mediaStreamTrack]), ch))
      this.applyVolumes()
      const rx = (track as RemoteAudioTrack).receiver as (RTCRtpReceiver & { jitterBufferTarget?: number }) | undefined
      if (rx) try { rx.jitterBufferTarget = 40 } catch { /* older Chromium */ }
    })
    room.on(RoomEvent.TrackUnsubscribed, track => {
      const g = track.sid ? this.gwSrc.get(track.sid) : undefined
      if (g) { g.src.disconnect(); g.hold.srcObject = null; this.gwSrc.delete(track.sid!); return }
      const mu = track.sid ? this.musicRx.get(track.sid) : undefined
      if (mu) { mu.src.disconnect(); mu.hold.srcObject = null; this.musicRx.delete(track.sid!); return }
      const v = track.sid ? this.sfuVoices.get(track.sid) : undefined
      if (v) { this.dropVoice(v); this.sfuVoices.delete(track.sid!) }
    })
    room.on(RoomEvent.Disconnected, () => {
      // Unexpected media loss: force a full re-join (fresh identity + token).
      if (this.room === room && !this.stopped) this.ws?.close()
    })
    try {
      await room.connect(lk.url, lk.token, { autoSubscribe: false })
      if (this.room !== room) return
      await this.syncSfuTracks()
      if (this.room !== room) return
      for (const ch of [...this.musicTx.keys()]) {
        // The server forgot my music state with the old session: publish again and re-announce.
        this.musicPubs.delete(ch)
        await this.publishMusic(ch)
        this.send({ type: 'music', channel: ch, on: true })
      }
      this.emit()
    } catch (e) {
      if (this.room === room) this.fatal(`Media server unavailable: ${(e as Error).message}`)
    }
  }

  /** Publish a track for every channel I may talk on (plus `direct`); retire the rest. Serialised. */
  private syncSfuTracks(): Promise<void> {
    this.sfuSync = this.sfuSync.then(async () => {
      const room = this.room
      const ctx = this.ctx
      if (!room || !ctx || !this.micGain || room.state !== 'connected') return
      const want = new Set(['direct', ...this.channels.filter(c => c.canTalk && !c.music).map(c => `ch:${c.id}`)])
      for (const [name, gain] of [...this.sfuGains]) {
        if (want.has(name)) continue
        const pub = this.sfuPubs.get(name)
        if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, false).catch(() => {})
        gain.disconnect()
        this.sfuGains.delete(name)
        this.sfuPubs.delete(name)
      }
      for (const name of want) {
        if (this.sfuGains.has(name)) continue
        const gain = ctx.createGain()
        gain.gain.value = 0
        const dest = ctx.createMediaStreamDestination()
        if (!this.opts?.gateway) this.micGain.connect(gain)
        else if (name !== 'direct') this.channelTx(name.slice(3)).connect(gain)
        gain.connect(dest)
        this.sfuGains.set(name, gain)
        this.sfuPubs.set(name, await room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0], {
          name, source: Track.Source.Unknown, dtx: true, red: false,
          audioPreset: { maxBitrate: 32_000 },
        }))
      }
      if (this.room !== room) return
      this.send({ type: 'tracks' })
      this.applyRouting()
    }).catch(e => console.warn('[comms] track sync failed', e))
    return this.sfuSync
  }

  private async closeSfu() {
    const room = this.room
    this.room = null
    for (const g of this.sfuGains.values()) g.disconnect()
    this.sfuGains.clear()
    this.sfuPubs.clear()
    for (const g of this.gwSrc.values()) { g.src.disconnect(); g.hold.srcObject = null }
    this.gwSrc.clear()
    this.sfuVoices.forEach(v => this.dropVoice(v))
    this.sfuVoices.clear()
    for (const mu of this.musicRx.values()) { mu.src.disconnect(); mu.hold.srcObject = null }
    this.musicRx.clear()
    this.musicPubs.clear()
    await room?.disconnect().catch(() => {})
  }

  /** True when audio to/from this participant is flowing (SFU: everyone shares one link). */
  peerLinked(id: string): boolean {
    if (this.media === 'sfu') return this.room?.state === 'connected'
    return this.peers.get(id)?.connState === 'connected'
  }

  peerRtt(id: string): number | null { return this.peers.get(id)?.rttMs ?? null }

  // ── routing ────────────────────────────────────────────────────────────────
  private applyRouting() {
    if (!this.ctx) return
    this.syncMic()
    this.updateDuck()
    this.applyVolumes()
    const talk = this.talkSet
    if (this.media === 'sfu') {
      const t = this.ctx.currentTime
      for (const [name, g] of this.sfuGains) {
        const on = name === 'direct' ? [...talk].some(isUser) : talk.has(name.slice(3))
        g.gain.setTargetAtTime(on ? 1 : 0, t, 0.008)
      }
      return
    }
    for (const p of this.peers.values()) {
      let on = talk.has(`u:${p.info.id}`)
      if (!on) for (const t of talk) if (!isUser(t) && p.info.listen.includes(t)) { on = true; break }
      p.gain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.008)
    }
  }

  private pushState() {
    this.applyRouting()
    this.send({ type: 'state', talk: [...this.talkSet], listen: [...this.listen] })
  }

  // ── music channels ─────────────────────────────────────────────────────────
  // A music channel (admin: Channels, "Music channel") carries stereo music from whoever may talk on it to
  // everyone who may listen. Each is its own published track `music:<channel>`: 128 kbps stereo Opus with DTX
  // off (music must not be gated like speech). Received with the channel's own level knob and listen switch,
  // and ducked by IFB like the program feed.
  /** A music-only channel (no talking). */
  isMusic(ch: string): boolean { return !!this.channels.find(c => c.id === ch)?.music }

  /** A channel that can carry music: music-only, or a party line that also plays music (e.g. Program). */
  hasMusic(ch: string): boolean { const c = this.channels.find(x => x.id === ch); return !!(c?.music || c?.withMusic) }

  private setMusicSenders(list: { channel: string; id: string; name: string }[] | undefined) {
    this.musicSenders = new Map()
    for (const x of list ?? []) this.markMusicSender(x.channel, x.id, x.name, true)
  }

  private markMusicSender(ch: string, id: string, name: string, on: boolean) {
    let who = this.musicSenders.get(ch)
    if (!who) { who = new Map(); this.musicSenders.set(ch, who) }
    if (on) who.set(id, name); else who.delete(id)
    if (!who.size) this.musicSenders.delete(ch)
  }

  /** Names of everyone sending on this music channel right now. */
  musicSendersOn(ch: string): string[] { return [...(this.musicSenders.get(ch)?.values() ?? [])] }

  musicSending(ch: string): boolean { return this.musicTx.has(ch) }

  private attachMusic(ch: string, track: { sid?: string; mediaStreamTrack: MediaStreamTrack }) {
    const ctx = this.ctx
    if (!ctx || !track.sid) return
    this.ensureMix()
    let gain = this.musicRxGain.get(ch)
    if (!gain) {
      gain = ctx.createGain()
      gain.gain.value = 0
      gain.connect(this.mix!)
      this.musicRxGain.set(ch, gain)
    }
    const stream = new MediaStream([track.mediaStreamTrack])
    const hold = new Audio() // Chromium only feeds remote WebRTC audio to WebAudio if an element holds it
    hold.muted = true
    hold.srcObject = stream
    void hold.play().catch(() => {})
    const src = ctx.createMediaStreamSource(stream)
    src.connect(gain)
    this.musicRx.set(track.sid, { ch, src, hold })
    this.applyMusicGain()
  }

  private applyMusicGain() {
    const ctx = this.ctx
    if (!ctx) return
    for (const [ch, gain] of this.musicRxGain) {
      const c = this.channels.find(x => x.id === ch)
      // Music ducks under IFB talkers unless the channel opts out, to its own depth if set (else the IFB's).
      const ducking = this.ducked && !c?.noDuck
      const target = this.listen.has(ch) ? this.channelLevel(ch) * this.masterVolume * (ducking ? (c?.duck ?? this.duckLevel) : 1) : 0
      gain.gain.setTargetAtTime(target, ctx.currentTime, ducking ? 0.03 : 0.2)
    }
  }

  async startMusic(ch: string, source: MusicSource) {
    const ctx = this.ctx
    const c = this.channels.find(x => x.id === ch)
    if (!(c?.music || c?.withMusic) || !c.canMusic || !ctx || this.opts?.gateway) return
    this.stopMusic(ch, false)
    this.musicError = ''
    let stream: MediaStream | null = null
    let el: HTMLAudioElement | null = null
    let src: AudioNode
    try {
      if (source.kind === 'stream') {
        // The channel's stream URL, relayed by the server (same origin: no CORS trouble, URL never reaches the browser).
        el = new Audio()
        el.crossOrigin = 'anonymous'
        el.src = `${httpBase(this.opts!.url)}/music/${encodeURIComponent(ch)}?k=${encodeURIComponent(this.musicKey)}`
        await el.play() // allowed: this runs from the START click
        src = ctx.createMediaElementSource(el)
      } else if (source.kind === 'display') {
        const shared = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        } as DisplayMediaStreamOptions)
        shared.getVideoTracks().forEach(t => { t.stop(); shared.removeTrack(t) }) // only the audio is wanted
        stream = shared
        if (!shared.getAudioTracks().length) throw new Error('No audio was shared. Choose a tab or screen and tick "Share audio".')
        src = ctx.createMediaStreamSource(shared)
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: source.deviceId ? { exact: source.deviceId } : undefined,
            echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000,
          },
        })
        src = ctx.createMediaStreamSource(stream)
      }
    } catch (e) {
      stream?.getTracks().forEach(t => t.stop())
      if (el) { el.pause(); el.removeAttribute('src'); el.load() }
      const err = e as Error
      let why = err.name === 'NotAllowedError' ? 'blocked by the browser' : 'is the stream URL live?'
      if (source.kind === 'stream' && err.name !== 'NotAllowedError') {
        // Ask the relay what is wrong so the key can say it plainly.
        try {
          const ac = new AbortController()
          const r = await fetch(`${httpBase(this.opts!.url)}/music/${encodeURIComponent(ch)}?k=${encodeURIComponent(this.musicKey)}`, { signal: ac.signal })
          ac.abort()
          if (r.status === 415) why = 'that link is a web page, not an audio stream'
          else if (r.status === 502) why = 'the server could not reach it'
          else if (r.status === 404) why = 'no stream is set for this channel'
        } catch { /* keep the generic hint */ }
      }
      this.musicError = source.kind === 'stream' ? `Could not play the channel stream (${why})` : err.message || 'Could not open the music source'
      this.emit()
      return
    }
    const gain = ctx.createGain()
    const dest = ctx.createMediaStreamDestination()
    dest.channelCount = 2
    dest.channelCountMode = 'explicit'
    const an = ctx.createAnalyser()
    an.fftSize = 1024
    src.connect(gain)
    gain.connect(dest)
    gain.connect(an)
    this.musicTx.set(ch, { stream, el, src, gain, dest, an, buf: new Float32Array(an.fftSize) })
    // Sharing stopped from the browser's own bar: switch the music off.
    stream?.getAudioTracks()[0]?.addEventListener('ended', () => { if (this.musicTx.get(ch)?.stream === stream) this.stopMusic(ch) })
    if (el) {
      const url = el.src
      // A file that finishes ends the music instead of leaving a silent key on air.
      el.addEventListener('ended', () => { if (this.musicTx.get(ch)?.el === el) { this.musicError = 'The stream ended'; this.stopMusic(ch) } })
      // A live stream that drops usually does not error, it just freezes. Watch the playback clock: when it stops
      // advancing, reconnect to the stream; give up (and say so) after a few failed attempts.
      let last = el.currentTime
      let frozen = 0
      let attempts = 0
      const tx = this.musicTx.get(ch)!
      tx.watch = setInterval(() => {
        if (this.musicTx.get(ch)?.el !== el) return
        if (el.currentTime > last + 0.2) { last = el.currentTime; frozen = 0; attempts = 0; return }
        frozen += 2
        if (frozen < 6 && !el.error) return
        frozen = 0
        if (++attempts > 4) { this.musicError = 'The stream stopped (connection lost)'; this.stopMusic(ch); return }
        el.src = url // ask the server for the stream again
        void el.play().catch(() => {})
      }, 2000)
    }
    await this.publishMusic(ch)
    this.send({ type: 'music', channel: ch, on: true })
    this.emit()
  }

  private async publishMusic(ch: string) {
    const room = this.room
    const tx = this.musicTx.get(ch)
    if (!room || room.state !== 'connected' || !tx) return
    try {
      // LiveKit stops local tracks when its connection closes, so after a reconnect the old output
      // track is dead: feed a fresh one from the same source.
      if (tx.dest.stream.getAudioTracks()[0]?.readyState === 'ended' && this.ctx) {
        tx.gain.disconnect(tx.dest)
        tx.dest = this.ctx.createMediaStreamDestination()
        tx.dest.channelCount = 2
        tx.dest.channelCountMode = 'explicit'
        tx.gain.connect(tx.dest)
      }
      const old = this.musicPubs.get(ch)
      if (old?.track) await room.localParticipant.unpublishTrack(old.track, false).catch(() => {})
      this.musicPubs.set(ch, await room.localParticipant.publishTrack(tx.dest.stream.getAudioTracks()[0], {
        name: `music:${ch}`, source: Track.Source.Unknown, dtx: false, red: false, forceStereo: true,
        audioPreset: { maxBitrate: 128_000 },
      }))
      this.send({ type: 'tracks' })
    } catch (e) {
      this.musicError = `Could not publish the music: ${(e as Error).message}`
      this.stopMusic(ch)
    }
  }

  stopMusic(ch: string, notify = true) {
    const tx = this.musicTx.get(ch)
    this.musicTx.delete(ch)
    if (tx && notify) this.send({ type: 'music', channel: ch, on: false })
    if (tx) {
      tx.src.disconnect()
      tx.gain.disconnect()
      if (tx.watch) clearInterval(tx.watch)
      tx.stream?.getTracks().forEach(t => t.stop())
      if (tx.el) { tx.el.pause(); tx.el.removeAttribute('src'); tx.el.load() }
    }
    const pub = this.musicPubs.get(ch)
    this.musicPubs.delete(ch)
    if (pub?.track && this.room) void this.room.localParticipant.unpublishTrack(pub.track, false).catch(() => {})
    if (notify) this.emit()
  }

  stopAllMusic(notify = true) { for (const ch of [...this.musicTx.keys()]) this.stopMusic(ch, notify) }

  /** True while the browser is holding audio back until the user clicks (autoplay policy). */
  get audioBlocked(): boolean { return !!this.ctx && this.ctx.state === 'suspended' }

  resumeAudio() { if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {}) }

  /** RMS level 0..1 of the music I am sending on a channel, for a meter. */
  musicSendLevel(ch: string): number {
    const tx = this.musicTx.get(ch)
    if (!tx) return 0
    tx.an.getFloatTimeDomainData(tx.buf)
    let sum = 0
    for (const v of tx.buf) sum += v * v
    return Math.min(1, Math.sqrt(sum / tx.buf.length) * 2.5)
  }

  // ── program feed (WHEP) + IFB ducking ──────────────────────────────────────
  private ensureProgGraph() {
    const ctx = this.ctx!
    if (this.progGain) return
    this.progGain = ctx.createGain()
    this.progGain.gain.value = this.programMuted ? 0 : this.programVolume
    this.progAnalyser = ctx.createAnalyser()
    this.progAnalyser.fftSize = 512
    this.progBuf = new Float32Array(this.progAnalyser.fftSize)
    const dest = ctx.createMediaStreamDestination()
    this.progGain.connect(this.progAnalyser)
    this.progGain.connect(dest)
    // Played through an element so the headset can be chosen with setSinkId.
    this.progOut = new Audio() as SinkAudio
    this.progOut.srcObject = dest.stream
    this.progOut.volume = this.masterVolume
    if (this.spkId) this.progOut.setSinkId?.(this.spkId).catch(() => {})
    void this.progOut.play().catch(() => {})
  }

  /** Feed a program MediaStream into the ducked/metered output path. */
  attachProgramStream(stream: MediaStream) {
    this.ensureProgGraph()
    // Chromium only delivers remote WebRTC audio to WebAudio if an element holds the stream.
    this.progHold ??= new Audio()
    this.progHold.muted = true
    this.progHold.srcObject = stream
    void this.progHold.play().catch(() => {})
    this.progSrc?.disconnect()
    this.progSrc = this.ctx!.createMediaStreamSource(stream)
    this.progSrc.connect(this.progGain!)
    this.programState = 'live'
    this.programError = ''
    this.progPackets = -1
    this.progMovedAt = Date.now()
    this.emit()
  }

  private startProgram() {
    this.progWanted = true
    void this.connectProgram()
  }

  private async connectProgram() {
    const prog = this.program
    if (!prog || !this.ctx || this.progPc || !this.progWanted) return
    this.ensureProgGraph()
    this.programState = 'connecting'
    this.emit()
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    this.progPc = pc
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.ontrack = e => this.attachProgramStream(e.streams[0] ?? new MediaStream([e.track]))
    pc.onconnectionstatechange = () => {
      if (this.progPc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
        this.progFail('Program feed lost')
      }
    }
    try {
      await pc.setLocalDescription(await pc.createOffer())
      await new Promise<void>(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve()
        const t = setTimeout(resolve, 2000)
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve() }
        }
      })
      const r = await fetch(prog.url, {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription!.sdp,
      })
      if (this.progPc !== pc) return
      if (!r.ok) throw new Error(`WHEP ${r.status}${r.status === 404 ? ' (stream not live)' : ''}`)
      const loc = r.headers.get('Location')
      this.progLocation = loc ? new URL(loc, prog.url).toString() : null
      await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() })
    } catch (e) {
      if (this.progPc === pc) this.progFail((e as Error).message)
    }
  }

  /** ICE can take ~15 s to notice a dead feed; no audio packets for 5 s means it's gone. */
  private async checkProgramStall() {
    const pc = this.progPc
    if (!pc || this.programState !== 'live') return
    try {
      const stats = await pc.getStats()
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.packetsReceived !== this.progPackets) {
          this.progPackets = r.packetsReceived
          this.progMovedAt = Date.now()
        }
      })
    } catch { return }
    if (this.progPc === pc && Date.now() - this.progMovedAt > 5000) this.progFail('Program feed stalled')
  }

  private progFail(message: string) {
    this.closeProgPc()
    this.programState = 'error'
    this.programError = message
    this.emit()
    if (this.progWanted) {
      this.progRetry = setTimeout(() => { this.progRetry = null; void this.connectProgram() }, 3000)
    }
  }

  private closeProgPc() {
    const pc = this.progPc
    this.progPc = null
    if (pc) { pc.onconnectionstatechange = null; pc.close() }
    if (this.progLocation) {
      fetch(this.progLocation, { method: 'DELETE', keepalive: true }).catch(() => {})
      this.progLocation = null
    }
    this.progSrc?.disconnect()
    this.progSrc = null
    if (this.progHold) this.progHold.srcObject = null
  }

  stopProgram() {
    this.progWanted = false
    if (this.progRetry) clearTimeout(this.progRetry)
    this.progRetry = null
    if (this.duckTimer) clearTimeout(this.duckTimer)
    this.duckTimer = null
    this.ducked = false
    this.duckLevel = 1
    this.closeProgPc()
    this.programState = 'off'
    this.programError = ''
  }

  private applyProgramGain() {
    this.applyMusicGain()
    if (!this.progGain || !this.ctx) return
    const target = this.programMuted ? 0 : this.programVolume * (this.ducked ? this.duckLevel : 1)
    // Fast attack so the IFB cuts through immediately; slower release avoids pumping.
    this.progGain.gain.setTargetAtTime(target, this.ctx.currentTime, this.ducked ? 0.03 : 0.2)
  }

  /** Duck the program while anyone talks on an IFB channel I'm listening to. */
  private updateDuck() {
    let level = 1
    let want = false
    for (const p of this.roster()) {
      for (const t of p.talk) {
        const c = this.channels.find(x => x.id === t)
        if (c?.ifb && this.listen.has(c.id)) { want = true; level = Math.min(level, c.duck ?? 0.15) }
      }
    }
    if (want) {
      if (this.duckTimer) { clearTimeout(this.duckTimer); this.duckTimer = null }
      const changed = !this.ducked || this.duckLevel !== level
      this.ducked = true
      this.duckLevel = level
      if (changed) { this.applyProgramGain(); this.emit() }
    } else if (this.ducked && !this.duckTimer) {
      // 400 ms hold so program doesn't swell back between words.
      this.duckTimer = setTimeout(() => {
        this.duckTimer = null
        this.ducked = false
        this.duckLevel = 1
        this.applyProgramGain()
        this.emit()
      }, 400)
    }
  }

  setProgramVolume(v: number) { this.programVolume = v; this.applyProgramGain(); this.emit() }
  toggleProgramMute() { this.programMuted = !this.programMuted; this.applyProgramGain(); this.emit() }

  programLevel(): number {
    if (!this.progAnalyser || !this.progBuf) return 0
    this.progAnalyser.getFloatTimeDomainData(this.progBuf)
    let sum = 0
    for (const x of this.progBuf) sum += x * x
    return Math.min(1, Math.sqrt(sum / this.progBuf.length) * 3)
  }

  // ── user actions ───────────────────────────────────────────────────────────
  private mayTalk(target: string) {
    if (isUser(target)) return true
    const c = this.channels.find(x => x.id === target)
    return !!c?.canTalk && !c.music // music channels carry music, not talk
  }

  press(target: string) { if (!this.mayTalk(target)) return; this.held.add(target); this.pushState(); this.emit() }
  release(target: string) { this.held.delete(target); this.pushState(); this.emit() }
  releaseAll() { if (this.held.size) { this.held.clear(); this.pushState(); this.emit() } }

  toggleLatch(target: string) {
    if (!this.mayTalk(target)) return
    if (!this.latched.delete(target)) this.latched.add(target)
    this.pushState()
    this.emit()
  }

  setListen(ch: string, on: boolean) {
    if (on && !this.channels.find(c => c.id === ch)?.canListen) return
    if (on) this.listen.add(ch); else this.listen.delete(ch)
    this.pushState()
    this.emit()
  }

  callChannel(ch: string) { this.send({ type: 'call', channel: ch }) }

  /** The alert currently showing on a channel's key (they fade after 8 s). */
  activeAlert(ch: string): ArenaAlert | null {
    const a = this.alerts.get(ch)
    return a && Date.now() - a.at < 8000 ? a : null
  }

  private onAlert(m: { text: string; level: 'warn' | 'ok'; channel: string | null; stream: string | null }) {
    this.alerts.set(m.channel ?? '', { text: m.text, level: m.level, at: Date.now(), stream: m.stream })
    if (!this.opts?.gateway) {
      if (this.alertTones) this.alertTone(m.level)
      if (this.speakAlerts && typeof speechSynthesis !== 'undefined') {
        speechSynthesis.cancel() // never queue stale news behind fresh news
        const u = new SpeechSynthesisUtterance(m.text)
        u.volume = this.masterVolume
        speechSynthesis.speak(u)
      }
    }
    this.emit()
    setTimeout(() => this.emit(), 8100) // let the key stop flashing
  }

  /** Descending pair = something broke; ascending pair = it's back. */
  private alertTone(level: 'warn' | 'ok') {
    const ctx = this.ctx
    if (!ctx) return
    const notes = level === 'warn' ? [660, 440] : [440, 660]
    const t = ctx.currentTime
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator(); const g = ctx.createGain()
      osc.type = 'sine'; osc.frequency.value = f
      g.gain.setValueAtTime(0, t + i * 0.16)
      g.gain.linearRampToValueAtTime(0.18 * this.masterVolume, t + i * 0.16 + 0.01)
      g.gain.linearRampToValueAtTime(0, t + i * 0.16 + 0.14)
      osc.connect(g).connect(ctx.destination)
      osc.start(t + i * 0.16); osc.stop(t + i * 0.16 + 0.16)
    })
  }

  private onCall(from: string, channel: string) {
    this.calls.set(channel, { from, at: Date.now() })
    this.beep()
    this.emit()
    setTimeout(() => this.emit(), 4100) // let the flash expire
  }

  private beep() {
    const ctx = this.ctx
    if (!ctx || this.opts?.gateway) return // a gateway's destination is a multichannel interface, not speakers
    const t = ctx.currentTime
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.frequency.value = 880
      g.gain.setValueAtTime(0, t + i * 0.25)
      g.gain.linearRampToValueAtTime(0.2 * this.masterVolume, t + i * 0.25 + 0.01)
      g.gain.linearRampToValueAtTime(0, t + i * 0.25 + 0.15)
      osc.connect(g).connect(ctx.destination)
      osc.start(t + i * 0.25)
      osc.stop(t + i * 0.25 + 0.2)
    }
  }

  /** Who is currently talking on a channel (names), including me. */
  talkersOn(ch: string, myName: string): string[] {
    const out: string[] = []
    if (this.talkSet.has(ch)) out.push(`${myName} (you)`)
    for (const p of this.roster()) if (p.talk.includes(ch)) out.push(p.name)
    return out
  }
}
