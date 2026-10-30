import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CommsEngine } from '@engine'
import {
  AsioCfg, AsioDevice, GatewayConfig, GatewayRuntime, PortCfg, PortRuntime, RtpCfg, SourceKind,
  defaultConfig, defaultRtp, newAsio, newPort,
} from './ports'
import './kp.css'
import './App.css'

const LS_KEY = 'arena-comms-gateway-config'

/** Older configs held a single ASIO interface as one object; now it is a list. */
function migrateAsio(old: unknown): AsioCfg[] {
  if (Array.isArray(old)) return old.map((a, i) => ({ ...newAsio(i + 1), ...a }))
  const o = old as Partial<AsioCfg> | undefined
  return o && typeof o.deviceId === 'number' && o.deviceId >= 0 ? [{ ...newAsio(1), id: 'a1', ...o }] : []
}

async function loadConfig(): Promise<GatewayConfig> {
  const base = defaultConfig()
  try {
    const stored = window.gw ? await window.gw.getConfig() : JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
    if (stored) {
      return {
        ...base, ...stored, device: { ...base.device, ...stored.device }, asio: migrateAsio(stored.asio),
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
  // Remember each interface by its driver name (its number can change), once the driver list is known.
  useEffect(() => {
    if (!cfg || !asioDevices.length) return
    if (cfg.asio.some(a => !a.driver && asioDevices.some(d => d.id === a.deviceId)))
      setCfg(c => c && { ...c, asio: c.asio.map(a => (a.driver ? a : { ...a, driver: asioDevices.find(d => d.id === a.deviceId)?.name ?? '' })) })
  }, [cfg, asioDevices])

  useEffect(() => { void loadConfig().then(setCfg) }, [])
  // A new name reaches the server straight away, no reconnect.
  const wantName = cfg?.name.trim() || 'Gateway'
  useEffect(() => {
    if (!cfg || engine.status !== 'connected' || engine.myName === wantName) return
    const t = setTimeout(() => engine.rename(wantName), 300)
    return () => clearTimeout(t)
  }, [wantName, engine.status, engine.myName]) // eslint-disable-line react-hooks/exhaustive-deps
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
      name: cfg.name.trim() || 'Gateway', pin: '', echoCancel: false, gateway: true,
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
  const patchAsio = (id: string, p: Partial<AsioCfg>) => setCfg(c => c && { ...c, asio: c.asio.map(a => (a.id === id ? { ...a, ...p } : a)) })
  const addAsio = () => setCfg(c => c && { ...c, asio: [...c.asio, newAsio(c.asio.length + 1)] })
  const removeAsio = (id: string) => setCfg(c => c && { ...c, asio: c.asio.filter(a => a.id !== id) })
  const setChName = (id: string, kind: 'inputNames' | 'outputNames', i: number, v: string) =>
    setCfg(c => {
      if (!c) return c
      return { ...c, asio: c.asio.map(a => {
        if (a.id !== id) return a
        const arr = [...(a[kind] ?? [])]
        while (arr.length <= i) arr.push('')
        arr[i] = v
        return { ...a, [kind]: arr }
      }) }
    })
  const removePort = (id: string) => setCfg(c => c && { ...c, ports: c.ports.filter(x => x.id !== id) })
  const addPort = () => setCfg(c => c && { ...c, ports: [...c.ports, { ...newPort(c.ports.length + 1), ...(c.asio.length ? { source: 'asio' as SourceKind, inCh: 0, outCh: 0 } : {}) }] })

  const connected = status === 'connected' || status === 'reconnecting'
  const mics = devices.filter(d => d.kind === 'audioinput')
  const outs = devices.filter(d => d.kind === 'audiooutput')
  const live = new Map(runtime.ports.map(p => [p.cfg.id, p]))
  const devFor = (a: AsioCfg) => asioDevices.find(d => d.name === a.driver) ?? asioDevices.find(d => d.id === a.deviceId)
  const interfaces = cfg.asio.map(a => ({ cfg: a, dev: devFor(a) }))

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
            <label>Gateway name<input value={cfg.name} onChange={e => patch({ name: e.target.value })} placeholder="Gateway" maxLength={24} /></label>
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
          <div className="bar"><h2 className="lcd">ASIO interfaces</h2><span className="grow" /><button className="btn sm" onClick={() => void refreshAsio()}>Refresh drivers</button><button className="btn sm primary" onClick={addAsio}>Add interface</button></div>
          {cfg.asio.length === 0 && <div className="hint">Add an interface for each ASIO driver you want to use: a Focusrite, Dante Virtual Soundcard, and so on. Every channel of each one appears in the routing grid.</div>}
          {cfg.asio.map((a, n) => {
            const info = runtime.asioInfo.get(a.id)
            const used = new Set(cfg.asio.filter(o => o !== a).map(o => o.driver))
            return (
              <div key={a.id} className="iface">
                <div className="grid4">
                  <label>Interface {n + 1}: ASIO driver
                    <select value={a.driver} onChange={e => patchAsio(a.id, { driver: e.target.value, deviceId: asioDevices.find(d => d.name === e.target.value)?.id ?? -1 })}>
                      <option value="">none</option>
                      {a.driver && !asioDevices.some(d => d.name === a.driver) && <option value={a.driver}>{a.driver} (not found)</option>}
                      {asioDevices.map(d => <option key={d.id} value={d.name} disabled={used.has(d.name)}>{d.name} ({d.inputChannels} in / {d.outputChannels} out){used.has(d.name) ? ' · in use above' : ''}</option>)}
                    </select>
                  </label>
                  <label>Buffer size
                    <select value={a.frames} onChange={e => patchAsio(a.id, { frames: +e.target.value })}>
                      {[64, 128, 256, 512, 1024].map(f => <option key={f} value={f}>{f} samples ({(f / 48).toFixed(1)} ms)</option>)}
                    </select>
                  </label>
                  <label>&nbsp;<button className="btn sm danger" onClick={() => confirm(`Remove interface ${n + 1}? Ports using it lose their routes.`) && removeAsio(a.id)}>Remove</button></label>
                </div>
                {info?.ok && <div className="hint">Open: {info.driver} · {info.inputChannels} in / {info.outputChannels} out · {info.frames}-sample buffer</div>}
                {info && !info.ok && <div className="error">{info.error}</div>}
              </div>
            )
          })}
          {asioErr && <div className="error">{asioErr}</div>}
          {!asioErr && asioDevices.length === 0 && <div className="hint">No ASIO drivers found. Install your interface driver (Focusrite, or Dante Virtual Soundcard for Dante) and press Refresh drivers.</div>}
        </section>

        {interfaces.some(i => i.dev) && <RoutingGrid interfaces={interfaces} cfg={cfg} runtime={runtime} channels={engine.channels.filter(c => !c.music)} groups={engine.groups} setCfg={setCfg} setName={setChName} />}

        <div className="bar"><h2 className="lcd">Ports</h2><button className="btn primary" onClick={addPort}>Add port</button></div>
        {cfg.ports.length === 0 && <div className="muted">No ports yet. Each port bridges one comms-system audio path to one Arena channel.</div>}
        {cfg.ports.map(p => (
          <PortCard key={p.id} cfg={p} live={live.get(p.id)} engine={engine} connected={connected} mics={mics} outs={outs} interfaces={interfaces}
            dupChannel={!!p.channel && cfg.ports.some(o => o !== p && o.enabled && p.enabled && o.channel === p.channel)}
            onChange={x => patchPort(p.id, x)} onRemove={() => removePort(p.id)} />
        ))}
      </div>
    </div>
  )
}

/** Dante-Controller-style routing: interface channels on one axis, Arena channels on the other. */
function RoutingGrid({ interfaces, cfg, runtime, channels: allChannels, groups, setCfg, setName }: {
  interfaces: { cfg: AsioCfg; dev?: AsioDevice }[]
  runtime: GatewayRuntime
  cfg: GatewayConfig; channels: { id: string; name: string; color?: string }[]
  setCfg: (f: (c: GatewayConfig | null) => GatewayConfig | null) => void
  groups: { id: string; name: string; channels: string[] }[]
  setName: (id: string, kind: 'inputNames' | 'outputNames', i: number, v: string) => void
}) {
  const [tab, setTab] = useState<'in' | 'out'>('in')
  const [group, setGroup] = useState(() => { try { return localStorage.getItem('gw-grid-group') ?? '' } catch { return '' } })
  const pickGroup = (g: string) => { setGroup(g); try { localStorage.setItem('gw-grid-group', g) } catch { /* ignore */ } }
  const grp = groups.find(g => g.id === group)
  const channels = grp ? allChannels.filter(c => grp.channels.includes(c.id)) : allChannels
  const key = tab === 'in' ? 'inCh' : 'outCh'
  const devKey = tab === 'in' ? 'inDev' : 'outDev'
  const firstId = cfg.asio[0]?.id ?? ''
  const portFor = (ch: string) => cfg.ports.find(p => p.source === 'asio' && p.channel === ch)
  const toggle = (ch: { id: string; name: string }, ifaceId: string, n: number) => setCfg(c => {
    if (!c) return c
    const ex = c.ports.find(p => p.source === 'asio' && p.channel === ch.id)
    const same = ex && ex[key] === n && (ex[devKey] || firstId) === ifaceId
    const patch = same ? { [key]: 0 } : { [key]: n, [devKey]: ifaceId } // clicking the lit cell clears it
    if (!ex) {
      const p = { ...newPort(c.ports.length + 1), name: ch.name, source: 'asio' as SourceKind, channel: ch.id, inCh: 0, outCh: 0, ...patch }
      return { ...c, ports: [...c.ports, p] }
    }
    const upd = { ...ex, ...patch }
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
      <div className="hint">Type in the name boxes to name each channel (for example Mic 3 - Director). {tab === 'in'
        ? 'Click where an interface input meets an Arena channel to send that input to the channel. One input per channel; an input can feed several channels.'
        : 'Click where an Arena channel meets an interface output to play the channel out of that output. One output per channel.'}</div>
      <div className="gridwrap">
        <table className="rgrid">
          <thead><tr><th className="corner">{tab === 'in' ? 'Interface input' : 'Interface output'}</th>
            {channels.map(c => <th key={c.id} className="chead"><span>{c.name}</span></th>)}</tr></thead>
          <tbody>
            {interfaces.map(({ cfg: a, dev }, n) => dev && [
              <tr key={a.id + 'h'}><th className="ifhead" colSpan={channels.length + 1}>{a.driver || `Interface ${n + 1}`}</th></tr>,
              ...Array.from({ length: tab === 'in' ? dev.inputChannels : dev.outputChannels }, (_, i) => {
                const names = tab === 'in' ? a.inputNames : a.outputNames
                return (
                  <tr key={`${a.id}-${i}`}>
                    <th className="rname"><b>{i + 1}</b><input value={names[i] ?? ''} onChange={e => setName(a.id, tab === 'in' ? 'inputNames' : 'outputNames', i, e.target.value)} placeholder={tab === 'in' ? `Input ${i + 1}` : `Output ${i + 1}`} /><span className="chmeter" title="Level on this line"><i style={{ width: pct(runtime.asioLevelDb(a.id, tab, i)) }} /></span></th>
                    {channels.map(c => {
                      const p = portFor(c.id)
                      const on = !!p && p[key] === i + 1 && (p[devKey] || firstId) === a.id
                      return <td key={c.id}><button className={`cell ${on ? 'on' : ''}`} onClick={() => toggle(c, a.id, i + 1)} title={`${names[i]?.trim() || i + 1} ${tab === 'in' ? '→' : '←'} ${c.name}`} /></td>
                    })}
                  </tr>
                )
              }),
            ])}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const pct = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`

function PortCard({ cfg, live, engine, connected, mics, outs, interfaces, dupChannel, onChange, onRemove }: {
  cfg: PortCfg; live?: PortRuntime; engine: CommsEngine; connected: boolean; mics: MediaDeviceInfo[]; outs: MediaDeviceInfo[]; interfaces: { cfg: AsioCfg; dev?: AsioDevice }[]; dupChannel: boolean
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
            <select value={cfg.inCh > 0 ? `${cfg.inDev || interfaces[0]?.cfg.id}|${cfg.inCh}` : ''}
              onChange={e => { const [d, n] = e.target.value.split('|'); onChange(e.target.value ? { inDev: d, inCh: +n } : { inCh: 0 }) }}>
              <option value="">— none —</option>
              {interfaces.map((f, k) => f.dev && (
                <optgroup key={f.cfg.id} label={f.cfg.driver || `Interface ${k + 1}`}>
                  {Array.from({ length: f.dev.inputChannels }, (_, i) => <option key={i} value={`${f.cfg.id}|${i + 1}`}>{i + 1} · {f.cfg.inputNames[i]?.trim() || `Input ${i + 1}`}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label>Interface output
            <select value={cfg.outCh > 0 ? `${cfg.outDev || interfaces[0]?.cfg.id}|${cfg.outCh}` : ''}
              onChange={e => { const [d, n] = e.target.value.split('|'); onChange(e.target.value ? { outDev: d, outCh: +n } : { outCh: 0 }) }}>
              <option value="">— none —</option>
              {interfaces.map((f, k) => f.dev && (
                <optgroup key={f.cfg.id} label={f.cfg.driver || `Interface ${k + 1}`}>
                  {Array.from({ length: f.dev.outputChannels }, (_, i) => <option key={i} value={`${f.cfg.id}|${i + 1}`}>{i + 1} · {f.cfg.outputNames[i]?.trim() || `Output ${i + 1}`}</option>)}
                </optgroup>
              ))}
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
      <label className="check" title="For a program feed: keeps sending to the channel whether or not anything is loud enough"><input type="checkbox" checked={!!cfg.vox.always} onChange={e => onChange({ vox: { ...cfg.vox, always: e.target.checked } })} />Always send (program feed, no voice gating)</label>
      <div className="grid4">
        <label>VOX threshold: {cfg.vox.thresholdDb} dB
          <input type="range" disabled={!!cfg.vox.always} min={-80} max={-10} value={cfg.vox.thresholdDb} onChange={e => onChange({ vox: { ...cfg.vox, thresholdDb: +e.target.value } })} />
        </label>
        <label>VOX hang: {cfg.vox.hangMs} ms
          <input type="range" disabled={!!cfg.vox.always} min={100} max={2000} step={50} value={cfg.vox.hangMs} onChange={e => onChange({ vox: { ...cfg.vox, hangMs: +e.target.value } })} />
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
