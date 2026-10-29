import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CommsEngine } from '@engine'
import {
  AsioCfg, AsioDevice, GatewayConfig, GatewayRuntime, PortCfg, PortRuntime, RtpCfg, SourceKind,
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
        ...base, ...stored, device: { ...base.device, ...stored.device }, asio: { ...base.asio, ...(stored.asio ?? {}) },
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

/** Just an address (5.78.236.254) means the cloud install: wss://<address>/comms. A full ws:// or wss:// URL is used as typed. */
const serverUrl = (v: string) => {
  const t = v.trim()
  return /^wss?:\/\//i.test(t) ? t : `wss://${t.replace(/\/+$/, '')}/comms`
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
  const [asioDevices, setAsioDevices] = useState<AsioDevice[]>([])
  const [asioErr, setAsioErr] = useState('')
  const refreshAsio = async () => {
    if (!window.gw?.asioList) { setAsioErr('ASIO needs the desktop app'); return }
    const r = await window.gw.asioList()
    setAsioDevices(r.devices ?? [])
    setAsioErr(r.ok ? '' : r.error ?? '')
  }
  useEffect(() => { void refreshAsio() }, [])

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
      url: serverUrl(cfg.server), auth: 'accounts', username: '', password: '',
      name: '', pin: '', echoCancel: false, gateway: true,
    })
  }
  const disconnect = () => { runtime.teardown(); engine.leave() }

  // Auto-connect once the stored config has loaded.
  useEffect(() => {
    if (cfg && cfg.autoConnect && cfg.server && !autoTried.current && engine.status === 'idle') {
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
  const patchAsio = (p: Partial<AsioCfg>) => setCfg(c => c && { ...c, asio: { ...c.asio, ...p } })
  const setChName = (kind: 'inputNames' | 'outputNames', i: number, v: string) =>
    setCfg(c => {
      if (!c) return c
      const arr = [...(c.asio[kind] ?? [])]
      while (arr.length <= i) arr.push('')
      arr[i] = v
      return { ...c, asio: { ...c.asio, [kind]: arr } }
    })
  const removePort = (id: string) => setCfg(c => c && { ...c, ports: c.ports.filter(x => x.id !== id) })
  const addPort = () => setCfg(c => c && { ...c, ports: [...c.ports, newPort(c.ports.length + 1)] })

  const connected = status === 'connected' || status === 'reconnecting'
  const mics = devices.filter(d => d.kind === 'audioinput')
  const outs = devices.filter(d => d.kind === 'audiooutput')
  const live = new Map(runtime.ports.map(p => [p.cfg.id, p]))
  const asioDev = asioDevices.find(d => d.id === cfg.asio.deviceId)

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
            <label>Server<input value={cfg.server} onChange={e => patch({ server: e.target.value })} placeholder="5.78.236.254" /></label>
          </div>
          <div className="row">
            <label className="check"><input type="checkbox" checked={cfg.autoConnect} onChange={e => patch({ autoConnect: e.target.checked })} />Connect automatically at start-up</label>
            <span className="grow" />
            {connected
              ? <button className="btn danger" onClick={disconnect}>Disconnect</button>
              : <button className="btn primary" disabled={!cfg.server} onClick={connect}>Connect</button>}
          </div>
          {status === 'error' && <div className="error">{engine.error}</div>}
          <p className="hint">No account needed: enter the server address and connect. The gateway talks and listens on every channel. If it stays on reconnecting, Windows does not trust the server's certificate yet (install it under Trusted Root Certification Authorities).</p>
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

        <section className="card">
          <div className="bar"><h2 className="lcd">ASIO interface (all channels)</h2><button className="btn sm" onClick={() => void refreshAsio()}>Refresh drivers</button></div>
          <div className="grid4">
            <label>ASIO driver
              <select value={cfg.asio.deviceId} onChange={e => patchAsio({ deviceId: +e.target.value })}>
                <option value={-1}>none</option>
                {asioDevices.map(d => <option key={d.id} value={d.id}>{d.name} ({d.inputChannels} in / {d.outputChannels} out)</option>)}
              </select>
            </label>
            <label>Buffer size
              <select value={cfg.asio.frames} onChange={e => patchAsio({ frames: +e.target.value })}>
                {[64, 128, 256, 512, 1024].map(n => <option key={n} value={n}>{n} samples ({(n / 48).toFixed(1)} ms)</option>)}
              </select>
            </label>
          </div>
          {asioErr && <div className="error">{asioErr}</div>}
          {!asioErr && asioDevices.length === 0 && <div className="hint">No ASIO drivers found. Install your interface driver (Focusrite, or Dante Virtual Soundcard for Dante) and press Refresh drivers.</div>}
          {runtime.asioInfo?.ok && <div className="hint">Open: {runtime.asioInfo.driver} · {runtime.asioInfo.openedIn} in / {runtime.asioInfo.openedOut} out used · {runtime.asioInfo.frames}-sample buffer</div>}
        </section>

        {asioDev && <RoutingGrid cfg={cfg} asioDev={asioDev} channels={engine.channels.filter(c => !c.music)} groups={engine.groups} setCfg={setCfg} setName={setChName} />}

        <div className="bar"><h2 className="lcd">Ports</h2><button className="btn primary" onClick={addPort}>Add port</button></div>
        {cfg.ports.length === 0 && <div className="muted">No ports yet. Each port bridges one comms-system audio path to one Arena channel.</div>}
        {cfg.ports.map(p => (
          <PortCard key={p.id} cfg={p} live={live.get(p.id)} engine={engine} connected={connected} mics={mics} outs={outs} asio={cfg.asio} asioDev={asioDev}
            dupChannel={!!p.channel && cfg.ports.some(o => o !== p && o.enabled && p.enabled && o.channel === p.channel)}
            onChange={x => patchPort(p.id, x)} onRemove={() => removePort(p.id)} />
        ))}
      </div>
    </div>
  )
}

/** Dante-Controller-style routing: interface channels on one axis, Arena channels on the other. */
function RoutingGrid({ cfg, asioDev, channels: allChannels, groups, setCfg, setName }: {
  cfg: GatewayConfig; asioDev: AsioDevice; channels: { id: string; name: string; color?: string }[]
  setCfg: (f: (c: GatewayConfig | null) => GatewayConfig | null) => void
  groups: { id: string; name: string; channels: string[] }[]
  setName: (kind: 'inputNames' | 'outputNames', i: number, v: string) => void
}) {
  const [tab, setTab] = useState<'in' | 'out'>('in')
  const [group, setGroup] = useState(() => { try { return localStorage.getItem('gw-grid-group') ?? '' } catch { return '' } })
  const pickGroup = (g: string) => { setGroup(g); try { localStorage.setItem('gw-grid-group', g) } catch { /* ignore */ } }
  const grp = groups.find(g => g.id === group)
  const channels = grp ? allChannels.filter(c => grp.channels.includes(c.id)) : allChannels
  const key = tab === 'in' ? 'inCh' : 'outCh'
  const count = tab === 'in' ? asioDev.inputChannels : asioDev.outputChannels
  const names = tab === 'in' ? cfg.asio.inputNames : cfg.asio.outputNames
  const portFor = (ch: string) => cfg.ports.find(p => p.source === 'asio' && p.channel === ch)
  const toggle = (ch: { id: string; name: string }, n: number) => setCfg(c => {
    if (!c) return c
    const ex = c.ports.find(p => p.source === 'asio' && p.channel === ch.id)
    const next = ex?.[key] === n ? 0 : n // clicking the lit cell clears it
    if (!ex) {
      const p = { ...newPort(c.ports.length + 1), name: ch.name, source: 'asio' as SourceKind, channel: ch.id, inCh: 0, outCh: 0, [key]: next }
      return { ...c, ports: [...c.ports, p] }
    }
    const upd = { ...ex, [key]: next }
    // A port with nothing routed either way is dropped, so clearing the last cell leaves no empty card behind.
    return { ...c, ports: upd.inCh < 1 && upd.outCh < 1 ? c.ports.filter(p => p !== ex) : c.ports.map(p => (p === ex ? upd : p)) }
  })
  return (
    <section className="card">
      <div className="bar">
        <h2 className="lcd">Routing</h2>
        <label className="inline">Group
          <select value={grp ? group : ''} onChange={e => pickGroup(e.target.value)}>
            <option value="">All channels</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <div className="tabs">
          <button className={`btn sm ${tab === 'in' ? 'primary' : ''}`} onClick={() => setTab('in')}>Inputs → Arena</button>
          <button className={`btn sm ${tab === 'out' ? 'primary' : ''}`} onClick={() => setTab('out')}>Arena → Outputs</button>
        </div>
      </div>
      {channels.length === 0 && <div className="hint">Connect to the server to see its channels as columns. You can name the interface channels now.</div>}
      {<>
          <div className="hint">Type in the name boxes to name each channel (for example Mic 3 - Director). {tab === 'in'
            ? 'Click where an interface input meets an Arena channel to send that input to the channel. One input per channel; an input can feed several channels.'
            : 'Click where an Arena channel meets an interface output to play the channel out of that output. One output per channel.'}</div>
          <div className="gridwrap">
            <table className="rgrid">
              <thead><tr><th className="corner">{tab === 'in' ? 'Interface input' : 'Interface output'}</th>
                {channels.map(c => <th key={c.id} className="chead"><span>{c.name}</span></th>)}</tr></thead>
              <tbody>
                {Array.from({ length: count }, (_, i) => (
                  <tr key={i}>
                    <th className="rname"><b>{i + 1}</b><input value={names[i] ?? ''} onChange={e => setName(tab === 'in' ? 'inputNames' : 'outputNames', i, e.target.value)} placeholder={tab === 'in' ? `Input ${i + 1}` : `Output ${i + 1}`} /></th>
                    {channels.map(c => {
                      const on = portFor(c.id)?.[key] === i + 1
                      return <td key={c.id}><button className={`cell ${on ? 'on' : ''}`} onClick={() => toggle(c, i + 1)} title={`${names[i]?.trim() || i + 1} ${tab === 'in' ? '→' : '←'} ${c.name}`} /></td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      </>}
    </section>
  )
}

const pct = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`

function PortCard({ cfg, live, engine, connected, mics, outs, asio, asioDev, dupChannel, onChange, onRemove }: {
  cfg: PortCfg; live?: PortRuntime; engine: CommsEngine; connected: boolean; mics: MediaDeviceInfo[]; outs: MediaDeviceInfo[]; asio: AsioCfg; asioDev?: AsioDevice; dupChannel: boolean
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
            <option value="device">Audio interface (system devices)</option>
            <option value="asio">Audio interface (ASIO, all channels)</option>
            <option value="rtp">Network audio (AES67 RTP)</option>
            <option value="tone">Test only (no audio in)</option>
          </select>
        </label>
        {cfg.source === 'asio' && <>
          <label>Interface input
            <select value={cfg.inCh} onChange={e => onChange({ inCh: +e.target.value })}>
              <option value={0}>— none —</option>
              {!asioDev && cfg.inCh > 0 && <option value={cfg.inCh}>{cfg.inCh}</option>}
              {Array.from({ length: asioDev?.inputChannels ?? 0 }, (_, i) => <option key={i} value={i + 1}>{i + 1} · {asio.inputNames[i]?.trim() || `Input ${i + 1}`}</option>)}
            </select>
          </label>
          <label>Interface output
            <select value={cfg.outCh} onChange={e => onChange({ outCh: +e.target.value })}>
              <option value={0}>— none —</option>
              {!asioDev && cfg.outCh > 0 && <option value={cfg.outCh}>{cfg.outCh}</option>}
              {Array.from({ length: asioDev?.outputChannels ?? 0 }, (_, i) => <option key={i} value={i + 1}>{i + 1} · {asio.outputNames[i]?.trim() || `Output ${i + 1}`}</option>)}
            </select>
          </label>
        </>}
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
