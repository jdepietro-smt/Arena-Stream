'use strict'
// Renderer: sign-in, signaling, and the WebRTC host/viewer. Privileged work (keys, capture choice,
// input injection) is delegated to the main process through window.arena.

const $ = id => document.getElementById(id)
const show = (el, on) => { el.hidden = !on }
const hostAuthMessage = nonce => `arena-remote-host-auth|${nonce}`
const FPS = 60

let base = '', token = '', userName = '', ice = []

// ---------- helpers ----------
const wsUrl = path => base.replace(/^http/, 'ws') + path
const isLan = h => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|.*\.local$)/.test(h)

async function post(path, body, auth) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j
}

/** WebSocket with a message queue so callers can await specific replies. */
function signaling(path, onMessage, onClose) {
  const ws = new WebSocket(wsUrl(path))
  ws.onmessage = e => onMessage(JSON.parse(e.data))
  ws.onclose = () => onClose?.()
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Cannot reach the server')) })
  return { ws, opened, send: m => ws.readyState === 1 && ws.send(JSON.stringify(m)) }
}

function ask(text, buttons, withInput = false) {
  return new Promise(res => {
    $('modalText').textContent = text
    $('modalInput').value = ''
    show($('modalInput'), withInput)
    const box = $('modalBtns')
    box.replaceChildren(...buttons.map(([label, value, cls]) => {
      const b = document.createElement('button')
      b.textContent = label
      if (cls) b.className = cls
      b.onclick = () => { show($('modal'), false); res(withInput && value === true ? $('modalInput').value : value) }
      return b
    }))
    show($('modal'), true)
  })
}

/** The single DTLS fingerprint in an SDP, or null if absent or ambiguous. */
function fingerprint(sdp) {
  const all = new Set([...sdp.matchAll(/^a=fingerprint:(\S+ \S+)/gm)].map(m => m[1].toLowerCase()))
  return all.size === 1 ? [...all][0] : null
}

function preferCodecs(transceiver, kind, order) {
  const caps = RTCRtpReceiver.getCapabilities(kind)?.codecs ?? []
  const rank = c => { const i = order.findIndex(o => c.mimeType.toLowerCase() === o); return i < 0 ? order.length : i }
  transceiver.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)))
}
const VIDEO_ORDER = ['video/h264', 'video/vp9', 'video/vp8']
const CRLF = String.fromCharCode(13, 10)

/**
 * Tells the remote encoder to start high instead of probing up from ~300 kbps, which would otherwise take
 * several seconds of blurry low-resolution video. Applied to the offer; the sender reads it from there.
 */
function withBitrateHints(sdp, startMbps, maxMbps) {
  const hint = `x-google-start-bitrate=${startMbps * 1000};x-google-min-bitrate=${Math.round(startMbps * 500)};x-google-max-bitrate=${maxMbps * 1000}`
  const lines = sdp.split(CRLF), out = []
  const section = l => l.startsWith('m=') && l.startsWith('m=video')
  const pts = new Set(), withFmtp = new Set()
  let inVideo = false
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = section(l)
    const m = inVideo && l.match(/^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//)
    if (m) pts.add(m[1])
    const f = inVideo && l.match(/^a=fmtp:(\d+) /)
    if (f) withFmtp.add(f[1])
  }
  inVideo = false
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = section(l)
    const f = inVideo && l.match(/^a=fmtp:(\d+) /)
    out.push(f && pts.has(f[1]) ? `${l};${hint}` : l)
    const m = inVideo && l.match(/^a=rtpmap:(\d+) /)
    if (m && pts.has(m[1]) && !withFmtp.has(m[1])) out.push(`a=fmtp:${m[1]} ${hint}`)
  }
  return out.join(CRLF)
}

