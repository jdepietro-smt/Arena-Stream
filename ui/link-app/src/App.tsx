import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { VideoTile, FrameData } from './VideoTile'

const link = (window as any).link

// ── Types ────────────────────────────────────────────────────────────────────
type Mode = 'encoder' | 'decoder'

interface Config {
  mode: Mode
  directory: string
  key: string
  relayHost: string
  relaySecret: string
  enc: { name: string; device: string; codec: 'gpu' | 'cpu'; bitrate: number; audio: boolean; remote: boolean; relayLatency: number }
  dec: { output: string; lanLatency: number; relayLatency: number; selected: string; monitorAudio: boolean }
}

interface Card { index: number; device: number; channel: number; name: string; backend: string }

interface DirEncoder {
  id: string; name: string; format: string; source?: string; codec: string; kbps: number
  path: 'lan' | 'relay' | 'unreachable'
}
interface DirState { ok: boolean; error?: string; yourIp?: string; encoders: DirEncoder[] }

interface EncStats {
  name: string; format: string; source: string; fps: number; kbps: number
  viewers: number; relayUp: boolean; relayRttMs: number; capDrops: number; directory: 'ok' | 'failed' | 'off'
}
interface DecState { state: string; encoder?: string; path?: string; note?: string }
interface DecStats {
  rttMs: number; bitrateKbps: number; pktLoss: number; pktDrop: number; decodedFps: number
  rxMs: number; g2gMs: number; g2gMaxMs: number; decodeMs: number; outMs: number; skipped: number
  decoder?: string; format: string
}

const TEST_PATTERNS = [
  { value: 'test:1080i5994', label: 'Test pattern - 1080i59.94' },
  { value: 'test:1080p5994', label: 'Test pattern - 1080p59.94' },
  { value: 'test:720p60',    label: 'Test pattern - 720p60' },
]
const BITRATES = [4000, 6000, 8000, 10000, 15000, 20000, 30000]

