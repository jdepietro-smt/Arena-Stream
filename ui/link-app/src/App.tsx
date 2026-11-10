import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { VideoTile, FrameData } from './VideoTile'

const link = (window as any).link

// ── Types ────────────────────────────────────────────────────────────────────
type Mode = 'encoder' | 'decoder'

type Quality = 'low' | 'balanced' | 'max'
interface QRow { quality: Quality; encoder: string; target_kbps: number; frames: number; psnr: number; psnr_c: number; ssim: number; ssim_min: number; kbps: number; max_kb: number; enc_ms: number; enc_ms_p95: number; dec_ms: number }
const QUALITY_LABEL: Record<Quality, string> = { low: 'Lowest delay', balanced: 'Balanced', max: 'Best picture' }
interface StreamCfg { id: string; name: string; device: string; video: 'h264' | 'h265'; codec: 'gpu' | 'cpu'; quality: Quality; adapt: boolean; deinterlace?: boolean; bitrate: number; audio: boolean; remote: boolean; relayLatency: number; port: number }

interface DecCfg { id: string; output: string; outLevels: 'standard' | 'full' | 'soft'; whiteLevel: number; lanLatency: number; relayLatency: number; selected: string; monitorAudio: boolean }
interface Config {
  mode: Mode
  directory: string
  key: string
  relayHost: string
  relaySecret: string
  streams: StreamCfg[]
  decs: DecCfg[]
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
  lossPct?: number; targetKbps?: number; adapt?: boolean; warn?: string
  relayLatencyMs?: number; relayAuto?: boolean; relayProbeMs?: number
}
interface DecState { state: string; encoder?: string; path?: string; note?: string; latencyMs?: number; probeMs?: number }
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
          <span className="muted small">{dir.ok ? `${dir.encoders.length} on air` : dir.encoders.length ? `${dir.encoders.length} on this network` : 'no directory'}</span>
          <button className="btn small" onClick={() => setShowLog(s => !s)}>{showLog ? 'HIDE LOG' : 'LOG'}</button>
          <button className="btn small" onClick={() => setShowSettings(true)}>SETTINGS</button>
        </div>
      </div>

      {!dir.ok && dir.encoders.length > 0 && <div className="banner">Internet directory unreachable ({dir.error}). Showing the encoders found on this network.</div>}
      {!dir.ok && dir.encoders.length === 0 && <div className="banner bad">Directory: {dir.error}. Check Settings.</div>}

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
const cardValue = (c: Card) => `${c.backend}:${c.device}:${c.channel}`

// First input no other stream is using (cards first, then the test patterns).
function freeDevice(cards: Card[], streams: StreamCfg[], except?: string): string {
  const used = new Set(streams.filter(s => s.id !== except).map(s => s.device))
  const all = [...cards.map(cardValue), ...TEST_PATTERNS.map(t => t.value)]
  return all.find(v => !used.has(v)) ?? TEST_PATTERNS[0].value
}