// ---------- sign in ----------
$('signin').onclick = async () => {
  $('loginErr').textContent = ''
  try {
    const u = new URL($('server').value.trim())
    if (u.protocol === 'http:' && !isLan(u.hostname)) throw new Error('Use https:// for servers outside your local network')
    base = u.origin
    const r = await post('/api/login', { username: $('user').value, password: $('pass').value })
    token = r.token; userName = r.user
    $('pass').value = ''
    show($('login'), false); show($('app'), true)
    $('who').textContent = userName
    startViewerList()
    initHostPane()
  } catch (e) { $('loginErr').textContent = e.message }
}
for (const id of ['user', 'pass', 'server']) $(id).onkeydown = e => { if (e.key === 'Enter') $('signin').click() }

$('tabViewer').onclick = () => tab('viewer')
$('tabHost').onclick = () => tab('host')
function tab(t) {
  show($('viewerPane'), t === 'viewer'); show($('hostPane'), t === 'host')
  $('tabViewer').classList.toggle('on', t === 'viewer'); $('tabHost').classList.toggle('on', t === 'host')
}

// =====================================================================
// VIEWER
// =====================================================================
let listConn = null, listTimer = null
function startViewerList() {
  listConn = signaling('/viewer', m => {
    if (m.t === 'ready') { ice = m.ice; refreshList(); listTimer = setInterval(refreshList, 5000) }
    if (m.t === 'hosts') renderHosts(m.hosts)
  }, () => { clearInterval(listTimer); $('viewerMsg').textContent = 'Disconnected from server.' })
  listConn.opened.then(() => listConn.send({ t: 'auth', token })).catch(e => { $('viewerMsg').textContent = e.message })
}
const refreshList = () => listConn.send({ t: 'list' })

function renderHosts(hosts) {
  $('viewerMsg').textContent = hosts.length ? '' : 'No computers yet. Open "Share this computer" on the machine you want to reach and register it.'
  $('hosts').replaceChildren(...hosts.map(h => {
    const b = document.createElement('button')
    b.className = 'tile' + (h.online ? '' : ' off')
    b.textContent = `${h.name} — ${h.online ? 'online' : 'offline'}`
    if (h.online) b.onclick = () => connectTo(h)
    return b
  }))
}

let view = null // active viewer session

async function connectTo(h) {
  if (view) return
  const pin = await arena.pin.status(h.id, h.pubKey)
  if (pin.status === 'invalid') return ask('The server returned a key that does not match this computer. Not connecting.', [['OK', 1]])
  if (pin.status === 'changed') {
    const go = await ask(`WARNING: the identity of "${h.name}" has CHANGED since you last connected. This could mean someone is impersonating it. Do not continue unless the owner re-registered it.`, [['Cancel', false], ['Trust new identity', true, 'danger']])
    if (!go) return
    await arena.pin.accept(h.id, h.pubKey)
  } else if (pin.status === 'new') {
    const go = await ask(`First time connecting to "${h.name}". Check that its Computer ID is ${pin.readable}. Trust it?`, [['Cancel', false], ['Trust and connect', true]])
    if (!go) return
    await arena.pin.accept(h.id, h.pubKey)
  }
  openStage(h)
}

function openStage(h) {
  show($('stage'), true); show($('app'), false)
  $('stageName').textContent = h.name
  $('stageMsg').textContent = 'Waiting for the other computer to accept…'
  const v = view = { h, pc: null, conn: null, sessionId: null, ctl: null, fast: null, closed: false, statsTimer: null, locked: false, pendingMove: null, ready: false }

  v.conn = signaling('/viewer', async m => {
    if (m.t === 'ready') return v.conn.send({ t: 'connect', hostId: h.id })
    if (m.t === 'session') { v.sessionId = m.sessionId; return startPeer(v) }
    if (m.t === 'signal') return onViewerSignal(v, m.data)
    if (m.t === 'ended') return leave(v, m.reason === 'denied' ? 'The other computer declined the connection.' : 'Session ended.')
    if (m.t === 'error') return leave(v, 'That computer is not available.')
  }, () => leave(v, 'Lost connection to the server.'))
  v.conn.opened.then(() => v.conn.send({ t: 'auth', token })).catch(e => leave(v, e.message))
}

