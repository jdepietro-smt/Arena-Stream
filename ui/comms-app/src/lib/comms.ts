import { Room, RoomEvent, Track, RemoteAudioTrack } from 'livekit-client'

// Arena Comms engine: signaling socket + WebRTC audio mesh + talk/listen routing.
//
// Audio graph:   mic -> micGain -+-> analyser (meter)
//                                +-> peerGain[a] -> dest[a] -> RTCPeerConnection[a]
//                                +-> peerGain[b] -> dest[b] -> RTCPeerConnection[b]
// A peer's gain is 1 only while I'm talking on a channel that peer listens to
// (or talking directly to them), so nothing but silence is ever sent otherwise.

export interface Channel { id: string; name: string; color: string; ifb?: boolean; duck?: number }
export type MediaMode = 'mesh' | 'sfu'
export type ProgramState = 'off' | 'connecting' | 'live' | 'error'
export interface PeerInfo { id: string; name: string; role: string; talk: string[]; listen: string[] }
export type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface JoinOptions {
  url: string
  name: string
  role: string
  pin: string
  micId?: string
  echoCancel: boolean
  /** Overrides the server-provided program feed (WHEP URL). */
  programUrl?: string
}

interface Peer {
  info: PeerInfo
  pc: RTCPeerConnection
  gain: GainNode
  dest: MediaStreamAudioDestinationNode
  el: HTMLAudioElement
  initiator: boolean
  rttMs: number | null
  connState: RTCPeerConnectionState
}

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

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

export class CommsEngine {
  status: Status = 'idle'
  error = ''
  myId = ''
  channels: Channel[] = []
  roles: string[] = []
  listen = new Set<string>()
  held = new Set<string>()
  latched = new Set<string>()
  peers = new Map<string, Peer>()
  /** channel id -> {from, at} of the latest call signal */
  calls = new Map<string, { from: string; at: number }>()
  serverRttMs: number | null = null
  media: MediaMode = 'mesh'
  program: { name: string; url: string } | null = null
  programState: ProgramState = 'off'
  programError = ''
  programVolume = 0.8
  programMuted = false
  /** True while an IFB channel I listen to has a talker: program is ducked. */
  ducked = false
  masterVolume = 1
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
  private sfuEls = new Map<string, SinkAudio>()
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

  get talkSet(): Set<string> { return new Set([...this.held, ...this.latched]) }
  get me(): { id: string } { return { id: this.myId } }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async join(opts: JoinOptions, mutedChannels: string[] = []) {
    this.leave()
    this.opts = opts
    this.stopped = false
    this.wantMuted = new Set(mutedChannels)
    this.status = 'connecting'
    this.error = ''
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
    this.micStream?.getTracks().forEach(t => t.stop())
    this.micStream = null
    this.micSrc?.disconnect()
    this.micSrc = null
    this.ctx?.close().catch(() => {})
    this.ctx = null
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
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    await this.ctx.resume()
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
  }

  setSpeaker(id: string) {
    this.spkId = id
    for (const p of this.peers.values()) (p.el as SinkAudio).setSinkId?.(id).catch(() => {})
    this.progOut?.setSinkId?.(id).catch(() => {})
    this.sfuEls.forEach(e => e.setSinkId?.(id).catch(() => {}))
  }

  setMasterVolume(v: number) {
    this.masterVolume = v
    for (const p of this.peers.values()) p.el.volume = v
    if (this.progOut) this.progOut.volume = v
    this.sfuEls.forEach(e => { e.volume = v })
    this.emit()
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
    ws.onopen = () => this.send({ type: 'join', name: o.name, role: o.role, pin: o.pin })
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
        this.channels = m.channels
        this.roles = m.roles
        this.ice = m.iceServers
        // Listen to everything the role may access except channels I muted before.
        this.listen = new Set((m.listen as string[]).filter(id => !this.wantMuted.has(id)))
        this.status = 'connected'
        // Re-assert state after a reconnect: latched talk survives, held doesn't.
        this.held.clear()
        this.pushState()
        this.media = m.media === 'sfu' ? 'sfu' : 'mesh'
        if (this.media === 'sfu') {
          for (const info of m.peers as PeerInfo[]) this.pendingInfo.set(info.id, info)
          void this.connectSfu(m.livekit)
        } else {
          for (const info of m.peers as PeerInfo[]) this.createPeer(info, true)
        }
        const url = this.opts?.programUrl?.trim() || m.program?.whepUrl
        this.program = url ? { name: m.program?.name ?? 'PGM', url } : null
        if (this.program && !this.progWanted) this.startProgram()
        this.updateDuck()
        this.statsTimer = setInterval(() => this.pollStats(), 2000)
        this.pingTimer = setInterval(() => this.send({ type: 'ping', t: performance.now() }), 3000)
        this.emit()
        break
      }
      case 'error':
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