function EncoderView({ config, setConfig, logs, dir }: {
  config: Config; setConfig: (fn: (c: Config) => Config) => void; logs: string[]; dir: DirState
}) {
  const streams = config.streams
  const [cards, setCards] = useState<Card[]>([])
  const [scanning, setScanning] = useState(true)

  const scan = useCallback(async () => {
    setScanning(true)
    const list: Card[] = await link.scanCapture()
    setCards(list)
    setScanning(false)
    // Streams that have no input yet get the first one nobody else is using.
    setConfig(c => c.streams.every(s => s.device) ? c
      : { ...c, streams: c.streams.reduce<StreamCfg[]>((acc, s) => [...acc, s.device ? s : { ...s, device: freeDevice(list, [...acc, ...c.streams.slice(acc.length + 1)], s.id) }], []) })
  }, [setConfig])
  useEffect(() => { scan() }, [scan])

  function addStream() {
    setConfig(c => {
      const ports = new Set(c.streams.map(s => s.port))
      let port = 4200; while (ports.has(port)) port++
      const id = `s${Date.now().toString(36)}`
      setSel(id)
      return { ...c, streams: [...c.streams, { id, name: '', device: freeDevice(cards, c.streams), video: 'h264', codec: 'gpu', quality: 'balanced', adapt: true, bitrate: 10000, audio: true, remote: true, relayLatency: 0, port }] }
    })
  }

  // One stream is shown at a time; the others stay mounted (hidden) so they keep running and reporting.
  const [sel, setSel] = useState(streams[0]?.id ?? '')
  const [lives, setLives] = useState<Record<string, boolean>>({})
  const current = streams.some(s => s.id === sel) ? sel : streams[0]?.id
  const tabName = (s: StreamCfg, i: number) => s.name.trim() || `Stream ${i + 1}`

  return (
    <div className="streams">
      <div className="tabs">
        {streams.map((s, i) => (
          <button key={s.id} className={`tab ${s.id === current ? 'on' : ''}`} onClick={() => setSel(s.id)}>
            <span className={`led ${lives[s.id] ? 'green' : ''}`} />{tabName(s, i)}
          </button>
        ))}
        <button className="tab add" onClick={addStream} title="Add another stream from this PC">+ ADD STREAM</button>
      </div>
      {streams.map((s, i) => (
        <div key={s.id} style={{ display: s.id === current ? undefined : 'none' }}>
          <StreamPanel stream={s} index={i} all={streams} cards={cards} scanning={scanning} onScan={scan}
                       canRemove={streams.length > 1} config={config} dir={dir} logs={logs}
                       onLive={v => setLives(m => m[s.id] === v ? m : { ...m, [s.id]: v })}
                       set={patch => setConfig(c => ({ ...c, streams: c.streams.map(x => x.id === s.id ? { ...x, ...patch } : x) }))}
                       remove={() => setConfig(c => ({ ...c, streams: c.streams.filter(x => x.id !== s.id) }))} />
        </div>
      ))}
    </div>
  )
}