async function startPeer(v) {
  const pc = v.pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' })
  const vt = pc.addTransceiver('video', { direction: 'recvonly' })
  preferCodecs(vt, 'video', VIDEO_ORDER)
  pc.addTransceiver('audio', { direction: 'recvonly' })
  v.ctl = pc.createDataChannel('ctl', { ordered: true })
  v.fast = pc.createDataChannel('in', { ordered: false, maxRetransmits: 0 })
  v.ctl.onmessage = e => onViewerCtl(v, JSON.parse(e.data))
  pc.onicecandidate = e => e.candidate && v.conn.send({ t: 'signal', sessionId: v.sessionId, data: { type: 'ice', candidate: e.candidate } })
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) leave(v, 'Connection lost.') }
  pc.ontrack = e => {
    // Minimum playout buffering: favour latency over smoothing-by-delay; the encoder keeps frames evenly paced.
    try { e.receiver.jitterBufferTarget = 0 } catch {}
    try { e.receiver.playoutDelayHint = 0 } catch {}
    if (e.track.kind === 'video') {
      $('video').srcObject = e.streams[0]
      $('stageMsg').textContent = ''
      v.statsTimer ??= setInterval(() => updateStats(v), 1000)
    }
  }
  const offer = await pc.createOffer()
  offer.sdp = withBitrateHints(offer.sdp, 15, 60)
  await pc.setLocalDescription(offer)
  v.offerSdp = offer.sdp
  v.conn.send({ t: 'signal', sessionId: v.sessionId, data: { type: 'offer', sdp: offer.sdp } })
}

const pendingIce = []
async function onViewerSignal(v, d) {
  if (d.type === 'answer') {
    // The host signs both DTLS fingerprints with its identity key. If this fails, the media path is not the host's.
    const ok = await arena.identity.verify({ hostId: v.h.id, pubKey: v.h.pubKey, sessionId: v.sessionId, hostFp: fingerprint(d.sdp), viewerFp: fingerprint(v.offerSdp), sig: d.sig })
    if (!ok) return leave(v, 'Security check failed: this connection is not from the registered computer. Disconnected.')
    await v.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp })
    for (const c of pendingIce.splice(0)) await v.pc.addIceCandidate(c)
    v.ready = true
  } else if (d.type === 'ice') {
    v.ready ? await v.pc.addIceCandidate(d.candidate).catch(() => {}) : pendingIce.push(d.candidate)
  }
}

async function onViewerCtl(v, m) {
  if (m.t === 'need-pass') {
    const pw = await ask('This computer requires its access passcode:', [['Cancel', null], ['Connect', true, 'primary']], true)
    v.ctl.send(JSON.stringify({ t: 'pass', pw: pw === null || pw === false ? '' : pw }))
  } else if (m.t === 'auth') {
    $('stageMsg').textContent = m.ok ? '' : 'Passcode rejected.'
    v.control = m.ok && m.control
    if (m.ok) { setQuality(); v.ctl.send(JSON.stringify({ t: 'ping', at: performance.now() })) }
  } else if (m.t === 'pong') v.rtt = performance.now() - m.at, setTimeout(() => v.ctl?.readyState === 'open' && v.ctl.send(JSON.stringify({ t: 'ping', at: performance.now() })), 1000)
  else if (m.t === 'control') v.control = m.control
}

function leave(v, msg) {
  if (!v || v.closed) return
  v.closed = true
  clearInterval(v.statsTimer)
  try { v.conn?.send({ t: 'end', sessionId: v.sessionId }); v.conn?.ws.close() } catch {}
  try { v.pc?.close() } catch {}
  if (document.pointerLockElement) document.exitPointerLock()
  if (document.fullscreenElement) document.exitFullscreen()
  $('video').srcObject = null
  show($('stage'), false); show($('app'), true)
  view = null
  $('viewerMsg').textContent = msg ?? ''
}

