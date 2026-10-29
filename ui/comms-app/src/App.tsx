import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CommsEngine, Channel, PeerInfo, httpBase } from './lib/comms'
import './App.css'

interface ServerInfo { auth: 'accounts' | 'open'; pin: boolean; groups: { id: string; name: string }[] }

/** Ask the server how to sign in, so the form matches (accounts vs. open join). */
function useServerInfo(url: string) {
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setInfo(null); setErr('')
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch(`${httpBase(url)}/info`, { signal: ctl.signal })
        .then(r => r.json()).then(setInfo)
        .catch(e => { if (!ctl.signal.aborted) setErr(`Can't reach the server (${(e as Error).message})`) })
    }, 350)
    return () => { clearTimeout(t); ctl.abort() }
  }, [url])
  return { info, err }
}

interface Prefs {
  url: string; username: string; name: string; group: string; pin: string
  micId: string; spkId: string; echoCancel: boolean; muted: string[]; programUrl: string
}

function loadPrefs(): Prefs {
  const d: Prefs = {
    url: 'ws://localhost:8900', username: '', name: '', group: '', pin: '',
    micId: '', spkId: '', echoCancel: true, muted: [], programUrl: '',
  }
  try { return { ...d, ...JSON.parse(localStorage.getItem('arena-comms-prefs') ?? '{}') } } catch { return d }
}