    const el = new Audio() as SinkAudio
    el.autoplay = true
    el.volume = this.masterVolume
    if (this.spkId) el.setSinkId?.(this.spkId).catch(() => {})

    const peer: Peer = { info, pc, gain, dest, el, initiator, rttMs: null, connState: pc.connectionState }
    this.peers.set(info.id, peer)

    pc.ontrack = e => {
      el.srcObject = e.streams[0] ?? new MediaStream([e.track])
      el.play().catch(() => {})
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
    p.el.srcObject = null
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
    room.on(RoomEvent.TrackSubscribed, track => {
      if (track.kind !== Track.Kind.Audio) return
      const el = track.attach() as SinkAudio
      el.volume = this.masterVolume
      if (this.spkId) el.setSinkId?.(this.spkId).catch(() => {})
      this.sfuEls.set(track.sid ?? String(this.sfuEls.size), el)
      const rx = (track as RemoteAudioTrack).receiver as (RTCRtpReceiver & { jitterBufferTarget?: number }) | undefined
      if (rx) try { rx.jitterBufferTarget = 40 } catch { /* older Chromium */ }
    })
    room.on(RoomEvent.TrackUnsubscribed, track => {
      track.detach().forEach(e => e.remove())
      if (track.sid) this.sfuEls.delete(track.sid)
    })
    room.on(RoomEvent.Disconnected, () => {
      // Unexpected media loss: force a full re-join (fresh identity + token).
      if (this.room === room && !this.stopped) this.ws?.close()
    })
    try {
      await room.connect(lk.url, lk.token, { autoSubscribe: false })
      if (this.room !== room) return
      const targets = [...this.channels.map(c => `ch:${c.id}`), 'direct']
      for (const name of targets) {
        const gain = ctx.createGain()
        gain.gain.value = 0
        const dest = ctx.createMediaStreamDestination()
        this.micGain.connect(gain)
        gain.connect(dest)
        this.sfuGains.set(name, gain)
        await room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0], {
          name, source: Track.Source.Unknown, dtx: true, red: false,
          audioPreset: { maxBitrate: 32_000 },
        })
      }
      if (this.room !== room) return
      this.send({ type: 'tracks' })
      this.applyRouting()
      this.emit()
    } catch (e) {
      if (this.room === room) this.fatal(`Media server unavailable: ${(e as Error).message}`)
    }
  }

  private async closeSfu() {
    const room = this.room
    this.room = null
    for (const g of this.sfuGains.values()) g.disconnect()
    this.sfuGains.clear()
    this.sfuEls.forEach(e => e.remove())
    this.sfuEls.clear()
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
    this.updateDuck()
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
  press(target: string) { this.held.add(target); this.pushState(); this.emit() }
  release(target: string) { this.held.delete(target); this.pushState(); this.emit() }
  releaseAll() { if (this.held.size) { this.held.clear(); this.pushState(); this.emit() } }

  toggleLatch(target: string) {
    if (!this.latched.delete(target)) this.latched.add(target)
    this.pushState()
    this.emit()
  }

  setListen(ch: string, on: boolean) {
    if (on) this.listen.add(ch); else this.listen.delete(ch)
    this.pushState()
    this.emit()
  }

  callChannel(ch: string) { this.send({ type: 'call', channel: ch }) }

  private onCall(from: string, channel: string) {
    this.calls.set(channel, { from, at: Date.now() })
    this.beep()
    this.emit()
    setTimeout(() => this.emit(), 4100) // let the flash expire
  }

  private beep() {
    const ctx = this.ctx
    if (!ctx) return
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