$('btnLeave').onclick = () => leave(view, 'Disconnected.')
$('btnStats').onclick = () => { $('stats').hidden = !$('stats').hidden }
$('btnFull').onclick = async () => {
  if (document.fullscreenElement) return document.exitFullscreen()
  await $('stage').requestFullscreen()
  navigator.keyboard?.lock?.().catch(() => {}) // lets Alt+Tab, Win key etc. reach the remote computer
}
$('btnLock').onclick = () => $('video').requestPointerLock?.()
$('quality').onchange = () => setQuality()
function setQuality() { if (view?.ctl?.readyState === 'open') view.ctl.send(JSON.stringify({ t: 'quality', mbps: Number($('quality').value) })) }

// ----- input capture -----
function norm(e) {
  const vid = $('video'), r = vid.getBoundingClientRect(), vw = vid.videoWidth, vh = vid.videoHeight
  if (!vw) return null
  const s = Math.min(r.width / vw, r.height / vh), cw = vw * s, ch = vh * s
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left - (r.width - cw) / 2) / cw)), y: Math.min(1, Math.max(0, (e.clientY - r.top - (r.height - ch) / 2) / ch)) }
}
const live = () => view && view.ready && view.control
const sendIn = (ev, reliable = true) => {
  const ch = reliable ? view.ctl : view.fast
  if (ch?.readyState === 'open') ch.send(JSON.stringify(ev))
}
let moveEv = null
function flushMove() {
  if (moveEv && live()) sendIn(moveEv, false)
  moveEv = null
  requestAnimationFrame(flushMove)
}
requestAnimationFrame(flushMove)

const stageEl = () => $('stage')
document.addEventListener('mousemove', e => {
  if (!live()) return
  if (document.pointerLockElement) { // relative motion, accumulated until the next frame
    moveEv = { k: 'mr', dx: (moveEv?.dx ?? 0) + e.movementX, dy: (moveEv?.dy ?? 0) + e.movementY }
  } else { const n = norm(e); if (n) moveEv = { k: 'mm', ...n } }
})
document.addEventListener('mousedown', e => { if (live() && stageEl().contains(e.target) && e.target === $('video')) { const n = norm(e); if (n && !document.pointerLockElement) sendIn({ k: 'mm', ...n }); sendIn({ k: 'md', b: e.button }); e.preventDefault() } })
document.addEventListener('mouseup', e => { if (live() && !stageEl().hidden) { sendIn({ k: 'mu', b: e.button }); e.preventDefault() } })
document.addEventListener('contextmenu', e => { if (!stageEl().hidden) e.preventDefault() })
document.addEventListener('wheel', e => { if (live() && !stageEl().hidden) { sendIn({ k: 'wh', dx: e.deltaX, dy: e.deltaY }, false); e.preventDefault() } }, { passive: false })
document.addEventListener('keydown', e => { if (live() && !stageEl().hidden && !e.repeat && document.activeElement?.tagName !== 'SELECT') { sendIn({ k: 'kd', c: e.code }); e.preventDefault() } }, true)
document.addEventListener('keyup', e => { if (live() && !stageEl().hidden && document.activeElement?.tagName !== 'SELECT') { sendIn({ k: 'ku', c: e.code }); e.preventDefault() } }, true)
window.addEventListener('blur', () => { if (live()) sendIn({ k: 'ra' }) }) // never leave keys stuck on the remote side

