import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CommsEngine, type MusicSource, Channel, PeerInfo, httpBase } from './lib/comms'
import './kp.css'
import './App.css'

/** LCD display colours: [css colour, "r, g, b" for glows]. */
const LCD_COLORS = {
  amber: ['#ffb938', '255, 185, 56'],
  green: ['#7dff9a', '125, 255, 154'],
  white: ['#e8f1ff', '232, 241, 255'],
  blue: ['#6fc3ff', '111, 195, 255'],
} as const

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
  levels: Record<string, number>; density: 'compact' | 'comfortable'
  lcdColor: keyof typeof LCD_COLORS; lcdBright: number; night: boolean
  spatial: boolean; spread: number; pans: Record<string, number>
  speakAlerts: boolean; alertTones: boolean; micRelease: boolean
  musicSrc: string; musicVol: number
}

function loadPrefs(): Prefs {
  const d: Prefs = {
    // Served from the server's own dashboard (https://host/comms/app/)? Connect back to it.
    url: /^https?:$/.test(location.protocol) && !/^(localhost|127\.)/.test(location.hostname)
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/comms`
      : 'ws://localhost:8900',
    username: '', name: '', group: '', pin: '',
    micId: '', spkId: '', echoCancel: true, muted: [], programUrl: '',
    levels: {}, density: 'compact', lcdColor: 'amber', lcdBright: 1, night: false,
    spatial: false, spread: 0.7, pans: {}, speakAlerts: true, alertTones: true, micRelease: true, musicSrc: 'display', musicVol: 0.6,
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
  useEffect(() => { if (showSettings) refreshDevices() }, [showSettings])

  // Remember which channels I muted between sessions.
  const mutedNow = engine.channels.filter(c => !engine.listen.has(c.id)).map(c => c.id).join(',')
  useEffect(() => {
    if (engine.status === 'connected') patch({ muted: mutedNow ? mutedNow.split(',') : [] })
  }, [mutedNow, engine.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Remember per-key listen levels.
  const levelsNow = JSON.stringify(engine.channelLevels())
  useEffect(() => {
    if (engine.status === 'connected') patch({ levels: JSON.parse(levelsNow) })
  }, [levelsNow, engine.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Panel look: LCD colour/brightness and night mode.
  useEffect(() => {
    const [css, rgb] = LCD_COLORS[prefs.lcdColor] ?? LCD_COLORS.amber
    const root = document.documentElement
    root.style.setProperty('--lcd', css)
    root.style.setProperty('--lcd-rgb', rgb)
    root.style.setProperty('--lcd-bright', String(prefs.lcdBright))
    document.body.classList.toggle('night', prefs.night)
  }, [prefs.lcdColor, prefs.lcdBright, prefs.night])

  // Spatial audio follows the saved settings.
  useEffect(() => {
    engine.setSpatial({ on: prefs.spatial, spread: prefs.spread, overrides: prefs.pans })
  }, [engine, prefs.spatial, prefs.spread, prefs.pans])

  // Remember the music level between sessions.
  useEffect(() => { engine.setMusicVolume(prefs.musicVol) }, [engine]) // eslint-disable-line react-hooks/exhaustive-deps

  // Release the microphone while idle (OS mic indicator off); it reopens on the first press.
  useEffect(() => {
    engine.micIdleRelease = prefs.micRelease
    engine.syncMic()
  }, [engine, prefs.micRelease])

  // Alert style (spoken cue / tones) follows the settings.
  useEffect(() => {
    engine.speakAlerts = prefs.speakAlerts
    engine.alertTones = prefs.alertTones
  }, [engine, prefs.speakAlerts, prefs.alertTones])

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
      prefs.muted, prefs.levels,
    )
    if (prefs.spkId) engine.setSpeaker(prefs.spkId)
    setTimeout(refreshDevices, 1500) // output devices and labels appear once the mic permission is granted
  }

  const inSession = engine.status === 'connected' || engine.status === 'reconnecting'

  return (
    <div className="app" data-density={prefs.density}>
      <div className="titlebar">
        <div className="brand"><img src="logo.png" alt="" /><span>ARENA</span><b>COMMS</b></div>
        <div className="title-right">{!inSession && <StatusPill engine={engine} />}</div>
      </div>
      {!inSession && engine.status !== 'connecting'
        ? <Login prefs={prefs} patch={patch} devices={devices} info={info} infoErr={infoErr}
                 password={password} setPassword={setPassword}
                 error={engine.status === 'error' ? engine.error : ''} onJoin={join} />
        : engine.status === 'connecting'
          ? <div className="center muted">Connecting…</div>
          : <Intercom engine={engine} name={engine.myName || prefs.name} prefs={prefs} patch={patch} devices={devices}
                      onAudio={() => setShowSettings(v => !v)}
                      onAdmin={engine.isAdmin ? () => window.open(`${httpBase(prefs.url)}/admin`, '_blank') : undefined} />}
      {showSettings && inSession &&
        <Settings engine={engine} prefs={prefs} patch={patch} devices={devices} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

// ── Login ────────────────────────────────────────────────────────────────────
/** Chromium/Electron can route audio to a chosen output device; Firefox and Safari cannot. */
const canPickSpeaker = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype

function Login({ prefs, patch, devices, info, infoErr, password, setPassword, error, onJoin }: {
  prefs: Prefs; patch: (p: Partial<Prefs>) => void; devices: MediaDeviceInfo[]
  info: ServerInfo | null; infoErr: string; password: string; setPassword: (v: string) => void
  error: string; onJoin: () => void
}) {
  const mics = devices.filter(d => d.kind === 'audioinput')
  const spks = devices.filter(d => d.kind === 'audiooutput')
  const accounts = info?.auth === 'accounts'
  const ok = !!info && prefs.url.trim() && (accounts ? prefs.username.trim() && password : prefs.name.trim())
  return (
    <form className="login chassis" onSubmit={e => { e.preventDefault(); if (ok) onJoin() }}>
      <h1 className="lcd">Join the intercom</h1>
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
      <label>Speaker / headset
        <select value={prefs.spkId} disabled={!canPickSpeaker} onChange={e => patch({ spkId: e.target.value })}>
          <option value="">System default</option>
          {spks.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
        </select>
        {!canPickSpeaker && <span className="muted">This browser can only use the system default output. Use Chrome or the desktop app to pick one.</span>}
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
function Intercom({ engine, name, prefs, patch, devices, onAudio, onAdmin }: {
  engine: CommsEngine; name: string; prefs: Prefs; patch: (p: Partial<Prefs>) => void; devices: MediaDeviceInfo[]
  onAudio: () => void; onAdmin?: () => void
}) {
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

  const dock = (
    <div className="dock">
      <div className="dock-group">
        <Knob label="MIC" value={engine.micVolume} min={0} max={2} onChange={v => engine.setMicVolume(v)} readout={`${Math.round(engine.micVolume * 100)}`} />
        <LedMeter engine={engine} source="mic" />
      </div>
      <div className="dock-group">
        <Knob label="LISTEN" value={engine.masterVolume} min={0} max={1} onChange={v => engine.setMasterVolume(v)} readout={`${Math.round(engine.masterVolume * 100)}`} />
      </div>
      <span className="grow" />
      <button className="cap sm hw" onClick={onAudio}>AUDIO</button>
      {onAdmin && <button className="cap sm hw" onClick={onAdmin}>ADMIN</button>}
      <button className="cap sm hw leave" onClick={() => engine.leave()}>LEAVE</button>
    </div>
  )

  return (
    <div className="body">
      <section className="panel">
        <div className="lcd header-lcd">
          <div className="hl-left">
            <div className="hl-name">{name}</div>
            <div className="hl-sub">{engine.myTitle || '—'}</div>
          </div>
          <div className="hl-mid">
            <span className={`hl-state ${engine.status}`}>{engine.status === 'connected' ? 'ON LINE' : engine.status.toUpperCase()}</span>
            <span>{engine.media.toUpperCase()}{engine.serverRttMs != null ? ` · ${engine.serverRttMs} ms` : ''}</span>
          </div>
          <Clock />
        </div>
        {engine.streams.length > 0 && (
          <div className="lcd stream-lcd" title="Arena stream health">
            <span className="sl-title">STREAMS</span>
            {engine.streams.map(st => <span key={st.id} className={`sl-chip ${st.state}`}>{st.name}</span>)}
          </div>
        )}
        <div className="keys">
          {engine.program && <ProgramKey engine={engine} />}
          {engine.music && <MusicKey engine={engine} prefs={prefs} patch={patch} devices={devices} />}
          {engine.channels.map((c, i) => <ChannelKey key={c.id} ch={c} index={i} engine={engine} name={name} />)}
        </div>
        {dock}
      </section>
      <aside className="directory">
        <div className="lcd dir-head"><span>DIRECT</span><span>{roster.length + 1} ON LINE</span></div>
        <div className="dir-list">
          <div className="person me"><i className="led green on" /><div className="pname">{name}<em>YOU</em></div></div>
          {roster.map(p => <Person key={p.id} p={p} engine={engine} />)}
        </div>
      </aside>
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  return <div className="hl-clock">{now.toLocaleTimeString([], { hour12: false })}</div>
}

/** One channel key: LCD legend, big illuminated TALK key, and LISTEN / LATCH / CALL keys with LEDs. */
function ChannelKey({ ch, index, engine, name }: { ch: Channel; index: number; engine: CommsEngine; name: string }) {
  const listening = engine.listen.has(ch.id)
  const { canTalk, canListen } = ch
  const talking = engine.talkSet.has(ch.id)
  const latched = engine.latched.has(ch.id)
  const talkers = engine.talkersOn(ch.id, name)
  const call = engine.calls.get(ch.id)
  const calling = !!call && Date.now() - call.at < 4000
  const caller = calling ? engine.roster().find(p => p.id === call!.from)?.name : ''
  const alert = engine.activeAlert(ch.id)
  return (
    <div className={`keymod ${talking ? 'talking' : ''} ${calling ? 'calling' : ''} ${alert && !calling ? `alert-${alert.level}` : ''} ${canTalk ? '' : 'rx-only'}`} style={{ ['--ch' as string]: ch.color }}>
      <div className="lcd legend">
        {engine.spatial.on && <span className="pantick" title={`Stereo position ${Math.round(engine.channelPan(ch.id) * 100)}`}><i style={{ left: `${(engine.channelPan(ch.id) + 1) * 50}%` }} /></span>}
        <div className="lg-top">
          <span className="lg-num">{index < 9 ? index + 1 : ''}</span>
          <span className="lg-name">{ch.name}</span>
          {ch.ifb && <span className="lg-tag" title="Interrupt foldback: ducks the program feed for listeners">IFB</span>}
        </div>
        <div className="lg-sub">
          {calling
            ? <span className="blink">CALL ▸ {(caller || 'SOMEONE').toUpperCase()}</span>
            : alert ? <span className={`blink alert-text ${alert.level}`}>{alert.level === 'warn' ? '▲' : '●'} {alert.text.toUpperCase()}</span>
            : talkers.length ? talkers.map(t => <span key={t}>{t.toUpperCase()}</span>) : <span className="dim">{canTalk ? 'READY' : 'LISTEN ONLY'}</span>}
        </div>
      </div>
      <div className="keyrow">
      <button
        className={`cap talkkey ${talking ? 'on' : ''}`}
        disabled={!canTalk}
        title={canTalk ? 'Hold to talk' : 'Listen only'}
        onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); engine.press(ch.id) }}
        onPointerUp={() => engine.release(ch.id)}
        onPointerCancel={() => engine.release(ch.id)}
      ><i className={`led red ${talking ? 'on' : ''}`} />TALK</button>
      <Knob mini label={`${ch.name} level`} value={engine.channelLevel(ch.id)} min={0} max={1}
            onChange={v => engine.setChannelLevel(ch.id, v)} readout={`${Math.round(engine.channelLevel(ch.id) * 100)}`} />
      </div>
      <div className="subkeys">
        <button className="cap sm" disabled={!canListen} onClick={() => engine.setListen(ch.id, !listening)}>
          <i className={`led green ${listening && canListen ? 'on' : ''}`} />{!canListen ? 'NO RX' : 'LISTEN'}
        </button>
        <button className="cap sm" disabled={!canTalk} onClick={() => engine.toggleLatch(ch.id)}>
          <i className={`led amber ${latched ? 'on' : ''}`} />LATCH
        </button>
        <button className="cap sm" disabled={!canTalk} onClick={() => engine.callChannel(ch.id)}>
          <i className={`led amber ${calling ? 'on blink' : ''}`} />CALL
        </button>
      </div>
    </div>
  )
}

/** Program feed key: LCD, LED meter, volume knob and a listen key. */
function ProgramKey({ engine }: { engine: CommsEngine }) {
  const st = engine.programState
  const state = st === 'live' ? 'LIVE' : st === 'connecting' ? 'CONNECTING' : st === 'error' ? 'OFFLINE' : 'OFF'
  return (
    <div className={`keymod program ${engine.ducked ? 'ducked' : ''}`} style={{ ['--ch' as string]: '#a78bfa' }}>
      <div className="lcd legend">
        <div className="lg-top">
          <span className="lg-num">▶</span>
          <span className="lg-name">{engine.program!.name}</span>
          <span className={`lg-tag ${st}`}>{state}</span>
        </div>
        <div className="lg-sub">
          {engine.ducked ? <span className="blink">DUCKED · IFB</span>
            : st === 'error' ? <span className="dim">{engine.programError.toUpperCase()}</span> : <span className="dim">PROGRAM FEED</span>}
        </div>
      </div>
      <div className="pgm-mid">
        <LedMeter engine={engine} source="program" />
        <Knob label="LEVEL" value={engine.programVolume} min={0} max={1} onChange={v => engine.setProgramVolume(v)} readout={`${Math.round(engine.programVolume * 100)}`} />
      </div>
      <div className="subkeys one">
        <button className="cap sm" onClick={() => engine.toggleProgramMute()}>
          <i className={`led green ${engine.programMuted ? '' : 'on'}`} />{engine.programMuted ? 'MUTED' : 'LISTEN'}
        </button>
      </div>
    </div>
  )
}

/**
 * Shared music feed (e.g. the A1's setup music). Everyone who may hear it gets a level knob and a mute;
 * roles allowed to send also get a source picker and a start/stop key. It is ducked by IFB like the program.
 */
function MusicKey({ engine, prefs, patch, devices }: {
  engine: CommsEngine; prefs: Prefs; patch: (p: Partial<Prefs>) => void; devices: MediaDeviceInfo[]
}) {
  const m = engine.music!
  const senders = [...engine.musicSenders.values()]
  const sending = engine.musicSending
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const inputs = devices.filter(d => d.kind === 'audioinput')
  const source = (): MusicSource => (prefs.musicSrc === 'display' ? { kind: 'display' } : { kind: 'device', deviceId: prefs.musicSrc })
  return (
    <div className={`keymod music ${senders.length ? 'onair' : ''} ${engine.ducked ? 'ducked' : ''}`} style={{ ['--ch' as string]: '#f472b6' }}>
      <div className="lcd legend">
        <div className="lg-top">
          <span className="lg-num">♪</span>
          <span className="lg-name">{m.name}</span>
          <span className={`lg-tag ${senders.length ? 'live' : ''}`}>{senders.length ? 'ON AIR' : 'OFF'}</span>
        </div>
        <div className="lg-sub">
          {engine.musicError ? <span className="alert-text warn">{engine.musicError.toUpperCase()}</span>
            : engine.ducked && !sending ? <span className="blink">DUCKED · IFB</span>
            : sending ? <span>SENDING TO THE ROOM</span>
            : senders.length ? <span>▶ {senders.join(', ').toUpperCase()}</span>
            : <span className="dim">{m.canSend ? 'READY — START A SOURCE' : 'NO MUSIC PLAYING'}</span>}
        </div>
      </div>
      {m.canSend ? (
        <>
          <label className="musicsrc">
            <select value={prefs.musicSrc} disabled={sending} onChange={e => patch({ musicSrc: e.target.value })} title="Where the music comes from">
              {canShare && <option value="display">Computer / tab audio (share)</option>}
              {inputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Input ${i + 1}`}</option>)}
            </select>
          </label>
          <div className="pgm-mid">
            <LedMeter engine={engine} source="music" />
          </div>
          <div className="subkeys one">
            <button className={`cap sm ${sending ? 'on' : ''}`} onClick={() => (sending ? engine.stopMusic() : void engine.startMusic(source()))}>
              <i className={`led ${sending ? 'red on' : 'green'}`} />{sending ? 'STOP MUSIC' : 'START MUSIC'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pgm-mid">
            <Knob label="LEVEL" value={engine.musicVolume} min={0} max={1}
              onChange={v => { engine.setMusicVolume(v); patch({ musicVol: v }) }} readout={`${Math.round(engine.musicVolume * 100)}`} />
          </div>
          <div className="subkeys one">
            <button className="cap sm" onClick={() => engine.setMusicMuted(!engine.musicMuted)}>
              <i className={`led green ${engine.musicMuted ? '' : 'on'}`} />{engine.musicMuted ? 'MUTED' : 'LISTEN'}
            </button>
          </div>
        </>
      )}
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
    <div className={`person ${names.length ? 'active' : ''}`}>
      <i className={`led green ${linked ? 'on' : ''}`} title={linked ? 'audio link up' : 'waiting for link'} />
      <div className="pname">{p.name}<em>{p.role}</em>
        {names.length > 0 && <div className="ptalk">▸ {names.join(', ')}</div>}
      </div>
      {rtt != null && <span className="rtt">{rtt}ms</span>}
      <button className="cap sm direct"
        onPointerDown={e => { (e.target as HTMLElement).setPointerCapture(e.pointerId); engine.press(target) }}
        onPointerUp={() => engine.release(target)}
        onPointerCancel={() => engine.release(target)}><i className={`led red ${direct ? 'on' : ''}`} />DIRECT</button>
    </div>
  )
}