export default function App() {
  const engine = useMemo(() => new CommsEngine(), [])
  useSyncExternalStore(engine.subscribe, engine.getVersion)
  if (import.meta.env.DEV) (window as unknown as { __comms: CommsEngine }).__comms = engine
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [password, setPassword] = useState('')
  const { info, err: infoErr } = useServerInfo(prefs.url)

  const patch = (p: Partial<Prefs>) => setPrefs(prev => {
    const next = { ...prev, ...p }
    try { localStorage.setItem('arena-comms-prefs', JSON.stringify({ ...next, pin: '' })) } catch { /* private mode */ }
    return next
  })

  const refreshDevices = () =>
    navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {})
  useEffect(() => {
    refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
  }, [])

  // Remember which channels I muted between sessions.
  const mutedNow = engine.channels.filter(c => !engine.listen.has(c.id)).map(c => c.id).join(',')
  useEffect(() => {
    if (engine.status === 'connected') patch({ muted: mutedNow ? mutedNow.split(',') : [] })
  }, [mutedNow, engine.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Safety: never leave a hot mic if the window loses focus mid-press.
  useEffect(() => {
    const off = () => engine.releaseAll()
    window.addEventListener('blur', off)
    return () => window.removeEventListener('blur', off)
  }, [engine])

  const join = () => {
    if (!info) return
    const group = info.groups.find(g => g.id === prefs.group)?.id ?? info.groups[0]?.id
    void engine.join(
      { url: prefs.url.trim(), auth: info.auth, username: prefs.username, password, name: prefs.name, group, pin: prefs.pin,
        micId: prefs.micId || undefined, echoCancel: prefs.echoCancel,
        programUrl: prefs.programUrl },
      prefs.muted,
    )
    if (prefs.spkId) engine.setSpeaker(prefs.spkId)
  }

  const inSession = engine.status === 'connected' || engine.status === 'reconnecting'

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand"><img src="logo.png" alt="" /><span>ARENA</span><b>COMMS</b></div>
        <div className="title-right">
          <StatusPill engine={engine} />
          {inSession && <MicMeter engine={engine} />}
          {inSession && engine.isAdmin && <button className="btn ghost" onClick={() => window.open(`${httpBase(prefs.url)}/admin`, '_blank')}>Admin</button>}
          {inSession && <button className="btn ghost" onClick={() => setShowSettings(s => !s)}>Audio</button>}
          {inSession && <button className="btn danger" onClick={() => engine.leave()}>Leave</button>}
        </div>
      </div>
      {!inSession && engine.status !== 'connecting'
        ? <Login prefs={prefs} patch={patch} devices={devices} info={info} infoErr={infoErr}
                 password={password} setPassword={setPassword}
                 error={engine.status === 'error' ? engine.error : ''} onJoin={join} />
        : engine.status === 'connecting'
          ? <div className="center muted">Connecting…</div>
          : <Intercom engine={engine} name={engine.myName || prefs.name} />}
      {showSettings && inSession &&
        <Settings engine={engine} prefs={prefs} patch={patch} devices={devices} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

// ── Login ────────────────────────────────────────────────────────────────────
function Login({ prefs, patch, devices, info, infoErr, password, setPassword, error, onJoin }: {
  prefs: Prefs; patch: (p: Partial<Prefs>) => void; devices: MediaDeviceInfo[]
  info: ServerInfo | null; infoErr: string; password: string; setPassword: (v: string) => void
  error: string; onJoin: () => void
}) {
  const mics = devices.filter(d => d.kind === 'audioinput')
  const accounts = info?.auth === 'accounts'
  const ok = !!info && prefs.url.trim() && (accounts ? prefs.username.trim() && password : prefs.name.trim())
  return (
    <form className="login" onSubmit={e => { e.preventDefault(); if (ok) onJoin() }}>
      <h1>Join the intercom</h1>
      <label>Server<input value={prefs.url} onChange={e => patch({ url: e.target.value })} placeholder="ws://host:8900" /></label>
      {infoErr && <div className="error">{infoErr}</div>}
      {!info && !infoErr && <div className="muted">Contacting server…</div>}
      {accounts && (
        <div className="row">
          <label>Username<input value={prefs.username} onChange={e => patch({ username: e.target.value })} autoFocus autoComplete="username" /></label>
          <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
        </div>
      )}
      {info && !accounts && (
        <>
          <div className="row">
            <label>Your name<input value={prefs.name} onChange={e => patch({ name: e.target.value })} autoFocus /></label>
            <label>Role
              <select value={prefs.group} onChange={e => patch({ group: e.target.value })}>
                {info.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          </div>
          {info.pin && <label>PIN<input type="password" value={prefs.pin} onChange={e => patch({ pin: e.target.value })} /></label>}
        </>
      )}
      <label>Microphone
        <select value={prefs.micId} onChange={e => patch({ micId: e.target.value })}>
          <option value="">System default</option>
          {mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.echoCancel} onChange={e => patch({ echoCancel: e.target.checked })} />
        Echo cancellation &amp; noise suppression <span className="muted">(turn off for headset-only use)</span>
      </label>
      <label>Program feed URL <span className="muted">(WHEP, optional — overrides the server's)</span>
        <input value={prefs.programUrl} onChange={e => patch({ programUrl: e.target.value })} placeholder="http://host:8889/stream/whep" />
      </label>
      {error && <div className="error">{error}</div>}
      <button className="btn primary big" disabled={!ok}>Join</button>
    </form>
  )
}

// ── Intercom surface ─────────────────────────────────────────────────────────
function Intercom({ engine, name }: { engine: CommsEngine; name: string }) {
  const roster = engine.roster()
  const keyed = useRef(new Map<string, string>()) // keyboard code -> target

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat || (e.target as HTMLElement).matches('input,select,textarea')) return
      const n = /^Digit([1-9])$/.exec(e.code)
      const ch = n && engine.channels[Number(n[1]) - 1]
      if (ch) { keyed.current.set(e.code, ch.id); engine.press(ch.id) }
    }
    const up = (e: KeyboardEvent) => {
      const t = keyed.current.get(e.code)
      if (t) { keyed.current.delete(e.code); engine.release(t) }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [engine])

  return (
    <div className="body">
      <div className="channels">
        {engine.program && <ProgramStrip engine={engine} />}
        {engine.channels.map((c, i) => <Strip key={c.id} ch={c} index={i} engine={engine} name={name} />)}
      </div>
      <aside className="roster">
        <h2>On the line <span className="muted">{roster.length + 1}</span></h2>
        <div className="person me"><span className="dot ok" /><div className="pname">{name} <em>you</em></div></div>
        {roster.map(p => <Person key={p.id} p={p} engine={engine} />)}
      </aside>
    </div>
  )
}

function Strip({ ch, index, engine, name }: { ch: Channel; index: number; engine: CommsEngine; name: string }) {
  const listening = engine.listen.has(ch.id)
  const { canTalk, canListen } = ch
  const talking = engine.talkSet.has(ch.id)
  const latched = engine.latched.has(ch.id)
  const talkers = engine.talkersOn(ch.id, name)
  const call = engine.calls.get(ch.id)
  const calling = !!call && Date.now() - call.at < 4000
  const caller = calling ? engine.roster().find(p => p.id === call!.from)?.name : ''
  return (
    <div className={`strip ${talking ? 'talking' : ''} ${calling ? 'calling' : ''}`} style={{ ['--ch' as string]: ch.color }}>
      <div className="strip-head">
        <span className="key">{index < 9 ? index + 1 : ''}</span>
        <span className="cname">{ch.name}</span>
        {ch.ifb && <span className="tag" title="Interrupt foldback: ducks the program feed for listeners">IFB</span>}
      </div>
      <div className="talkers">
        {calling && <div className="callbadge">CALL from {caller || 'someone'}</div>}
        {talkers.length ? talkers.map(t => <div key={t} className="talker">{t}</div>) : <div className="muted">quiet</div>}
      </div>
      <button
        className={`talk ${talking ? 'on' : ''}`}
        disabled={!canTalk}
        title={canTalk ? undefined : 'Listen only'}
        onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); engine.press(ch.id) }}
        onPointerUp={() => engine.release(ch.id)}
        onPointerCancel={() => engine.release(ch.id)}
      >TALK</button>
      <div className="strip-foot">
        <button className={`mini ${listening ? 'on' : ''}`} disabled={!canListen} onClick={() => engine.setListen(ch.id, !listening)}>
          {!canListen ? 'NO LISTEN' : listening ? 'LISTEN' : 'MUTED'}
        </button>
        <button className={`mini ${latched ? 'latched' : ''}`} disabled={!canTalk} onClick={() => engine.toggleLatch(ch.id)}>LATCH</button>
        <button className="mini" disabled={!canTalk} onClick={() => engine.callChannel(ch.id)}>CALL</button>
      </div>
    </div>
  )
}