// ----- stats overlay -----
let prev = null
async function updateStats(v) {
  const stats = await v.pc.getStats(), by = {}
  stats.forEach(s => { by[s.type] ??= []; by[s.type].push(s) })
  const r = by['inbound-rtp']?.find(s => s.kind === 'video')
  if (!r) return
  const pair = by['candidate-pair']?.find(p => p.state === 'succeeded' && p.nominated)
  const codec = stats.get(r.codecId)?.mimeType
  const dt = prev ? (r.timestamp - prev.timestamp) / 1000 : 1
  const fps = prev ? (r.framesDecoded - prev.framesDecoded) / dt : r.framesPerSecond
  const mbps = prev ? ((r.bytesReceived - prev.bytesReceived) * 8) / dt / 1e6 : 0
  const jb = r.jitterBufferEmittedCount ? (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000 : 0
  const dec = r.framesDecoded ? (r.totalDecodeTime / r.framesDecoded) * 1000 : 0
  prev = r
  $('stats').textContent = [
    `${r.frameWidth}x${r.frameHeight} @ ${fps.toFixed(0)} fps   ${codec ?? ''}`,
    `bitrate ${mbps.toFixed(1)} Mbps   lost ${r.packetsLost}   dropped ${r.framesDropped ?? 0}`,
    `network RTT ${pair ? (pair.currentRoundTripTime * 1000).toFixed(0) : '?'} ms   input RTT ${v.rtt?.toFixed(0) ?? '?'} ms`,
    `jitter buffer ${jb.toFixed(0)} ms   decode ${dec.toFixed(1)} ms   ${r.decoderImplementation ?? ''}`,
  ].join('\n')
}

// =====================================================================
// HOST
// =====================================================================
let hostInfo = null, hostSel = null, hostConn = null, hostState = null // hostState = active session

async function initHostPane() {
  hostInfo = await arena.identity.info()
  $('hostReadable').textContent = hostInfo.readable
  const known = localStorage.getItem('enrolled:' + base) === hostInfo.hostId
  show($('enroll'), !known); show($('hostSetup'), known)
  if (known) loadSources()
}

$('enrollBtn').onclick = async () => {
  try {
    const { code } = await post('/api/enroll-code', {}, true)
    const c = signaling('/host', m => {
      if (m.t === 'enrolled') { localStorage.setItem('enrolled:' + base, m.hostId); c.ws.close(); initHostPane() }
      if (m.t === 'error') { c.ws.close(); alert('Registration failed') }
    })
    await c.opened
    c.send({ t: 'enroll', code, name: $('hostName').value || 'My PC', pubKey: hostInfo.pubKey })
  } catch (e) { alert(e.message) }
}

async function loadSources() {
  const list = await arena.host.sources()
  hostSel = list[0]?.id ?? null
  $('sources').replaceChildren(...list.map(s => {
    const b = document.createElement('button')
    b.className = 'tile' + (s.id === hostSel ? ' on' : '')
    const img = document.createElement('img'); img.src = s.thumb
    b.append(img, `${s.name} (${s.w}x${s.h})`)
    b.onclick = () => { hostSel = s.id; for (const x of $('sources').children) x.classList.remove('on'); b.classList.add('on') }
    return b
  }))
}

$('unattended').onchange = () => show($('passRow'), $('unattended').checked)

$('startHost').onclick = async () => {
  if ($('unattended').checked) {
    if (!$('passcode').value && !(await arena.passcode.has())) return alert('Set a passcode of at least 8 characters.')
    if ($('passcode').value && !(await arena.passcode.set($('passcode').value))) return alert('Passcode must be at least 8 characters.')
    $('passcode').value = ''
  }
  await arena.host.arm(true, hostSel)
  hostConn = signaling('/host', onHostMessage, () => { if (hostConn) stopHost('Lost connection to the server.') })
  hostConn.unattended = $('unattended').checked
  hostConn.opened.then(() => {}).catch(e => stopHost(e.message))
  show($('hostSetup'), false); show($('hostLive'), true)
}

async function onHostMessage(m) {
  if (m.t === 'challenge') return hostConn.send({ t: 'hello', hostId: hostInfo.hostId, sig: await arena.identity.sign(hostAuthMessage(m.nonce)) })
  if (m.t === 'ready') { ice = m.ice; return void ($('hostStatus').textContent = 'Sharing — waiting for a connection') }
  if (m.t === 'error') return stopHost('The server rejected this computer.')
  if (m.t === 'request') return onRequest(m)
  if (m.t === 'signal') return hostState?.sessionId === m.sessionId ? hostSignal(m.data) : void earlySignals.push(m) // viewer may signal while consent is pending
  if (m.t === 'ended' && hostState?.sessionId === m.sessionId) return endHostSession('Viewer left.')
}

const earlySignals = []

async function onRequest({ sessionId, user }) {
  if (hostState) return hostConn.send({ t: 'end', sessionId }) // one session at a time
  let control = true, authorized = true
  if (hostConn.unattended) {
    authorized = false // media stays disabled until the viewer proves the passcode
  } else {
    const r = await ask(`${user} wants to connect to this computer.`, [['Deny', 'no'], ['View only', 'view'], ['Allow control', 'control', 'primary']])
    if (r === 'no') return hostConn.send({ t: 'end', sessionId })
    control = r === 'control'
  }
  hostState = { sessionId, user, control, authorized, pc: null, stream: null, ctl: null, pendingIce: [], remoteSet: false }
  await arena.host.begin({ sessionId, control: authorized && control })
  $('hostStatus').textContent = `Connecting to ${user}…`
  for (const m of earlySignals.splice(0)) if (m.sessionId === sessionId) await hostSignal(m.data)
}

/** Any failure while negotiating ends the session visibly instead of leaving both sides hanging. */
async function hostSignal(d) {
  try { await onHostSignal(d) } catch (e) { endHostSession(`Failed: ${e.message}`) }
}

async function onHostSignal(d) {
  const s = hostState
  if (d.type === 'ice') return s.remoteSet ? void s.pc?.addIceCandidate(d.candidate).catch(() => {}) : s.pendingIce.push(d.candidate)
  if (d.type !== 'offer' || s.pc) return
  const pc = s.pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' })
  pc.onicecandidate = e => e.candidate && hostConn.send({ t: 'signal', sessionId: s.sessionId, data: { type: 'ice', candidate: e.candidate } })
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && hostState === s) endHostSession('Connection lost.') }
  pc.ondatachannel = e => {
    const ch = e.channel
    if (ch.label === 'ctl') { s.ctl = ch; ch.onmessage = ev => onHostCtl(s, JSON.parse(ev.data)); ch.onopen = () => { if (!s.authorized) ch.send(JSON.stringify({ t: 'need-pass' })); else ch.send(JSON.stringify({ t: 'auth', ok: true, control: s.control })) } }
    else ch.onmessage = ev => onHostCtl(s, JSON.parse(ev.data))
  }
  await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp })
  s.remoteSet = true
  for (const c of s.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {})

  // Capture exactly once per session; the main process decides which display (renderer cannot choose).
  s.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: true })
  const [vt] = s.stream.getVideoTracks(), [at] = s.stream.getAudioTracks()
  vt.contentHint = 'motion' // prefer frame rate over resolution under pressure
  vt.enabled = s.authorized; if (at) at.enabled = s.authorized
  for (const t of pc.getTransceivers()) {
    const track = t.receiver.track.kind === 'video' ? vt : at
    if (!track) continue
    t.direction = 'sendonly'
    await t.sender.replaceTrack(track)
    t.sender.setStreams?.(s.stream)
    if (track === vt) preferCodecs(t, 'video', VIDEO_ORDER)
  }
  await tuneSender(s, 25)
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  const sig = await arena.identity.sign(`arena-remote-session|${s.sessionId}|${fingerprint(answer.sdp)}|${fingerprint(d.sdp)}`)
  hostConn.send({ t: 'signal', sessionId: s.sessionId, data: { type: 'answer', sdp: answer.sdp, sig } })
  $('hostStatus').textContent = `Connected: ${s.user}${s.authorized ? '' : ' (waiting for passcode)'}${(await arena.helperStatus()) ? ' � elevated access on' : ''}`
  show($('hostSession'), true)
  $('hostWho').textContent = `${s.user} is ${s.authorized ? 'connected' : 'connecting'}.`
  updateControlButton()
}