// ── Controls ─────────────────────────────────────────────────────────────────
/** Rotary encoder: drag up/down (or wheel / arrow keys) to turn. `mini` is the per-key version. */
function Knob({ label, value, min, max, onChange, readout, mini }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void; readout: string; mini?: boolean
}) {
  const drag = useRef<{ y: number; v: number } | null>(null)
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)))
  const span = max - min
  const angle = -135 + ((value - min) / span) * 270
  const tick = (i: number) => {
    const a = ((-135 + (i / 10) * 270 - 90) * Math.PI) / 180
    return { x1: 32 + Math.cos(a) * 26, y1: 32 + Math.sin(a) * 26, x2: 32 + Math.cos(a) * 30, y2: 32 + Math.sin(a) * 30 }
  }
  const size = mini ? 44 : 58
  return (
    <div className={`knob ${mini ? 'mini' : ''}`} role="slider" tabIndex={0} aria-label={label} title={`${label}: ${readout}`}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={+value.toFixed(2)}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, v: value } }}
      onPointerMove={e => { if (drag.current) set(drag.current.v + ((drag.current.y - e.clientY) / 140) * span) }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
      onWheel={e => set(value - Math.sign(e.deltaY) * (span / 40))}
      onKeyDown={e => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); set(value + span / 20) }
        if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); set(value - span / 20) }
      }}>
      <svg viewBox="0 0 64 64" width={size} height={size}>
        {Array.from({ length: 11 }, (_, i) => <line key={i} {...tick(i)} className={i / 10 <= (value - min) / span + 0.001 ? 'tk on' : 'tk'} />)}
        <circle cx="32" cy="32" r="21" className="kbody" />
        <circle cx="32" cy="32" r="16" className="kcap" />
        <line x1="32" y1="32" x2="32" y2="18" className="kind" transform={`rotate(${angle} 32 32)`} />
      </svg>
      {!mini && <><div className="kname">{label}</div><div className="kread">{readout}</div></>}
    </div>
  )
}

