import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CommsEngine } from '@engine'
import {
  GatewayConfig, GatewayRuntime, PortCfg, PortRuntime, RtpCfg, SourceKind,
  defaultConfig, defaultRtp, newPort,
} from './ports'
import './kp.css'
import './App.css'

const LS_KEY = 'arena-comms-gateway-config'

async function loadConfig(): Promise<GatewayConfig> {
  const base = defaultConfig()
  try {
    const stored = window.gw ? await window.gw.getConfig() : JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
    if (stored) {
      return {
        ...base, ...stored, device: { ...base.device, ...stored.device },
        ports: (stored.ports ?? []).map((p: PortCfg) => ({ ...newPort(1), ...p, rtp: { ...defaultRtp(), ...p.rtp }, vox: { ...newPort(1).vox, ...p.vox } })),
      }
    }
  } catch { /* fall through to defaults */ }
  return base
}

async function saveConfig(cfg: GatewayConfig) {
  try {
    if (window.gw) await window.gw.setConfig(cfg)
    else localStorage.setItem(LS_KEY, JSON.stringify({ ...cfg, password: '' })) // never keep the password in plain browser storage
  } catch { /* ignore */ }
}

export default function App() {
  const engine = useMemo(() => new CommsEngine(), [])
  const [, bump] = useState(0)
  const runtime = useMemo(() => new GatewayRuntime(engine, () => bump(n => n + 1)), [engine])
  useSyncExternalStore(engine.subscribe, engine.getVersion)
  if (import.meta.env.DEV) Object.assign(window, { __gw: { engine, runtime } })

  const [cfg, setCfg] = useState<GatewayConfig | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const autoTried = useRef(false)

  useEffect(() => { void loadConfig().then(setCfg) }, [])
  useEffect(() => {
    if (!cfg) return
    const t = setTimeout(() => void saveConfig(cfg), 400)
    return () => clearTimeout(t)
  }, [cfg])

  const refreshDevices = async () => {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()) } catch { /* labels stay hidden */ }
    setDevices(await navigator.mediaDevices.enumerateDevices())
  }
  useEffect(() => { navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {}) }, [])

  const connect = () => {
    if (!cfg) return
    void engine.join({
      url: cfg.server.trim(), auth: 'accounts', username: cfg.username, password: cfg.password,
      name: '', pin: '', echoCancel: false, gateway: true,
    })
  }
  const disconnect = () => { runtime.teardown(); engine.leave() }

  // Auto-connect once the stored config has loaded.
  useEffect(() => {
    if (cfg && cfg.autoConnect && cfg.username && cfg.password && !autoTried.current && engine.status === 'idle') {
      autoTried.current = true
      connect()
    }
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the audio graph in step with the connection and the config.
  const status = engine.status
  useEffect(() => {
    if (!cfg) return
    if (status === 'connected') {
      if (!runtime.built || runtime.isStale(cfg)) void runtime.build(cfg)
      else runtime.updateParams(cfg)
    } else if (status === 'idle' || status === 'error') {
      runtime.teardown()
    }
  }, [cfg, status, runtime])

  // Refresh meters.
  useEffect(() => {
    const t = setInterval(() => bump(n => n + 1), 80)
    return () => clearInterval(t)
  }, [])

  if (!cfg) return <div className="app center muted">Loading…</div>

  const patch = (p: Partial<GatewayConfig>) => setCfg(c => c && { ...c, ...p })
  const patchDevice = (p: Partial<GatewayConfig['device']>) => setCfg(c => c && { ...c, device: { ...c.device, ...p } })
  const patchPort = (id: string, p: Partial<PortCfg>) => setCfg(c => c && { ...c, ports: c.ports.map(x => (x.id === id ? { ...x, ...p } : x)) })
  const removePort = (id: string) => setCfg(c => c && { ...c, ports: c.ports.filter(x => x.id !== id) })
  const addPort = () => setCfg(c => c && { ...c, ports: [...c.ports, newPort(c.ports.length + 1)] })

  const connected = status === 'connected' || status === 'reconnecting'
  const mics = devices.filter(d => d.kind === 'audioinput')
  const outs = devices.filter(d => d.kind === 'audiooutput')
  const live = new Map(runtime.ports.map(p => [p.cfg.id, p]))

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand"><img src="logo.png" alt="" /><span>ARENA</span><b>COMMS</b><span className="gw">GATEWAY</span></div>
        <div className="title-right">
          <span className={`pill ${status}`}>{status === 'connected' ? `Connected · ${engine.myName}` : status === 'error' ? 'Error' : status}</span>
        </div>
      </div>
      <div className="content">
        <section className="card">
          <h2 className="lcd">Arena server</h2>
          <div className="grid3">
            <label>Server<input value={cfg.server} onChange={e => patch({ server: e.target.value })} placeholder="ws://host:8900" /></label>
            <label>Gateway account<input value={cfg.username} onChange={e => patch({ username: e.target.value })} autoComplete="username" /></label>
            <label>Password<input type="password" value={cfg.password} onChange={e => patch({ password: e.target.value })} autoComplete="current-password" /></label>
          </div>
          <div className="row">
            <label className="check"><input type="checkbox" checked={cfg.autoConnect} onChange={e => patch({ autoConnect: e.target.checked })} />Connect automatically at start-up</label>
            <span className="grow" />
            {connected
              ? <button className="btn danger" onClick={disconnect}>Disconnect</button>
              : <button className="btn primary" disabled={!cfg.username || !cfg.password} onClick={connect}>Connect</button>}
          </div>
          {status === 'error' && <div className="error">{engine.error}</div>}
          <p className="hint">Create a user for this gateway in the admin page and put it in groups that can talk and listen on the channels it bridges. The server must be in SFU media mode.</p>
        </section>

        <section className="card">
          <div className="bar"><h2 className="lcd">Audio device</h2><button className="btn sm" onClick={() => void refreshDevices()}>Refresh devices</button></div>
          <div className="grid4">
            <label>Input (from comms system)
              <select value={cfg.device.inputId} onChange={e => patchDevice({ inputId: e.target.value })}>
                <option value="">System default</option>
                {mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Input'}</option>)}
              </select>
            </label>
            <label>Output (to comms system)
              <select value={cfg.device.outputId} onChange={e => patchDevice({ outputId: e.target.value })}>
                <option value="">System default</option>
                {outs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Output'}</option>)}
              </select>
            </label>
            <label>Input channels<input type="number" min={1} max={64} value={cfg.device.inputChannels} onChange={e => patchDevice({ inputChannels: Math.max(1, +e.target.value || 1) })} /></label>
            <label>Output channels<input type="number" min={1} max={64} value={cfg.device.outputChannels} onChange={e => patchDevice({ outputChannels: Math.max(1, +e.target.value || 1) })} /></label>
          </div>
          {runtime.deviceError && <div className="error">{runtime.deviceError}</div>}
        </section>

        <div className="bar"><h2 className="lcd">Ports</h2><button className="btn primary" onClick={addPort}>Add port</button></div>
        {cfg.ports.length === 0 && <div className="muted">No ports yet. Each port bridges one comms-system audio path to one Arena channel.</div>}
        {cfg.ports.map(p => (
          <PortCard key={p.id} cfg={p} live={live.get(p.id)} engine={engine} connected={connected} mics={mics} outs={outs}
            dupChannel={!!p.channel && cfg.ports.some(o => o !== p && o.enabled && p.enabled && o.channel === p.channel)}
            onChange={x => patchPort(p.id, x)} onRemove={() => removePort(p.id)} />
        ))}
      </div>
    </div>
  )
}

const pct = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`

function PortCard({ cfg, live, engine, connected, mics, outs, dupChannel, onChange, onRemove }: {
  cfg: PortCfg; live?: PortRuntime; engine: CommsEngine; connected: boolean; mics: MediaDeviceInfo[]; outs: MediaDeviceInfo[]; dupChannel: boolean
  onChange: (p: Partial<PortCfg>) => void; onRemove: () => void
}) {
  const channels = engine.channels.filter(c => !c.music)
  const rtp = (p: Partial<RtpCfg>) => onChange({ rtp: { ...cfg.rtp, ...p } })
  const num = (v: string, d = 0) => (Number.isFinite(+v) ? +v : d)
  const inDb = live?.inDb() ?? -120
  const outDb = live?.outDb() ?? -120
  const problem = dupChannel ? 'Another port already uses this channel' : live?.error
    || (live?.access === 'none' && connected && cfg.channel ? 'This gateway account has no access to that channel' : '')
    || (live?.access === 'listen-only' ? 'Listen-only: audio from the comms system cannot be sent' : '')
    || (live?.access === 'talk-only' ? 'Talk-only: the comms system will hear nothing' : '')
  return (
    <section className={`card port ${live?.open ? 'talking' : ''} ${cfg.enabled ? '' : 'off'}`}>
      <div className="bar">
        <input className="pname" value={cfg.name} onChange={e => onChange({ name: e.target.value })} />
        <span className="grow" />
        {live?.open && <span className="tag live"><i className="led red on" />TALKING TO ARENA</span>}
        <label className="check"><input type="checkbox" checked={cfg.enabled} onChange={e => onChange({ enabled: e.target.checked })} />Enabled</label>
        <button className="btn sm danger" onClick={() => confirm(`Remove ${cfg.name}?`) && onRemove()}>Remove</button>
      </div>
      <div className="grid4">
        <label>Arena channel
          {channels.length
            ? <select value={cfg.channel} onChange={e => onChange({ channel: e.target.value })}>
                <option value="">— choose —</option>
                {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                {cfg.channel && !channels.some(c => c.id === cfg.channel) && <option value={cfg.channel}>{cfg.channel} (no access)</option>}
              </select>
            : <input value={cfg.channel} onChange={e => onChange({ channel: e.target.value })} placeholder="channel id (connect to pick)" />}
        </label>
        <label>Audio source
          <select value={cfg.source} onChange={e => onChange({ source: e.target.value as SourceKind })}>
            <option value="device">Audio interface</option>
            <option value="rtp">Network audio (AES67 RTP)</option>
            <option value="tone">Test only (no audio in)</option>
          </select>
        </label>
        {cfg.source === 'device' && <>
          <label>Input device
            <select value={cfg.inputId ?? ''} onChange={e => onChange({ inputId: e.target.value })}>
              <option value="">Shared device (above)</option>
              {mics.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Input'}</option>)}
            </select>
          </label>
          <label>Input channel in that device<input type="number" min={1} value={cfg.inCh} onChange={e => onChange({ inCh: num(e.target.value, 1) })} /></label>
          <label>Output device
            <select value={cfg.outputId ?? ''} onChange={e => onChange({ outputId: e.target.value })}>
              <option value="">Shared device (above)</option>
              {outs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Output'}</option>)}
            </select>
          </label>
          <label>Output channel in that device<input type="number" min={1} value={cfg.outCh} onChange={e => onChange({ outCh: num(e.target.value, 1) })} /></label>
        </>}
      </div>
      {cfg.source === 'rtp' && (
        <fieldset>
          <legend>Network audio (multicast or unicast, 48 kHz, no PTP needed)</legend>
          <div className="grid4">
            <label>Receive address<input value={cfg.rtp.rxAddr} onChange={e => rtp({ rxAddr: e.target.value })} placeholder="239.x.x.x or blank" /></label>
            <label>Receive port<input type="number" value={cfg.rtp.rxPort} onChange={e => rtp({ rxPort: num(e.target.value) })} /></label>
            <label>Format
              <select value={cfg.rtp.rxFormat} onChange={e => rtp({ rxFormat: e.target.value as RtpCfg['rxFormat'], txFormat: e.target.value as RtpCfg['txFormat'] })}>
                <option>L24</option><option>L16</option>
              </select>
            </label>
            <label>Payload type<input type="number" value={cfg.rtp.rxPayloadType} onChange={e => rtp({ rxPayloadType: num(e.target.value, 97), txPayloadType: num(e.target.value, 97) })} /></label>
            <label>Stream channels<input type="number" min={1} value={cfg.rtp.rxChannels} onChange={e => rtp({ rxChannels: num(e.target.value, 1) })} /></label>
            <label>Use channel (0-based)<input type="number" min={0} value={cfg.rtp.rxChannel} onChange={e => rtp({ rxChannel: num(e.target.value) })} /></label>
            <label>Send address<input value={cfg.rtp.txAddr} onChange={e => rtp({ txAddr: e.target.value })} /></label>
            <label>Send port<input type="number" value={cfg.rtp.txPort} onChange={e => rtp({ txPort: num(e.target.value) })} /></label>
            <label>Packet time (ms)<input type="number" step={0.25} min={0.25} value={cfg.rtp.ptimeMs} onChange={e => rtp({ ptimeMs: num(e.target.value, 1) })} /></label>
            <label>Receive buffer (ms)<input type="number" min={10} value={cfg.rtp.bufferMs} onChange={e => rtp({ bufferMs: num(e.target.value, 40) })} /></label>
          </div>
          {live?.rtpStats && <div className="hint">Receiving: {live.rtpStats.packets} packets · {live.rtpStats.lost} lost · {live.rtpStats.late} late/reordered</div>}
        </fieldset>
      )}
      <div className="meters">
        <div>
          <div className="mlabel">From comms system <span className="lcdread">{inDb > -100 ? `${inDb.toFixed(0)} dB` : '—'}</span></div>
          <div className="mwrap"><div className="ledmeter"><div style={{ width: pct(inDb) }} /></div><div className="thr" style={{ left: pct(cfg.vox.thresholdDb) }} title="VOX threshold" /></div>
        </div>
        <div>
          <div className="mlabel">To comms system <span className="lcdread">{outDb > -100 ? `${outDb.toFixed(0)} dB` : '—'}</span></div>
          <div className="mwrap"><div className="ledmeter out"><div style={{ width: pct(outDb) }} /></div></div>
        </div>
      </div>
      <div className="grid4">
        <label>VOX threshold: {cfg.vox.thresholdDb} dB
          <input type="range" min={-80} max={-10} value={cfg.vox.thresholdDb} onChange={e => onChange({ vox: { ...cfg.vox, thresholdDb: +e.target.value } })} />
        </label>
        <label>VOX hang: {cfg.vox.hangMs} ms
          <input type="range" min={100} max={2000} step={50} value={cfg.vox.hangMs} onChange={e => onChange({ vox: { ...cfg.vox, hangMs: +e.target.value } })} />
        </label>
        <label>Gain in: {cfg.inGainDb} dB
          <input type="range" min={-30} max={30} value={cfg.inGainDb} onChange={e => onChange({ inGainDb: +e.target.value })} />
        </label>
        <label>Gain out: {cfg.outGainDb} dB
          <input type="range" min={-30} max={30} value={cfg.outGainDb} onChange={e => onChange({ outGainDb: +e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label className="check" title="While Arena audio is being sent to the comms system, ignore what returns, to avoid loops">
          <input type="checkbox" checked={cfg.vox.echoGuard} onChange={e => onChange({ vox: { ...cfg.vox, echoGuard: e.target.checked } })} />Echo guard
        </label>
        <button className={`btn sm ${live?.tone ? 'primary' : ''}`} disabled={!live} onClick={() => live?.setTone(!live.tone)}>
          {live?.tone ? 'Stop test tone' : 'Send 1 kHz test tone'}
        </button>
        <span className="grow" />
        {problem && <span className="warn">{problem}</span>}
      </div>
    </section>
  )
}