function ProgramStrip({ engine }: { engine: CommsEngine }) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (bar.current) bar.current.style.width = `${Math.round(engine.programLevel() * 100)}%`
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [engine])
  const st = engine.programState
  return (
    <div className={`strip program ${engine.ducked ? 'ducked' : ''}`} style={{ ['--ch' as string]: '#a78bfa' }}>
      <div className="strip-head">
        <span className="key">▶</span>
        <span className="cname">{engine.program!.name}</span>
        <span className={`tag ${st}`}>{st === 'live' ? 'LIVE' : st === 'connecting' ? 'CONNECTING' : st === 'error' ? 'OFFLINE' : 'OFF'}</span>
      </div>
      <div className="talkers">
        {engine.ducked && <div className="callbadge">DUCKED — IFB</div>}
        {st === 'error' && <div className="muted small">{engine.programError} · retrying</div>}
      </div>
      <div className="meter wide"><div ref={bar} /></div>
      <input type="range" min={0} max={1} step={0.01} value={engine.programVolume}
        onChange={e => engine.setProgramVolume(+e.target.value)} aria-label="Program volume" />
      <div className="strip-foot">
        <button className={`mini ${engine.programMuted ? '' : 'on'}`} onClick={() => engine.toggleProgramMute()}>
          {engine.programMuted ? 'MUTED' : 'LISTEN'}
        </button>
      </div>
    </div>
  )
}