async function tuneSender(s, mbps) {
  const sender = s.pc.getSenders().find(x => x.track?.kind === 'video')
  if (!sender) return
  const p = sender.getParameters()
  p.degradationPreference = 'maintain-framerate'
  p.encodings = [{ ...(p.encodings?.[0] ?? {}), maxBitrate: mbps * 1e6, maxFramerate: FPS, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' }]
  await sender.setParameters(p).catch(() => {})
}

async function onHostCtl(s, m) {
  if (hostState !== s) return
  if (m.t === 'pass' && !s.authorized) {
    if (await arena.passcode.check(m.pw)) {
      s.authorized = true
      for (const t of s.stream.getTracks()) t.enabled = true
      if (secure) secure.track.enabled = true
      await arena.host.setControl(s.control)
      s.ctl.send(JSON.stringify({ t: 'auth', ok: true, control: s.control }))
      $('hostStatus').textContent = `Connected: ${s.user}`
      $('hostWho').textContent = `${s.user} is connected (passcode verified).`
    } else s.ctl.send(JSON.stringify({ t: 'auth', ok: false }))
  } else if (m.t === 'ping') s.ctl.send(JSON.stringify({ t: 'pong', at: m.at }))
  else if (m.t === 'quality' && s.authorized) tuneSender(s, Math.min(100, Math.max(1, Number(m.mbps) || 25)))
  else if (s.authorized && s.control && typeof m.k === 'string') arena.host.input(m)
}

// ----- secure desktop (UAC / login screen) via the service helper -----
// Chromium cannot capture these desktops, so the helper streams JPEG frames that are painted on a canvas and
// swapped into the same video sender (replaceTrack: no renegotiation). Back on the normal desktop the screen track returns.
let secure = null // { canvas, track }
function secureCanvas() {
  if (!secure) {
    const canvas = document.createElement('canvas')
    canvas.width = 1280; canvas.height = 720
    secure = { canvas, ctx: canvas.getContext('2d'), track: canvas.captureStream(30).getVideoTracks()[0], busy: false }
  }
  return secure
}
async function swapVideo(s, toSecure) {
  const sender = s.pc?.getSenders().find(x => x.track?.kind === 'video')
  if (!sender) return
  const c = secureCanvas()
  const track = toSecure ? c.track : s.stream.getVideoTracks()[0]
  track.enabled = s.authorized
  await sender.replaceTrack(track)
  s.secureActive = toSecure
  $('hostStatus').textContent = toSecure ? `Connected: ${s.user} � secure desktop (UAC / sign-in)` : `Connected: ${s.user}`
  arena.host.frames(toSecure)
}
arena.onDesktop(name => { if (hostState?.pc) swapVideo(hostState, name !== 'Default').catch(() => {}) })
arena.onFrame(async data => {
  const c = secure
  if (!c || c.busy || !hostState?.secureActive) return
  c.busy = true // drop frames while one is still decoding, keeps latency bounded
  try {
    const bmp = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
    if (c.canvas.width !== bmp.width || c.canvas.height !== bmp.height) { c.canvas.width = bmp.width; c.canvas.height = bmp.height }
    c.ctx.drawImage(bmp, 0, 0)
    bmp.close()
  } finally { c.busy = false }
})

function updateControlButton() { $('toggleControl').textContent = hostState?.control ? 'Revoke control' : 'Allow control' }
$('toggleControl').onclick = async () => {
  const s = hostState
  if (!s) return
  s.control = !s.control
  await arena.host.setControl(s.authorized && s.control)
  s.ctl?.send(JSON.stringify({ t: 'control', control: s.control }))
  updateControlButton()
}
$('endSession').onclick = () => endHostSession('Ended by you.')

function endHostSession(msg) {
  const s = hostState
  if (!s) return
  hostState = null
  hostConn?.send({ t: 'end', sessionId: s.sessionId })
  s.stream?.getTracks().forEach(t => t.stop())
  if (secure) { secure.track.stop(); secure = null }
  try { s.pc?.close() } catch {}
  arena.host.end()
  show($('hostSession'), false)
  $('hostStatus').textContent = msg ? `Sharing — ${msg}` : 'Sharing — waiting for a connection'
}

function stopHost(msg) {
  endHostSession()
  const c = hostConn; hostConn = null
  c?.ws.close()
  arena.host.arm(false)
  show($('hostLive'), false); show($('hostSetup'), true)
  if (msg) alert(msg)
}
$('stopHost').onclick = () => stopHost()

arena.onKill(() => { endHostSession('Emergency stop.'); if (view) leave(view, 'Emergency stop.') })