// Target: camera-to-decode no more than 350 ms (hard ceiling 500).
function delayClass(ms: number) { return ms <= 350 ? 'ok' : ms <= 500 ? 'warn' : 'bad' }
const f0 = (n: number) => (Number.isFinite(n) ? Math.round(n).toString() : '-')

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [config, setConfigState] = useState<Config | null>(null)
  const [dir, setDir] = useState<DirState>({ ok: false, error: 'connecting...', encoders: [] })
  const [logs, setLogs] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    link.getConfig().then((c: Config) => { setConfigState(c); if (!c.key) setShowSettings(true) })
    const offs = [
      link.onLog((l: string) => setLogs(p => [...p.slice(-300), l])),
      link.onDirectory((d: DirState) => setDir(d)),
    ]
    return () => offs.forEach((f: () => void) => f())
  }, [])

  const setConfig = useCallback((fn: (c: Config) => Config) => {
    setConfigState(prev => {
      if (!prev) return prev
      const next = fn(prev)
      link.setConfig(next)
      return next
    })
  }, [])

  if (!config) return <div className="app" />

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-left">
          <img src="./logo.png" className="logo" alt="" />
          <span className="brand">ARENA LINK</span>
          <div className="seg">
            {(['encoder', 'decoder'] as Mode[]).map(m => (
              <button key={m} className={config.mode === m ? 'on' : ''}
                      onClick={() => setConfig(c => ({ ...c, mode: m }))}>{m.toUpperCase()}</button>
            ))}
          </div>
        </div>
        <div className="titlebar-right">
          <span className={`led ${dir.ok ? 'green' : 'red'}`} title={dir.ok ? 'directory connected' : dir.error} />
          <span className="muted small">{dir.ok ? `${dir.encoders.length} on air` : 'no directory'}</span>
          <button className="btn small" onClick={() => setShowLog(s => !s)}>{showLog ? 'HIDE LOG' : 'LOG'}</button>
          <button className="btn small" onClick={() => setShowSettings(true)}>SETTINGS</button>
        </div>
      </div>

      {!dir.ok && <div className="banner bad">Directory: {dir.error}. Check Settings.</div>}

      <div className="main">
        {config.mode === 'encoder'
          ? <EncoderView config={config} setConfig={setConfig} logs={logs} dir={dir} />
          : <DecoderView config={config} setConfig={setConfig} dir={dir} logs={logs} />}
      </div>

      {showLog && (
        <div className="logdrawer">
          {logs.slice(-120).map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {showSettings && <Settings config={config} setConfig={setConfig} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

// ── Encoder ──────────────────────────────────────────────────────────────────
function EncoderView({ config, setConfig, logs, dir }: {
  config: Config; setConfig: (fn: (c: Config) => Config) => void; logs: string[]; dir: DirState
}) {
  const e = config.enc
  const [cards, setCards] = useState<Card[]>([])
  const [scanning, setScanning] = useState(true)
  const [live, setLive] = useState(false)
  const [stats, setStats] = useState<EncStats | null>(null)
  const [msg, setMsg] = useState('')
  const lastStat = useRef(0)

  const scan = useCallback(async () => {
    setScanning(true)
    const list: Card[] = await link.scanCapture()
    setCards(list)
    setScanning(false)
    setConfig(c => c.enc.device ? c : { ...c, enc: { ...c.enc, device: list.length ? `${list[0].backend}:${list[0].device}:${list[0].channel}` : TEST_PATTERNS[0].value } })
  }, [setConfig])

  useEffect(() => {
    scan()
    const offs = [
      link.onEncoderStats((s: EncStats) => { setStats(s); setLive(true); setMsg(''); lastStat.current = Date.now() }),
      link.onEncoderExit((x: { code: number | null; retrying: boolean }) => {
        setLive(false); setStats(null)
        setMsg(x.retrying ? 'The encoder stopped unexpectedly - restarting...' : x.code === 0 ? '' : 'The encoder could not start. Check the input signal and that no other program is using the card (see LOG).')
      }),
    ]
    return () => offs.forEach((f: () => void) => f())
  }, [scan])

  // Stats stop arriving if the process hangs: show it rather than a frozen "live".
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t) }, [])
  const stale = live && Date.now() - lastStat.current > 4000

  const set = (patch: Partial<Config['enc']>) => setConfig(c => ({ ...c, enc: { ...c.enc, ...patch } }))

  async function go() {
    if (live) { await link.encoderStop(); setLive(false); setStats(null); return }
    setMsg('')
    const r = await link.encoderStart()
    if (!r.ok) setMsg(r.error)
    else setMsg('Starting - waiting for the signal...')
  }

  const onAirHere = dir.encoders.some(x => x.name.toLowerCase() === e.name.trim().toLowerCase())
  const dirState = !stats ? '-' : stats.directory === 'ok' ? 'announced' : stats.directory === 'failed' ? 'failing' : 'off'

  return (
    <div className="cols">
      <section className="card">
        <h2>Input</h2>
        <label>Name <span className="hint">shown to every decoder</span>
          <input value={e.name} disabled={live} placeholder="e.g. Truck 1 - Camera 2" maxLength={48}
                 onChange={ev => set({ name: ev.target.value })} />
        </label>
        <label>Signal
          <div className="row">
            <select value={e.device} disabled={live} onChange={ev => set({ device: ev.target.value })}>
              {cards.length > 0 && <optgroup label="Capture cards">
                {cards.map(c => <option key={c.index} value={`${c.backend}:${c.device}:${c.channel}`}>{c.name}</option>)}
              </optgroup>}
              <optgroup label="No hardware">
                {TEST_PATTERNS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </optgroup>
            </select>
            <button className="btn small" disabled={live || scanning} onClick={scan}>{scanning ? '...' : 'RESCAN'}</button>
          </div>
        </label>

        <h2>Quality</h2>
        <div className="row two">
          <label>Encoder
            <select value={e.codec} disabled={live} onChange={ev => set({ codec: ev.target.value as 'gpu' | 'cpu' })}>
              <option value="gpu">GPU (NVENC)</option>
              <option value="cpu">CPU (x264)</option>
            </select>
          </label>
          <label>Bitrate <span className="hint">{live ? 'changes live' : ''}</span>
            <select value={e.bitrate} onChange={ev => { const k = Number(ev.target.value); set({ bitrate: k }); if (live) link.encoderBitrate(k) }}>
              {BITRATES.map(b => <option key={b} value={b}>{b / 1000} Mbps</option>)}
            </select>
          </label>
        </div>
        <label className="check"><input type="checkbox" checked={e.audio} disabled={live} onChange={ev => set({ audio: ev.target.checked })} /> Embedded audio</label>

        <h2>Reach</h2>
        <p className="muted small">Decoders on this network connect directly. Remote decoders connect through the relay.</p>
        <label className="check"><input type="checkbox" checked={e.remote} disabled={live} onChange={ev => set({ remote: ev.target.checked })} /> Allow remote decoders (internet)</label>
        {e.remote && (
          <label>Internet buffer <span className="hint">more = fewer glitches, more delay</span>
            <select value={e.relayLatency} disabled={live} onChange={ev => set({ relayLatency: Number(ev.target.value) })}>
              {[80, 100, 120, 160, 200].map(v => <option key={v} value={v}>{v} ms</option>)}
            </select>
          </label>
        )}

        <button className={`golive ${live ? 'stop' : ''}`} onClick={go}>{live ? 'STOP' : 'GO LIVE'}</button>
        {msg && <div className="note">{msg}</div>}
      </section>

      <section className="card grow">
        <h2>Status <span className={`pill ${stale ? 'bad' : live && stats ? 'ok' : ''}`}>{stale ? 'NOT RESPONDING' : live && stats ? 'ON AIR' : live ? 'STARTING' : 'OFF AIR'}</span></h2>
        <div className="tiles">
          <Tile label="Source" value={stats?.source || '-'} small />
          <Tile label="Sending" value={stats?.format || '-'} small />
          <Tile label="Frame rate" value={stats ? stats.fps.toFixed(1) : '-'} unit="fps" />
          <Tile label="Bitrate" value={stats ? (stats.kbps / 1000).toFixed(1) : '-'} unit="Mbps" />
          <Tile label="Viewers on LAN" value={stats ? String(stats.viewers) : '-'} />
          <Tile label="Relay" value={!stats || !e.remote ? '-' : stats.relayUp ? 'connected' : 'connecting'} cls={stats && e.remote ? (stats.relayUp ? 'ok' : 'warn') : ''}
                sub={stats?.relayUp && stats.relayRttMs > 0 ? `${f0(stats.relayRttMs)} ms to server` : ''} />
          <Tile label="Directory" value={dirState} cls={stats ? (stats.directory === 'ok' ? 'ok' : 'bad') : ''}
                sub={stats && stats.directory === 'ok' ? (onAirHere ? 'visible to decoders' : '') : ''} />
          <Tile label="Dropped frames" value={stats ? String(stats.capDrops) : '-'} cls={stats && stats.capDrops > 10 ? 'warn' : ''} />
        </div>
        {stats && stats.source.includes('i@') && (
          <p className="muted small">The source is interlaced. It is sent as {stats.format} so motion stays smooth; this adds about one frame of delay.</p>
        )}
        <Report getText={() => encoderReport(config, stats, dir, logs)} />
      </section>
    </div>
  )
}

// ── Decoder ──────────────────────────────────────────────────────────────────
function DecoderView({ config, setConfig, dir, logs }: {
  config: Config; setConfig: (fn: (c: Config) => Config) => void; dir: DirState; logs: string[]
}) {
  const d = config.dec
  const [outputs, setOutputs] = useState<Card[]>([])
  const [state, setState] = useState<DecState>({ state: 'stopped' })
  const [stats, setStats] = useState<DecStats | null>(null)
  const [running, setRunning] = useState(false)
  const framesRef = useRef<Record<string, FrameData>>({})
  const audioCtx = useRef<AudioContext | null>(null)
  const nextPlay = useRef(0)
  const monitor = useRef(d.monitorAudio)
  monitor.current = d.monitorAudio

  useEffect(() => {
    link.scanOutput().then((l: Card[]) => setOutputs(l))
    const offs = [
      link.onDecoderState((s: DecState) => {
        setState(s)
        if (s.state !== 'live') { setStats(null); delete framesRef.current.main }
        if (s.state === 'stopped') setRunning(false)
      }),
      link.onDecoderStats((s: DecStats) => setStats(s)),
      link.onPreviewYuv((w: number, h: number, data: Uint8Array) => { framesRef.current.main = { w, h, data: new Uint8Array(data) } }),
      link.onPreviewAudio((rate: number, ch: number, data: Uint8Array) => { if (monitor.current) playPcm(rate, ch, data) }),
    ]
    return () => offs.forEach((f: () => void) => f())
  }, [])

  function playPcm(rate: number, ch: number, data: Uint8Array) {
    const ctx = audioCtx.current ?? (audioCtx.current = new AudioContext({ sampleRate: rate }))
    const n = Math.floor(data.byteLength / 4 / ch)
    if (n <= 0) return
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const buf = ctx.createBuffer(ch, n, rate)
    for (let c = 0; c < ch; c++) {
      const out = buf.getChannelData(c)
      for (let i = 0; i < n; i++) out[i] = view.getInt32((i * ch + c) * 4, true) / 0x80000000
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const at = Math.max(nextPlay.current, ctx.currentTime)
    src.start(at)
    nextPlay.current = at + n / rate
  }

  function toggleAudio(on: boolean) {   // AudioContext must be created inside a user gesture
    if (on) {
      if (!audioCtx.current) audioCtx.current = new AudioContext({ sampleRate: 48000 })
      audioCtx.current.resume()
      nextPlay.current = audioCtx.current.currentTime
    }
    setConfig(c => ({ ...c, dec: { ...c.dec, monitorAudio: on } }))
  }

  async function connect(name: string) {
    setConfig(c => ({ ...c, dec: { ...c.dec, selected: name } }))
    if (running) { await link.decoderSelect(name); return }
    const r = await link.decoderStart(name)
    if (r.ok) setRunning(true)
  }
  async function disconnect() { await link.decoderStop(); setRunning(false); setState({ state: 'stopped' }); setStats(null); delete framesRef.current.main }
  async function setOutput(value: string) {
    setConfig(c => ({ ...c, dec: { ...c.dec, output: value } }))
    if (running) { await link.decoderStop(); setTimeout(async () => { await link.decoderStart(d.selected); }, 700) }
  }
  async function setLatency(patch: Partial<Config['dec']>) {
    setConfig(c => ({ ...c, dec: { ...c.dec, ...patch } }))
    if (running) { await link.decoderStop(); setTimeout(async () => { await link.decoderStart(d.selected) }, 700) }
  }

  const live = state.state === 'live'
  const g2g = stats?.g2gMs ?? -1
  const stateText = ({
    live: `Live from ${state.encoder} (${state.path === 'lan' ? 'direct on this network' : 'via relay'})`,
    connecting: `Connecting to ${state.encoder} (${state.path === 'lan' ? 'direct' : 'relay'})...`,
    waiting: state.note || 'Waiting...',
    ended: `${state.encoder} stopped - waiting for it to come back`,
    failed: `Could not connect to ${state.encoder} by ${state.path} - trying the next path`,
    stopped: 'Not connected',
  } as Record<string, string>)[state.state] ?? state.state

  return (
    <div className="cols">
      <section className="card list">
        <h2>On air</h2>
        {dir.ok && dir.encoders.length === 0 && <p className="muted">No encoders are on air. They appear here the moment one goes live.</p>}
        {dir.encoders.map(en => {
          const sel = d.selected.toLowerCase() === en.name.toLowerCase() && running
          return (
            <button key={en.id} className={`enc ${sel ? 'sel' : ''}`} disabled={en.path === 'unreachable'}
                    onClick={() => connect(en.name)}>
              <span className="encname">{en.name}</span>
              <span className={`badge ${en.path}`}>{en.path === 'lan' ? 'LAN' : en.path === 'relay' ? 'INTERNET' : 'NO PATH'}</span>
              <span className="encsub">{en.format} - {(en.kbps / 1000).toFixed(0)} Mbps - {en.codec.replace('_nvenc', '')}</span>
            </button>
          )
        })}
        <h2>Output</h2>
        <label>
          <select value={d.output} onChange={ev => setOutput(ev.target.value)}>
            <option value="preview">Preview only (no SDI)</option>
            {outputs.map(o => <option key={o.index} value={`${o.backend}:${o.device}:${o.channel}`}>{o.name}</option>)}
          </select>
        </label>
        <div className="row two">
          <label>LAN buffer
            <select value={d.lanLatency} onChange={ev => setLatency({ lanLatency: Number(ev.target.value) })}>
              {[20, 40, 60, 100].map(v => <option key={v} value={v}>{v} ms</option>)}
            </select>
          </label>
          <label>Internet buffer
            <select value={d.relayLatency} onChange={ev => setLatency({ relayLatency: Number(ev.target.value) })}>
              {[80, 100, 120, 160, 200].map(v => <option key={v} value={v}>{v} ms</option>)}
            </select>
          </label>
        </div>
        <label className="check"><input type="checkbox" checked={d.monitorAudio} onChange={ev => toggleAudio(ev.target.checked)} /> Monitor audio on this PC</label>
        {running && <button className="btn" onClick={disconnect}>DISCONNECT</button>}
      </section>

      <section className="card grow">
        <h2>Picture <span className={`pill ${live ? 'ok' : ''}`}>{live ? 'LIVE' : 'NO SIGNAL'}</span></h2>
        <div className="preview"><VideoTile id="main" framesRef={framesRef} />{!live && <div className="overlay">{stateText}</div>}</div>
        <div className="statusline">{stateText}</div>
        <div className="tiles">
          <Tile label="Delay" value={live && g2g >= 0 ? f0(g2g) : '-'} unit="ms" cls={live && g2g >= 0 ? delayClass(g2g) : ''}
                sub="camera to decoded - needs both PCs' clocks in sync" />
          <Tile label="Network + buffer" value={live && stats && stats.rxMs >= 0 ? f0(stats.rxMs) : '-'} unit="ms" sub="until the frame arrives" />
          <Tile label="Decode" value={live && stats ? stats.decodeMs.toFixed(1) : '-'} unit="ms" cls={stats && stats.decodeMs > 14 ? 'warn' : ''} sub={stats?.decoder ?? ''} />
          <Tile label="Frame rate" value={live && stats ? String(stats.decodedFps) : '-'} unit="fps" sub={stats?.format ?? ''} />
          <Tile label="Bitrate" value={live && stats ? (stats.bitrateKbps / 1000).toFixed(1) : '-'} unit="Mbps" />
          <Tile label="Packets lost" value={live && stats ? String(stats.pktLoss) : '-'} sub={stats && stats.pktDrop ? `${stats.pktDrop} dropped late` : ''} />
          <Tile label="Round trip" value={live && stats && stats.rttMs > 0 ? f0(stats.rttMs) : '-'} unit="ms" />
          <Tile label="Frames skipped" value={live && stats ? String(stats.skipped) : '-'} cls={stats && stats.skipped > 0 ? 'warn' : ''} sub="catching up" />
        </div>
        <Report getText={() => decoderReport(config, state, stats, dir, logs)} />
      </section>
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function Tile({ label, value, unit, sub, cls, small }: { label: string; value: string; unit?: string; sub?: string; cls?: string; small?: boolean }) {
  return (
    <div className={`tile ${cls ?? ''} ${small ? 'small' : ''}`}>
      <div className="tlabel">{label}</div>
      <div className="tvalue">{value}{unit && value !== '-' && <span className="tunit"> {unit}</span>}</div>
      {sub ? <div className="tsub">{sub}</div> : null}
    </div>
  )
}

function Report({ getText }: { getText: () => string }) {
  const [done, setDone] = useState(false)
  return (
    <button className="btn small report" onClick={async () => {
      try { await navigator.clipboard.writeText(getText()); setDone(true); setTimeout(() => setDone(false), 2000) } catch { /* clipboard blocked */ }
    }}>{done ? 'COPIED' : 'COPY REPORT'}</button>
  )
}

function safeConfig(c: Config) {   // never put secrets in a report
  return { ...c, key: c.key ? '(set)' : '(empty)', relaySecret: c.relaySecret ? '(set)' : '(empty)' }
}

function encoderReport(c: Config, s: EncStats | null, dir: DirState, logs: string[]) {
  return ['ARENA LINK - ENCODER REPORT', new Date().toISOString(),
    `config: ${JSON.stringify(safeConfig(c))}`, `stats: ${JSON.stringify(s)}`,
    `directory: ${JSON.stringify({ ok: dir.ok, error: dir.error, yourIp: dir.yourIp, onAir: dir.encoders.map(e => `${e.name}[${e.path}]`) })}`,
    '--- log ---', ...logs.slice(-40)].join('\n')
}
function decoderReport(c: Config, st: DecState, s: DecStats | null, dir: DirState, logs: string[]) {
  return ['ARENA LINK - DECODER REPORT', new Date().toISOString(),
    `config: ${JSON.stringify(safeConfig(c))}`, `state: ${JSON.stringify(st)}`, `stats: ${JSON.stringify(s)}`,
    `directory: ${JSON.stringify({ ok: dir.ok, error: dir.error, yourIp: dir.yourIp, onAir: dir.encoders.map(e => `${e.name}[${e.path}]`) })}`,
    '--- log ---', ...logs.slice(-40)].join('\n')
}

// ── Settings ─────────────────────────────────────────────────────────────────
function Settings({ config, setConfig, onClose }: { config: Config; setConfig: (fn: (c: Config) => Config) => void; onClose: () => void }) {
  const [directory, setDirectory] = useState(config.directory)
  const [key, setKey] = useState(config.key)
  const [relayHost, setRelayHost] = useState(config.relayHost)
  const [relaySecret, setRelaySecret] = useState(config.relaySecret)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function test() { setResult(null); setResult(await link.testDirectory(directory, key)) }
  function save() { setConfig(c => ({ ...c, directory: directory.trim(), key: key.trim(), relayHost: relayHost.trim(), relaySecret: relaySecret.trim() })); onClose() }

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog" onClick={ev => ev.stopPropagation()}>
        <h2>Connection</h2>
        <p className="muted small">Set once per PC. Every encoder and decoder that uses the same directory sees each other automatically.</p>
        <label>Directory address<input value={directory} onChange={e => setDirectory(e.target.value)} placeholder="http://server:8002" /></label>
        <label>Access key<input type="password" value={key} onChange={e => setKey(e.target.value)} /></label>
        <label>Relay server <span className="hint">for decoders on other networks</span><input value={relayHost} onChange={e => setRelayHost(e.target.value)} placeholder="server IP address" /></label>
        <label>Relay password <span className="hint">encoders only</span><input type="password" value={relaySecret} onChange={e => setRelaySecret(e.target.value)} /></label>
        <div className="row">
          <button className="btn" onClick={test}>TEST</button>
          {result && <span className={`result ${result.ok ? 'ok' : 'bad'}`}>{result.message}</span>}
        </div>
        <div className="row end">
          <button className="btn" onClick={onClose}>CANCEL</button>
          <button className="btn primary" onClick={save}>SAVE</button>
        </div>
      </div>
    </div>
  )
}