function StreamPanel({ stream: e, index, all, cards, scanning, onScan, canRemove, config, dir, logs, set, remove, onLive }: {
  stream: StreamCfg; index: number; all: StreamCfg[]; cards: Card[]; scanning: boolean; onScan: () => void
  canRemove: boolean; config: Config; dir: DirState; logs: string[]
  set: (patch: Partial<StreamCfg>) => void; remove: () => void; onLive: (live: boolean) => void
}) {
  const [live, setLive] = useState(false)
  useEffect(() => { onLive(live) }, [live])   // eslint-disable-line react-hooks/exhaustive-deps
  const [stats, setStats] = useState<EncStats | null>(null)
  const [msg, setMsg] = useState('')
  const [pic, setPic] = useState('')
  const [draft, setDraft] = useState(e.name)
  const lastStat = useRef(0)
  const picNext = useRef<string | null>(null)
  const picRaf = useRef(0)
  const [qt, setQt] = useState<{ running: boolean; done: number; of: number; rows: QRow[]; info: string; error: string }>({ running: false, done: 0, of: 0, rows: [], info: '', error: '' })

  useEffect(() => { setDraft(e.name) }, [e.name])

  useEffect(() => link.onQualityTest((id: string, m: any) => {
    if (id !== e.id) return
    setQt(q => {
      if (m.type === 'qtest-start') return { ...q, running: true, of: m.runs, done: 0, rows: [], error: '', info: `${m.w}x${m.h}${m.interlaced ? 'i' : 'p'}${m.fps}` }
      if (m.type === 'qtest') return { ...q, rows: [...q.rows, m as QRow] }
      if (m.type === 'qtest-progress') return { ...q, done: m.done, of: m.of }
      if (m.type === 'qtest-end') return { ...q, running: false, error: q.rows.length ? '' : 'The test could not capture the input. Check the signal and that no other program is using the card.' }
      return q
    })
  }), [e.id])

  async function measure() {
    setQt({ running: true, done: 0, of: 0, rows: [], info: '', error: '' })
    const r = await link.qualityTest(e.id)
    if (!r.ok) setQt(q => ({ ...q, running: false, error: r.error }))
  }

  useEffect(() => {
    const offs = [
      link.onEncoderStats((id: string, s: EncStats) => { if (id !== e.id) return; setStats(s); setLive(true); setMsg(''); lastStat.current = Date.now() }),
      // Up to 60 pictures a second arrive: keep the newest and draw once per screen refresh.
      link.onEncoderPreview((id: string, jpg: string) => {
        if (id !== e.id) return
        if (!jpg) { picNext.current = null; setPic(''); return }
        picNext.current = jpg
        if (!picRaf.current) picRaf.current = requestAnimationFrame(() => { picRaf.current = 0; if (picNext.current) setPic(picNext.current) })
      }),
      link.onEncoderExit((id: string, x: { code: number | null; retrying: boolean }) => {
        if (id !== e.id) return
        setLive(false); setStats(null); setPic('')
        setMsg(x.retrying ? 'The encoder stopped unexpectedly - restarting...' : x.code === 0 ? '' : 'The encoder could not start. Check the input signal and that no other program is using the card (see LOG).')
      }),
    ]
    return () => offs.forEach((f: () => void) => f())
  }, [e.id])

  // Show the chosen input before going live; the input is handed to the encoder on GO LIVE
  // and taken back after STOP.
  useEffect(() => { if (!live && e.device) link.monitorStart(e.id, e.device) }, [live, e.device, e.id])
  useEffect(() => () => { link.monitorStop(e.id) }, [e.id])

  // Stats stop arriving if the process hangs: show it rather than a frozen "live".
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t) }, [])
  const stale = live && Date.now() - lastStat.current > 4000

  async function go() {
    if (live) { await link.encoderStop(e.id); setLive(false); setStats(null); return }
    setMsg('')
    const r = await link.encoderStart(e.id)
    if (!r.ok) setMsg(r.error)
    else setMsg('Starting - waiting for the signal...')
  }

  // The name is what decoders see. Renaming a live stream restarts it under the new name.
  function commitName() {
    const n = draft.trim()
    if (!n) { setDraft(e.name); return }
    if (n === e.name) return
    set({ name: n })
    if (live) { setMsg('Renaming - the stream restarts for a few seconds...'); setStats(null); link.encoderRestart(e.id) }
  }

  const clash = all.find(o => o.id !== e.id && o.name.trim().toLowerCase() === draft.trim().toLowerCase() && draft.trim())
  const used = new Map(all.filter(o => o.id !== e.id).map(o => [o.device, o.name.trim() || `stream ${all.indexOf(o) + 1}`]))
  const onAirHere = dir.encoders.some(x => x.name.toLowerCase() === e.name.trim().toLowerCase())
  const dirState = !stats ? '-' : stats.directory === 'ok' ? 'announced' : stats.directory === 'failed' ? 'failing' : 'off'
  const opt = (value: string, label: string) => {
    const by = used.get(value)
    return <option key={value} value={value} disabled={!!by}>{by ? `${label} (in use by ${by})` : label}</option>
  }

  return (
    <div className="stream">
      <div className="streamhead">
        <span />
        {canRemove && <button className="btn small" disabled={live} onClick={remove}>REMOVE THIS STREAM</button>}
      </div>
      <div className="cols">
        <section className="card">
          <h2>Input</h2>
          <label>Name <span className="hint">{live ? 'press Enter to rename (restarts this stream)' : 'shown to every decoder'}</span>
            <input value={draft} placeholder="e.g. Truck 1 - Camera 2" maxLength={48}
                   onChange={ev => setDraft(ev.target.value)} onBlur={commitName}
                   onKeyDown={ev => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur() }} />
          </label>
          {clash && <div className="note">Another stream is already called "{clash.name.trim()}". Pick a different name.</div>}
          <label>Signal
            <div className="row">
              <select value={e.device} disabled={live} onChange={ev => set({ device: ev.target.value })}>
                {cards.length > 0 && <optgroup label="Capture cards">
                  {cards.map(c => opt(cardValue(c), c.name))}
                </optgroup>}
                <optgroup label="No hardware">
                  {TEST_PATTERNS.map(t => opt(t.value, t.label))}
                </optgroup>
              </select>
              <button className="btn small" disabled={live || scanning} onClick={onScan}>{scanning ? '...' : 'RESCAN'}</button>
            </div>
          </label>

          <button className={`golive ${live ? 'stop' : ''}`} onClick={go}>{live ? 'STOP' : 'GO LIVE'}</button>
          {msg && <div className="note">{msg}</div>}

          <details className="adv">
          <summary>More settings (quality, bitrate, remote)</summary>
          <h2>Quality</h2>
          <div className="row two">
            <label>Video
              <select value={e.video} disabled={live} onChange={ev => set({ video: ev.target.value as 'h264' | 'h265' })}>
                <option value="h264">H.264</option>
                <option value="h265">H.265 (HEVC)</option>
              </select>
            </label>
            <label>Encoder
              <select value={e.codec} disabled={live} onChange={ev => set({ codec: ev.target.value as 'gpu' | 'cpu' })}>
                <option value="gpu">GPU (NVENC)</option>
                <option value="cpu">{e.video === 'h265' ? 'CPU (x265)' : 'CPU (x264)'}</option>
              </select>
            </label>
          </div>
          {e.video === 'h265' && e.codec === 'cpu' && <div className="note">H.265 on the CPU is very heavy. Use the GPU unless there is no NVENC.</div>}
          <div className="row two">
            <label>Bitrate <span className="hint">{live ? 'changes live' : ''}</span>
              <select value={e.bitrate} onChange={ev => { const k = Number(ev.target.value); set({ bitrate: k }); if (live) link.encoderBitrate(e.id, k) }}>
                {BITRATES.map(b => <option key={b} value={b}>{b / 1000} Mbps</option>)}
              </select>
            </label>
            <label>Picture quality <span className="hint">{live ? 'applies on next start' : 'more = sharper, a few ms more delay'}</span>
              <select value={e.quality} disabled={live} onChange={ev => set({ quality: ev.target.value as Quality })}>
                <option value="low">Lowest delay</option>
                <option value="balanced">Balanced (recommended)</option>
                <option value="max">Best picture</option>
              </select>
            </label>
          </div>
          <div className="qtest">
            <div className="row">
              <button className="btn small" disabled={live || !e.device || qt.running} onClick={measure}>
                {qt.running ? `MEASURING ${qt.done}/${qt.of || '...'}` : 'MEASURE QUALITY'}
              </button>
              {qt.running && <button className="btn small" onClick={() => link.qualityTestCancel()}>CANCEL</button>}
              <span className="hint">{live ? 'stop the stream to measure' : 'records 2 s of this input and scores every setting (about a minute)'}</span>
            </div>
            {qt.error && <div className="note">{qt.error}</div>}
            {qt.rows.length > 0 && (
              <>
                <table className="qtable">
                  <thead><tr><th>Setting</th><th>Mbps</th><th title="Average similarity to the picture sent to the encoder; 1.000 is identical">Sharpness</th><th title="Worst single frame - the hardest moment">Worst frame</th><th title="Time spent encoding + decoding one frame">Delay</th><th /></tr></thead>
                  <tbody>
                    {qt.rows.map((r, i) => {
                      const best = Math.max(...qt.rows.map(x => x.ssim_min))
                      return (
                        <tr key={i} className={r.ssim_min === best ? 'best' : ''}>
                          <td>{QUALITY_LABEL[r.quality]}</td>
                          <td>{(r.target_kbps / 1000).toFixed(0)}</td>
                          <td>{r.ssim.toFixed(3)}</td>
                          <td>{r.ssim_min.toFixed(3)}</td>
                          <td>{(r.enc_ms + r.dec_ms).toFixed(0)} ms</td>
                          <td><button className="btn small" disabled={live} onClick={() => set({ quality: r.quality, bitrate: r.target_kbps })}>USE</button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <p className="muted small">{qt.info} on {qt.rows[0].encoder.replace('_nvenc', ' (NVENC)')}. Sharpness 0.990 and above looks clean on a TV. "Worst frame" is the hardest moment in the clip, which is where a weak setting shows. Delay is encode plus decode time per frame; the highlighted row has the best worst frame.</p>
              </>
            )}
          </div>
          <label className="check"><input type="checkbox" checked={e.audio} disabled={live} onChange={ev => set({ audio: ev.target.checked })} /> Embedded audio</label>
          <label className="check"><input type="checkbox" checked={!!e.deinterlace} disabled={live} onChange={ev => set({ deinterlace: ev.target.checked })} /> Deinterlace and send as 60p <span className="hint">only affects interlaced sources; off = sent interlaced as-is</span></label>
          <label className="check"><input type="checkbox" checked={e.adapt !== false} disabled={live} onChange={ev => set({ adapt: ev.target.checked })} /> Lower the bitrate automatically if the network drops packets</label>

          <h2>Reach</h2>
          <p className="muted small">Decoders on this network connect directly. Remote decoders connect through the relay.</p>
          <label className="check"><input type="checkbox" checked={e.remote} disabled={live} onChange={ev => set({ remote: ev.target.checked })} /> Allow remote decoders (internet)</label>
          {e.remote && (
            <label>Upload buffer <span className="hint">{live && stats?.relayLatencyMs ? `using ${stats.relayLatencyMs} ms${stats.relayAuto && (stats.relayProbeMs ?? 0) > 0 ? ` (${stats.relayProbeMs} ms to the server)` : ''}` : 'this PC to the server - more = fewer glitches, more delay'}</span>
              <select value={e.relayLatency} disabled={live} onChange={ev => set({ relayLatency: Number(ev.target.value) })}>
                <option value={0}>Auto (from this PC's ping to the server)</option>
                {[60, 80, 100, 120, 160, 200, 300].map(v => <option key={v} value={v}>{v} ms</option>)}
              </select>
            </label>
          )}
          </details>
        </section>

        <section className="card grow">
          <h2>Status <span className={`pill ${stale ? 'bad' : live && stats ? 'ok' : ''}`}>{stale ? 'NOT RESPONDING' : live && stats ? 'ON AIR' : live ? 'STARTING' : 'OFF AIR'}</span></h2>
          <div className="preview monitor">
            {pic ? <img className="preview-canvas" src={`data:image/jpeg;base64,${pic}`} alt="Encoder monitor" />
                 : <div className="overlay">{live ? 'Waiting for the input signal...' : 'Reconnecting to the input...'}</div>}
          </div>
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
            <Tile label="Network loss" value={stats && stats.lossPct !== undefined ? stats.lossPct.toFixed(1) : '-'} unit="%" cls={stats && (stats.lossPct ?? 0) > 2 ? 'warn' : ''}
                  sub={stats && stats.targetKbps && stats.targetKbps < e.bitrate ? `sending ${(stats.targetKbps / 1000).toFixed(1)} of ${(e.bitrate / 1000).toFixed(0)} Mbps` : ''} />
          </div>
          {stats?.warn && <div className="note">{stats.warn}</div>}
          <Report getText={() => encoderReport(config, e.id, stats, dir, logs)} />
        </section>
      </div>
    </div>
  )
}

// ── Decoder ──────────────────────────────────────────────────────────────────
// Any number of decoders can run at once, each receiving its own encoder and driving its own output.
const DEC_DEFAULTS: Omit<DecCfg, 'id'> = { output: 'preview', outLevels: 'standard', whiteLevel: 100, lanLatency: 40, relayLatency: 0, selected: '', monitorAudio: false }

function DecoderView({ config, setConfig, dir, logs }: {
  config: Config; setConfig: (fn: (c: Config) => Config) => void; dir: DirState; logs: string[]
}) {
  const decs = config.decs
  const [outputs, setOutputs] = useState<Card[]>([])
  const [outputNote, setOutputNote] = useState('')
  const [scanningOut, setScanningOut] = useState(false)
  const scanOutputs = () => { setScanningOut(true); link.scanOutput().then((l: Card[]) => { setOutputs(l); link.outputNote().then(setOutputNote); setScanningOut(false) }) }
  useEffect(() => { scanOutputs() }, [])

  function addDecoder() {
    setConfig(c => {
      let n = c.decs.length + 1
      while (c.decs.some(x => x.id === `d${n}`)) n++
      // Starts on "Preview only": picking an SDI output is a deliberate step (on some PCs a card channel is an input).
      setSel(`d${n}`)
      return { ...c, decs: [...c.decs, { id: `d${n}`, ...DEC_DEFAULTS }] }
    })
  }

  // One decoder is shown at a time; the others stay mounted (hidden) so they keep running.
  const [sel, setSel] = useState(decs[0]?.id ?? '')
  const current = decs.some(x => x.id === sel) ? sel : decs[0]?.id

  return (
    <div className="streams">
      <div className="tabs">
        {decs.map((x, i) => (
          <button key={x.id} className={`tab ${x.id === current ? 'on' : ''}`} onClick={() => setSel(x.id)}>
            {x.selected ? x.selected : `Decoder ${i + 1}`}
          </button>
        ))}
        <button className="tab add" onClick={addDecoder} title="Add another decoder on this PC">+ ADD DECODER</button>
      </div>
      {decs.map((x, i) => (
        <div key={x.id} style={{ display: x.id === current ? undefined : 'none' }}>
          <DecoderPanel index={i} dec={x} all={decs} outputs={outputs} outputNote={outputNote} scanning={scanningOut} onScan={scanOutputs}
                        canRemove={decs.length > 1} config={config} dir={dir} logs={logs}
                        set={patch => setConfig(c => ({ ...c, decs: c.decs.map(y => y.id === x.id ? { ...y, ...patch } : y) }))}
                        remove={() => { link.decoderStop(x.id); setConfig(c => ({ ...c, decs: c.decs.filter(y => y.id !== x.id) })) }} />
        </div>
      ))}
    </div>
  )
}

function DecoderPanel({ dec: d, index, all, outputs, outputNote, scanning, onScan, canRemove, config, dir, logs, set, remove }: {
  dec: DecCfg; index: number; all: DecCfg[]; outputs: Card[]; outputNote: string; scanning: boolean; onScan: () => void
  canRemove: boolean; config: Config; dir: DirState; logs: string[]
  set: (patch: Partial<DecCfg>) => void; remove: () => void
}) {
  const [state, setState] = useState<DecState>({ state: 'stopped' })
  const [stats, setStats] = useState<DecStats | null>(null)
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState('')
  const framesRef = useRef<Record<string, FrameData>>({})
  const audioCtx = useRef<AudioContext | null>(null)
  const nextPlay = useRef(0)
  const remoteRef = useRef<(name: string) => void>(() => {})
  const monitor = useRef(d.monitorAudio)
  monitor.current = d.monitorAudio

  useEffect(() => {
    // Switching between Encoder and Decoder remounts this panel; the decoder itself kept running.
    // A decoder that already runs just reattaches. One that was left on a stream (saved in the
    // settings) connects by itself, so opening the app is enough - no need to re-pick the stream.
    link.decoderSync(d.id).then(async (s: DecState | null) => {
      if (s && s.state !== 'stopped') { setState(s); setRunning(true); return }
      if (!d.selected) return
      await new Promise(r => setTimeout(r, 400 * index))   // stagger several decoders
      const r = await link.decoderStart(d.id, d.selected)
      if (r.ok) setRunning(true); else setMsg(r.error)
    })
    const offs = [
      link.onDecoderState((id: string, s: DecState) => {
        if (id !== d.id) return
        setState(s)
        if (s.state !== 'live') { setStats(null); delete framesRef.current.main }
        if (s.state === 'stopped') setRunning(false)
      }),
      link.onDecoderStats((id: string, s: DecStats) => { if (id === d.id) setStats(s) }),
      link.onDecoderRemote((id: string, name: string) => { if (id === d.id) remoteRef.current(name) }),   // requested from the web portal
      link.onPreviewYuv((id: string, w: number, h: number, data: Uint8Array) => { if (id === d.id) framesRef.current.main = { w, h, data: new Uint8Array(data) } }),
      link.onPreviewAudio((id: string, rate: number, ch: number, data: Uint8Array) => { if (id === d.id && monitor.current) playPcm(rate, ch, data) }),
    ]
    return () => offs.forEach((f: () => void) => f())
  }, [d.id])

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
    set({ monitorAudio: on })
  }

  async function connect(name: string) {
    set({ selected: name })
    if (!name) { await disconnect(); return }
    setMsg('')
    if (running) { await link.decoderSelect(d.id, name); return }
    const r = await link.decoderStart(d.id, name)
    if (r.ok) setRunning(true); else setMsg(r.error)
  }
  remoteRef.current = connect
  async function disconnect() { await link.decoderStop(d.id); setRunning(false); setState({ state: 'stopped' }); setStats(null); delete framesRef.current.main }
  // Changing the output or a buffer restarts this decoder (and only this one).
  async function restartWith(patch: Partial<DecCfg>) {
    set(patch)
    if (running) { await link.decoderStop(d.id); setTimeout(async () => { const r = await link.decoderStart(d.id, d.selected); if (!r.ok) { setMsg(r.error); setRunning(false) } }, 700) }
  }

  const usedBy = new Map(all.filter(o => o.id !== d.id && o.output !== 'preview').map(o => [o.output, all.indexOf(o) + 1]))
  const live = state.state === 'live'
  const g2g = stats?.g2gMs ?? -1
  const stateText = ({
    live: `Live from ${state.encoder} (${state.path === 'lan' ? 'direct on this network' : 'via relay'}${state.latencyMs ? `, ${state.latencyMs} ms buffer` : ''})`,
    connecting: `Connecting to ${state.encoder} (${state.path === 'lan' ? 'direct' : 'relay'})...`,
    waiting: state.note || 'Waiting...',
    ended: `${state.encoder} stopped - waiting for it to come back`,
    failed: `Could not connect to ${state.encoder} by ${state.path} - trying the next path`,
    stopped: 'Not connected',
  } as Record<string, string>)[state.state] ?? state.state
  const known = dir.encoders.some(e => e.name.toLowerCase() === d.selected.toLowerCase())

  return (
    <div className="stream">
      <div className="streamhead">
        <span className="streamtitle">DECODER {index + 1}{d.selected ? ` - ${d.selected}` : ''}</span>
        {canRemove && <button className="btn small" onClick={remove}>REMOVE</button>}
      </div>
      <div className="cols">
        <section className="card list">
          {dir.encoders.length === 0 && <p className="muted small">No encoders are on air. They appear here the moment one goes live.</p>}
          <label>Encoder
            <select value={d.selected} onChange={ev => connect(ev.target.value)}>
              <option value="">{running ? 'Disconnect' : 'Choose an encoder...'}</option>
              {d.selected && !known && <option value={d.selected}>{d.selected} (not on air)</option>}
              {dir.encoders.map(en => (
                <option key={en.id} value={en.name} disabled={en.path === 'unreachable'}>
                  {en.name} - {en.path === 'lan' ? 'LAN' : en.path === 'relay' ? 'INTERNET' : 'NO PATH'} - {en.format}, {(en.kbps / 1000).toFixed(0)} Mbps, {en.codec.replace('_nvenc', '')}
                </option>
              ))}
            </select>
          </label>
          {msg && <div className="note">{msg}</div>}
          <label>Output
            <div className="row">
              <select value={d.output} onChange={ev => restartWith({ output: ev.target.value })}>
                <option value="preview">Preview only (no SDI)</option>
                {outputs.map(o => {
                  const v = `${o.backend}:${o.device}:${o.channel}`
                  const by = usedBy.get(v)
                  return <option key={o.index} value={v} disabled={!!by}>{by ? `${o.name} (in use by decoder ${by})` : o.name}</option>
                })}
              </select>
              <button className="btn small" disabled={scanning} onClick={onScan}>{scanning ? '...' : 'RESCAN'}</button>
            </div>
          </label>
          {outputs.length === 0 && outputNote && <div className="note">{outputNote}</div>}
          <details className="adv">
          <summary>More settings (levels, buffers, audio)</summary>
          {d.output !== 'preview' && (
            <div className="row two">
              <label>White level <span className="hint">lower = dimmer whites</span>
                <select value={d.whiteLevel ?? 100} onChange={ev => restartWith({ whiteLevel: Number(ev.target.value) })}>
                  {[100, 95, 90, 85, 80, 75, 70].map(v => <option key={v} value={v}>{v === 100 ? '100% (as sent)' : `${v}%`}</option>)}
                </select>
              </label>
              <label>Output range
                <select value={d.outLevels === 'soft' ? 'full' : d.outLevels ?? 'standard'} onChange={ev => restartWith({ outLevels: ev.target.value as 'standard' | 'full' })}>
                  <option value="standard">Standard (16-235)</option>
                  <option value="full">Full (0-255)</option>
                </select>
              </label>
            </div>
          )}
          <div className="row two">
            <label>LAN buffer
              <select value={d.lanLatency} onChange={ev => restartWith({ lanLatency: Number(ev.target.value) })}>
                {[20, 40, 60, 100].map(v => <option key={v} value={v}>{v} ms</option>)}
              </select>
            </label>
            <label>Download buffer <span className="hint">{live && state.path === 'relay' && state.latencyMs ? `using ${state.latencyMs} ms${(state.probeMs ?? 0) > 0 ? ` (${state.probeMs} ms to the server)` : ''}` : 'server to this PC'}</span>
              <select value={d.relayLatency} onChange={ev => restartWith({ relayLatency: Number(ev.target.value) })}>
                <option value={0}>Auto (from this PC's ping to the server)</option>
                {[60, 80, 100, 120, 160, 200, 300].map(v => <option key={v} value={v}>{v} ms</option>)}
              </select>
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={d.monitorAudio} onChange={ev => toggleAudio(ev.target.checked)} /> Monitor audio on this PC</label>
          </details>
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
          <Report getText={() => decoderReport(config, d.id, state, stats, dir, logs)} />
        </section>
      </div>
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

function encoderReport(c: Config, streamId: string, s: EncStats | null, dir: DirState, logs: string[]) {
  return ['ARENA LINK - ENCODER REPORT', new Date().toISOString(),
    `stream: ${JSON.stringify(c.streams.find(x => x.id === streamId))}`,
    `config: ${JSON.stringify(safeConfig(c))}`, `stats: ${JSON.stringify(s)}`,
    `directory: ${JSON.stringify({ ok: dir.ok, error: dir.error, yourIp: dir.yourIp, onAir: dir.encoders.map(e => `${e.name}[${e.path}]`) })}`,
    '--- log ---', ...logs.slice(-40)].join('\n')
}
function decoderReport(c: Config, decId: string, st: DecState, s: DecStats | null, dir: DirState, logs: string[]) {
  return ['ARENA LINK - DECODER REPORT', new Date().toISOString(),
    `decoder: ${JSON.stringify(c.decs.find(x => x.id === decId))}`,
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