function Person({ p, engine }: { p: PeerInfo; engine: CommsEngine }) {
  const target = `u:${p.id}`
  const direct = engine.talkSet.has(target)
  const names = p.talk.map(t => engine.channels.find(c => c.id === t)?.name ?? (t === `u:${engine.myId}` ? 'YOU' : 'DIRECT'))
  const linked = engine.peerLinked(p.id)
  const rtt = engine.peerRtt(p.id)
  return (
    <div className="person">
      <span className={`dot ${linked ? 'ok' : 'wait'}`} title={linked ? 'audio link up' : 'waiting for link'} />
      <div className="pname">{p.name}<em>{p.role}</em>
        {names.length > 0 && <div className="ptalk">talking: {names.join(', ')}</div>}
      </div>
      {rtt != null && <span className="rtt">{rtt}ms</span>}
      <button className={`mini ${direct ? 'on' : ''}`}
        onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); engine.press(target) }}
        onPointerUp={() => engine.release(target)}
        onPointerCancel={() => engine.release(target)}>DIRECT</button>
    </div>
  )
}

// ── Bits ─────────────────────────────────────────────────────────────────────
function StatusPill({ engine }: { engine: CommsEngine }) {
  const s = engine.status
  const label = s === 'connected' ? `Connected · ${engine.media.toUpperCase()}${engine.serverRttMs != null ? ` · ${engine.serverRttMs}ms` : ''}`
    : s === 'reconnecting' ? 'Reconnecting…' : s === 'connecting' ? 'Connecting…' : s === 'error' ? 'Error' : 'Offline'
  return <span className={`pill ${s}`}>{label}</span>
}

function MicMeter({ engine }: { engine: CommsEngine }) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (bar.current) bar.current.style.width = `${Math.round(engine.micLevel() * 100)}%`
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [engine])
  return <div className="meter" title="Microphone level"><div ref={bar} /></div>
}

function Settings({ engine, prefs, patch, devices, onClose }: {
  engine: CommsEngine; prefs: Prefs; patch: (p: Partial<Prefs>) => void; devices: MediaDeviceInfo[]; onClose: () => void
}) {
  const mics = devices.filter(d => d.kind === 'audioinput')
  const spks = devices.filter(d => d.kind === 'audiooutput')
  return (
    <div className="drawer">
      <div className="drawer-head"><h2>Audio</h2><button className="btn ghost" onClick={onClose}>Close</button></div>
      <label>Microphone
        <select value={prefs.micId} onChange={e => { patch({ micId: e.target.value }); void engine.setMic(e.target.value, prefs.echoCancel) }}>
          <option value="">System default</option>
          {mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
        </select>
      </label>
      <label>Speaker / headset
        <select value={prefs.spkId} onChange={e => { patch({ spkId: e.target.value }); engine.setSpeaker(e.target.value) }}>
          <option value="">System default</option>
          {spks.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Speaker'}</option>)}
        </select>
      </label>
      <label>Mic gain
        <input type="range" min={0} max={2} step={0.05} value={engine.micVolume} onChange={e => engine.setMicVolume(+e.target.value)} />
      </label>
      <label>Listen volume
        <input type="range" min={0} max={1} step={0.01} value={engine.masterVolume} onChange={e => engine.setMasterVolume(+e.target.value)} />
      </label>
      <label>Program feed URL <span className="muted">(applies on next join)</span>
        <input value={prefs.programUrl} onChange={e => patch({ programUrl: e.target.value })} placeholder="http://host:8889/stream/whep" />
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.echoCancel}
          onChange={e => { patch({ echoCancel: e.target.checked }); void engine.setMic(prefs.micId, e.target.checked) }} />
        Echo cancellation &amp; noise suppression
      </label>
      <p className="muted small">Keys 1–9 hold-to-talk on that channel. LATCH keeps a channel open hands-free.</p>
    </div>
  )
}