/** Segmented LED level bar for the microphone or the program feed. */
function LedMeter({ engine, source }: { engine: CommsEngine; source: 'mic' | 'program' | 'music' }) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const level = source === 'mic' ? engine.micLevel() : source === 'music' ? engine.musicSendLevel() : engine.programLevel()
      if (bar.current) bar.current.style.width = `${Math.round(level * 100)}%`
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [engine, source])
  return <div className="ledmeter"><div ref={bar} /></div>
}

function StatusPill({ engine }: { engine: CommsEngine }) {
  const s = engine.status
  const label = s === 'connected' ? `Connected · ${engine.media.toUpperCase()}` : s === 'reconnecting' ? 'Reconnecting…' : s === 'connecting' ? 'Connecting…' : s === 'error' ? 'Error' : 'Offline'
  return <span className={`pill ${s}`}>{label}</span>
}

function Settings({ engine, prefs, patch, devices, onClose }: {
  engine: CommsEngine; prefs: Prefs; patch: (p: Partial<Prefs>) => void; devices: MediaDeviceInfo[]; onClose: () => void
}) {
  const mics = devices.filter(d => d.kind === 'audioinput')
  const spks = devices.filter(d => d.kind === 'audiooutput')
  return (
    <div className="drawer">
      <div className="drawer-head"><h2 className="lcd">Audio</h2><button className="btn ghost" onClick={onClose}>Close</button></div>
      <label>Microphone
        <select value={prefs.micId} onChange={e => { patch({ micId: e.target.value }); void engine.setMic(e.target.value, prefs.echoCancel) }}>
          <option value="">System default</option>
          {mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
        </select>
      </label>
      <label>Speaker / headset
        <select value={prefs.spkId} disabled={!canPickSpeaker} onChange={e => { patch({ spkId: e.target.value }); engine.setSpeaker(e.target.value) }}>
          <option value="">System default</option>
          {spks.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
        </select>
        {!canPickSpeaker && <span className="muted">This browser can only use the system default output. Use Chrome or the desktop app to pick one.</span>}
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
      <label className="check" title="Your microphone is only open while you are talking. The first press after idle starts the mic, so the very first syllable can be clipped.">
        <input type="checkbox" checked={prefs.micRelease} onChange={e => patch({ micRelease: e.target.checked })} />
        Only use the microphone while I am talking
      </label>
      <fieldset className="look">
        <legend>Arena alerts</legend>
        <label className="check"><input type="checkbox" checked={prefs.speakAlerts} onChange={e => patch({ speakAlerts: e.target.checked })} />Speak stream alerts ("Camera 2 feed lost")</label>
        <label className="check"><input type="checkbox" checked={prefs.alertTones} onChange={e => patch({ alertTones: e.target.checked })} />Play alert tones</label>
      </fieldset>
      <fieldset className="look">
        <legend>Spatial audio</legend>
        <label className="check"><input type="checkbox" checked={prefs.spatial} onChange={e => patch({ spatial: e.target.checked })} />Place each channel in the stereo field (best with headphones)</label>
        {prefs.spatial && <>
          <label>Spread: {Math.round(prefs.spread * 100)}%
            <input type="range" min={0.2} max={1} step={0.05} value={prefs.spread} onChange={e => patch({ spread: +e.target.value })} />
          </label>
          {engine.channels.map(c => (
            <label key={c.id} className="panrow">
              <span><i className="swatch-dot" style={{ background: c.color }} />{c.name}</span>
              <input type="range" min={-1} max={1} step={0.05} value={prefs.pans[c.id] ?? engine.autoPan(c.id)}
                onChange={e => patch({ pans: { ...prefs.pans, [c.id]: +e.target.value } })} aria-label={`${c.name} position`} />
            </label>
          ))}
          <button type="button" className="btn sm" onClick={() => patch({ pans: {} })}>Reset positions</button>
        </>}
      </fieldset>
      <fieldset className="look">
        <legend>Panel look</legend>
        <label>Key size
          <select value={prefs.density} onChange={e => patch({ density: e.target.value as Prefs['density'] })}>
            <option value="compact">Compact (more keys)</option>
            <option value="comfortable">Comfortable (bigger keys)</option>
          </select>
        </label>
        <label>Display colour
          <div className="swatches">
            {(Object.keys(LCD_COLORS) as (keyof typeof LCD_COLORS)[]).map(k => (
              <button key={k} type="button" className={`swatch ${prefs.lcdColor === k ? 'on' : ''}`} title={k}
                style={{ ['--sw' as string]: LCD_COLORS[k][0] }} onClick={() => patch({ lcdColor: k })} />
            ))}
          </div>
        </label>
        <label>Display brightness
          <input type="range" min={0.3} max={1} step={0.05} value={prefs.lcdBright} onChange={e => patch({ lcdBright: +e.target.value })} />
        </label>
        <label className="check"><input type="checkbox" checked={prefs.night} onChange={e => patch({ night: e.target.checked })} />Night mode (dim the whole panel)</label>
      </fieldset>
      <p className="muted small">Keys 1–9 hold-to-talk on that channel. LATCH keeps a channel open hands-free.</p>
    </div>
  )
}
