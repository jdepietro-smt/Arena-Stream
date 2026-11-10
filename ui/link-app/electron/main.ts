import { app, BrowserWindow, ipcMain } from 'electron'

app.setName('Arena Link')
app.setAppUserModelId('com.smt.arenalink')

import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as http from 'http'

// One instance only: a second launch would fight the first over the capture card and ports.
const hasSingleLock = app.requestSingleInstanceLock()
if (!hasSingleLock) app.quit()
else app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

// ─────────────────────────────────────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────────────────────────────────────
let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 740, minWidth: 860, minHeight: 600,
    title: 'Arena Link',
    backgroundColor: '#08090c',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#08090c', symbolColor: '#e4e7ec', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
}

if (hasSingleLock) app.whenReady().then(() => { startDirectoryPoll(); createWindow() })

app.on('window-all-closed', () => {
  win = null
  stopAllEncoders(false)
  void stopAllMonitors()
  stopAllDecoders()
  stopMdnsWatch()
  if (pollTimer) clearInterval(pollTimer)
  app.quit()
})

function send(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
}

function kill(proc: ChildProcess | null) {
  if (!proc || proc.killed) return
  try { proc.kill() } catch { /* already gone */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Binaries: installed next to the app, or straight out of the dev tree.
// ─────────────────────────────────────────────────────────────────────────────
const APP_DIR = path.dirname(process.execPath)
const DEV_DIR = path.join(__dirname, '../../..')

function findBin(name: string): string | null {
  const candidates = [
    path.join(APP_DIR, name),
    path.join(DEV_DIR, 'ui/link-app/release/win-unpacked', name),
    path.join(DEV_DIR, 'cpp/build/Release', name),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Config (one JSON file in the user's app-data folder)
// ─────────────────────────────────────────────────────────────────────────────
// One outgoing stream: its own input, name and LAN port.
interface StreamCfg { id: string; name: string; device: string; video: 'h264' | 'h265'; codec: 'gpu' | 'cpu'; quality: 'low' | 'balanced' | 'max'; adapt: boolean; deinterlace?: boolean; bitrate: number; audio: boolean; remote: boolean; relayLatency: number; port: number }
const STREAM_DEFAULTS = { name: '', device: '', video: 'h264' as const, codec: 'gpu' as const, quality: 'balanced' as const, adapt: true, bitrate: 10000, audio: true, remote: true, relayLatency: 0 }

// One receiving decoder: its own source encoder, output and buffers. Several can run at once.
interface DecCfg { id: string; output: string; outLevels: 'standard' | 'full' | 'soft'; whiteLevel: number; lanLatency: number; relayLatency: number; selected: string; monitorAudio: boolean }
const DEC_DEFAULTS = { output: 'preview', outLevels: 'standard' as const, whiteLevel: 100, lanLatency: 40, relayLatency: 0, selected: '', monitorAudio: false }

interface Config {
  mode: 'encoder' | 'decoder'
  directory: string
  key: string
  relayHost: string
  relaySecret: string
  latencyAuto?: boolean   // set once the old 100 ms default has been moved to Auto
  streams: StreamCfg[]
  decs: DecCfg[]
}

// Built-in directory access key so a fresh install connects with no setup (Settings can override it).
const DEFAULT_KEY = '5jpmzaedzkm5'

function defaultConfig(): Config {
  let relaySecret = ''
  // First run on a machine that already runs Arena Stream: reuse its relay passphrase.
  try {
    const f = path.join(app.getPath('appData'), 'Arena Stream', 'srt-passphrase.txt')
    if (fs.existsSync(f)) relaySecret = fs.readFileSync(f, 'utf-8').trim()
  } catch { /* none */ }
  return {
    mode: 'encoder',
    directory: 'http://5.78.236.254:8002',
    key: DEFAULT_KEY,
    relayHost: '5.78.236.254',
    relaySecret,
    streams: [{ id: 's1', port: 4200, ...STREAM_DEFAULTS }],
    decs: [{ id: 'd1', ...DEC_DEFAULTS }],
    latencyAuto: true,
  }
}

const configFile = () => path.join(app.getPath('userData'), 'config.json')

function loadConfig(): Config {
  const d = defaultConfig()
  try {
    const j = JSON.parse(fs.readFileSync(configFile(), 'utf-8'))
    const c = { ...d, ...j } as Config & { enc?: unknown; dec?: Partial<DecCfg> }
    // Older installs had a single encoder in `enc`: it becomes the first stream.
    let streams: Partial<StreamCfg>[] = Array.isArray(j.streams) && j.streams.length ? j.streams : j.enc ? [{ ...j.enc, id: 's1', port: 4200 }] : d.streams
    c.streams = streams.map((s, i) => ({ ...STREAM_DEFAULTS, ...s, id: s.id || `s${i + 1}`, port: s.port || 4200 + i }) as StreamCfg)
    delete c.enc
    // Older installs had a single decoder in `dec`: it becomes the first decoder.
    const oldDecs: Partial<DecCfg>[] = Array.isArray(j.decs) && j.decs.length ? j.decs : j.dec ? [{ ...j.dec, id: 'd1' }] : d.decs
    c.decs = oldDecs.map((x, i) => ({ ...DEC_DEFAULTS, ...x, id: x.id || `d${i + 1}` }) as DecCfg)
    delete c.dec
    // The old fixed 100 ms Internet buffer was only ever a default: move it to Auto (sized per leg from
    // the measured RTT), once. A value the user picked deliberately (anything else) stays.
    if (!j.latencyAuto) {
      for (const x of c.decs) if (x.relayLatency === 100) x.relayLatency = 0
      for (const s of c.streams) if (s.relayLatency === 100) s.relayLatency = 0
      c.latencyAuto = true
    }
    if (!c.key || c.key.length < 8) c.key = DEFAULT_KEY   // an earlier install saved an empty or test key
    return c
  } catch { return d }
}

let config: Config | null = null
const cfg = () => (config ??= loadConfig())

ipcMain.handle('get-config', () => cfg())
ipcMain.handle('set-config', (_, c: Config) => {
  config = c
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true })
    fs.writeFileSync(configFile(), JSON.stringify(c, null, 2))
  } catch (e) { send('log', `could not save settings: ${(e as Error).message}`) }
  return true
})

// ─────────────────────────────────────────────────────────────────────────────
// Directory: poll for encoders on air
// ─────────────────────────────────────────────────────────────────────────────
function getDirectory(directory: string, key: string, urlPath = '/v1/encoders'): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let u: URL
    try { u = new URL(directory.includes('://') ? directory : `http://${directory}`) } catch { reject(new Error('bad directory address')); return }
    const req = http.request({
      method: 'GET', host: u.hostname, port: Number(u.port) || 80, path: urlPath,
      headers: { 'X-Arena-Key': key }, timeout: 2500, agent: false,
    }, (res) => {
      let data = ''
      res.on('data', (d) => { data += d })
      res.on('end', () => {
        let body: any = null
        try { body = JSON.parse(data) } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

let pollTimer: NodeJS.Timeout | null = null
let polling = false

// The relay publish passphrase lives on the server and is handed out by the directory to anyone
// holding the access key, so no installer or settings file has to carry it. It wins over a
// locally saved one (which may be stale).
let directorySecret = ''
const currentRelaySecret = () => directorySecret || cfg().relaySecret

// -- LAN discovery (mDNS): encoders on this network, no directory or internet needed --
// link_decoder --mdns-watch prints the list whenever it changes (and every 5 s as a heartbeat).
let mdnsList: any[] = []
let mdnsSeen = 0
let mdnsProc: ChildProcess | null = null
let mdnsStopped = false
function startMdnsWatch() {
  const bin = findBin('link_decoder.exe')
  if (!bin || mdnsStopped || mdnsProc) return
  const proc = spawn(bin, ['--mdns-watch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  mdnsProc = proc
  lines(proc.stdout, (l) => {
    try {
      const m = JSON.parse(l)
      if (m.type !== 'mdns') return
      mdnsList = (m.encoders ?? []).map((e: any) => ({ ...e, path: 'lan', lan: true }))
      mdnsSeen = Date.now()
    } catch { /* not ours */ }
  })
  proc.on('error', () => { /* handled by close */ })
  proc.on('close', () => { mdnsProc = null; mdnsList = []; if (!mdnsStopped) setTimeout(startMdnsWatch, 3000) })
}
function stopMdnsWatch() { mdnsStopped = true; try { mdnsProc?.stdin?.write('quit\n') } catch { /* gone */ } setTimeout(() => kill(mdnsProc), 500) }
const lanEncoders = () => (Date.now() - mdnsSeen < 15000 ? mdnsList : [])

function startDirectoryPoll() {
  startMdnsWatch()
  const tick = async () => {
    if (polling) return
    polling = true
    const c = cfg()
    try {
      const r = await getDirectory(c.directory, c.key)
      if (r.status === 401) send('directory', { ok: false, error: 'the directory rejected the access key', encoders: lanEncoders() })
      else if (r.status !== 200 || !r.body) send('directory', { ok: false, error: `directory answered HTTP ${r.status}`, encoders: lanEncoders() })
      else {
        const me: string = r.body.yourIp ?? ''
        const encoders = (r.body.encoders ?? []).map((e: any) => ({
          ...e,
          path: me && e.pubIp === me && e.lanIps?.length && e.directPort > 0 ? 'lan'
              : e.relay?.port > 0 ? 'relay' : 'unreachable',
        }))
        // Encoders heard on this network by mDNS: their LAN path works whatever public address they use.
        const lan = lanEncoders()
        for (const e of encoders) if (lan.some((l: any) => l.id === e.id)) e.path = 'lan'
        for (const l of lan) if (!encoders.some((e: any) => e.id === l.id)) encoders.push(l)
        send('directory', { ok: true, yourIp: me, encoders })
        if (!directorySecret) {
          try {
            const s = await getDirectory(c.directory, c.key, '/v1/config')
            if (s.status === 200 && typeof s.body?.relaySecret === 'string') directorySecret = s.body.relaySecret
          } catch { /* retried next tick */ }
        }
      }
    } catch (e) {
      send('directory', { ok: false, error: `directory unreachable (${(e as Error).message})`, encoders: lanEncoders() })
    } finally { polling = false }
  }
  pollTimer = setInterval(tick, 1000)
  tick()
}

ipcMain.handle('test-directory', async (_, directory: string, key: string) => {
  try {
    const r = await getDirectory(directory, key)
    if (r.status === 200) return { ok: true, message: `connected - ${r.body?.encoders?.length ?? 0} encoder(s) on air` }
    if (r.status === 401) return { ok: false, message: 'reached the directory but the access key was rejected' }
    return { ok: false, message: `the server answered HTTP ${r.status}` }
  } catch (e) { return { ok: false, message: `cannot reach it (${(e as Error).message})` } }
})

// ─────────────────────────────────────────────────────────────────────────────
// Device lists
// ─────────────────────────────────────────────────────────────────────────────
// Why the last output scan found no Blackmagic card (shown on the Decoder screen), '' if nothing was wrong.
let outputNote = ''
function listDevices(binName: string): Promise<unknown[]> {
  if (binName === 'sdi_decoder.exe') outputNote = ''
  const bin = findBin(binName)
  if (!bin) { send('log', `ERROR: ${binName} not found`); return Promise.resolve([]) }
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--list'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => {
      for (const l of d.toString().split('\n')) {
        if (!l.trim()) continue
        send('log', l.trim())
        if (binName === 'sdi_decoder.exe' && /decklink:.*failed/i.test(l))
          outputNote = /CLASSNOTREG/i.test(l)
            ? 'No Blackmagic card found: Blackmagic Desktop Video is not installed on this PC (or it was installed and the PC has not been restarted since). Install Desktop Video from blackmagicdesign.com, restart, then press RESCAN.'
            : 'No Blackmagic card found: the Blackmagic driver did not respond. Check that Desktop Video is installed and the card shows in Blackmagic Desktop Video Setup, then press RESCAN.'
      }
    })
    proc.on('close', () => { try { resolve(JSON.parse(out)) } catch { resolve([]) } })
    proc.on('error', () => resolve([]))
  })
}
ipcMain.handle('scan-capture', () => listDevices('link_encoder.exe'))
ipcMain.handle('scan-output',  () => listDevices('sdi_decoder.exe'))
ipcMain.handle('output-note',  () => outputNote)

// Reads JSON lines from a stream and hands each to cb; non-JSON lines go to the log.
function lines(stream: NodeJS.ReadableStream | null, cb: (line: string) => void) {
  if (!stream) return
  let buf = ''
  stream.on('data', (d: Buffer) => {
    buf += d.toString()
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const l of parts) if (l.trim()) cb(l.trim())
  })
}

// "aja:0:2" -> { backend:'aja', device:'0', conn:'2' };  "test:1080i5994" -> { backend:'test', device:'1080i5994' }
function parseDevice(s: string) {
  const [backend, device, conn] = s.split(':')
  return { backend, device: device ?? '0', conn: conn ?? '1' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoder
// ─────────────────────────────────────────────────────────────────────────────
// One encoder process per stream (each on its own input, with its own name, LAN port and relay
// publish). Everything is keyed by the stream's id; events to the window carry that id.
interface EncRun { proc: ChildProcess | null; wanted: boolean; started: number; restart: NodeJS.Timeout | null; stoppedAt: number; closed: Promise<void> | null }
const encRuns = new Map<string, EncRun>()
const encRun = (id: string): EncRun => {
  let r = encRuns.get(id)
  if (!r) { r = { proc: null, wanted: false, started: 0, restart: null, stoppedAt: 0, closed: null }; encRuns.set(id, r) }
  return r
}
const streamCfg = (id: string) => cfg().streams.find(s => s.id === id)
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// Why this stream can't go live right now, or null.
function checkStream(id: string): string | null {
  const s = streamCfg(id)
  if (!s) return 'unknown stream'
  if (!s.name.trim()) return 'give the stream a name first'
  if (!s.device) return 'choose an input first'
  const other = cfg().streams.find(o => o.id !== id && sameName(o.name, s.name))
  if (other) return `another stream is already called "${other.name.trim()}" - names must be different`
  const busy = cfg().streams.find(o => o.id !== id && o.device === s.device && encRun(o.id).wanted)
  if (busy) return `that input is already being sent as "${busy.name.trim()}"`
  return null
}

function startEncoder(id: string): { ok: boolean; error?: string } {
  const bin = findBin('link_encoder.exe')
  if (!bin) return { ok: false, error: 'link_encoder.exe not found' }
  const err = checkStream(id)
  if (err) return { ok: false, error: err }
  const c = cfg()
  const s = streamCfg(id)!
  const d = parseDevice(s.device)
  const run = encRun(id)

  const args = [
    '--name', s.name.trim(),
    '--backend', d.backend,
    '--device', d.device,
    ...(d.backend === 'test' ? [] : ['--conn', d.conn]),
    // H.264: "gpu" (NVENC etc.) or "cpu" (x264). H.265: "hevc" (GPU chain) or libx265 on the CPU.
    '--codec', s.video === 'h265' ? (s.codec === 'cpu' ? 'libx265' : 'hevc') : s.codec,
    '--bitrate', String(s.bitrate),
    '--quality', s.quality,
    ...(s.adapt === false ? ['--no-adapt'] : []),
    ...(s.deinterlace ? ['--deinterlace'] : []),
    '--acodec', s.audio ? 'libopus' : 'none',
    '--direct-port', String(s.port),
    '--directory', c.directory,
    '--preview',
    ...(s.remote && c.relayHost ? ['--relay', c.relayHost, '--relay-latency', String(s.relayLatency)] : []),
  ]
  send('log', `[encoder ${s.name.trim()}] ${path.basename(bin)} ${args.join(' ')}`)

  run.wanted = true
  run.started = Date.now()
  const proc = spawn(bin, args, {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LINK_KEY: c.key, LINK_RELAY_SECRET: currentRelaySecret() },
  })
  run.proc = proc
  lines(proc.stdout, (l) => {
    if (run.proc !== proc) {   // stopped: its last lines must not flip the window back to live
      if (monRun(id).proc !== proc) return
      try { const m = JSON.parse(l); if (m.type === 'preview') send('encoder-preview', id, m.jpg) } catch { /* not ours */ }   // ...but it is now the monitor
      return
    }
    try {
      const m = JSON.parse(l)
      if (m.type === 'preview') send('encoder-preview', id, m.jpg)   // monitor picture, not a stats line
      else send('encoder-stats', id, m)
    } catch { send('log', l) }
  })
  lines(proc.stderr, (l) => send('log', `[${s.name.trim()}] ${l}`))
  proc.on('error', (e) => send('log', `encoder failed to start: ${e.message}`))
  proc.on('close', (code) => {
    const mon = monRun(id)
    if (run.proc !== proc && mon.proc === proc) {   // it had become the monitor
      mon.proc = null; mon.device = ''
      send('encoder-preview', id, '')
      if (mon.wanted && !run.wanted) mon.retry = setTimeout(() => spawnMonitor(id), 1000)
      return
    }
    if (run.proc !== proc) return
    run.proc = null
    const ranFor = Date.now() - run.started
    // A crash after a healthy run is retried; a failure right at start (no signal, card busy)
    // is reported instead of looping.
    const retry = run.wanted && ranFor > 15000
    run.stoppedAt = Date.now()
    send('encoder-exit', id, { code, retrying: retry })
    if (retry) run.restart = setTimeout(() => { if (run.wanted && !run.proc) startEncoder(id) }, 2000)
    else run.wanted = false
  })
  return { ok: true }
}

function stopEncoder(id: string, graceful = true, handoff = false) {
  const run = encRun(id)
  run.wanted = false
  run.stoppedAt = Date.now()
  if (run.restart) { clearTimeout(run.restart); run.restart = null }
  const p = run.proc
  run.proc = null
  if (!p) return
  // STOP from the window: the encoder stops sending but keeps the input open and carries on as this
  // stream's monitor, so the picture never drops out (no card release and reopen).
  const dev = streamCfg(id)?.device
  if (graceful && handoff && dev && p.stdin?.writable) {
    try {
      p.stdin.write('idle\n')
      const m = monRun(id)
      if (m.retry) { clearTimeout(m.retry); m.retry = null }
      m.proc = p; m.device = dev; m.wanted = dev
      return
    } catch { /* fall through to a normal stop */ }
  }
  try { if (graceful) p.stdin?.write('quit\n') } catch { /* closed */ }
  setTimeout(() => kill(p), graceful ? 1500 : 0)
}

function stopAllEncoders(graceful = true) { for (const id of [...encRuns.keys()]) stopEncoder(id, graceful) }

// ── Input monitors: show each stream's input before going live ──────────────
// A capture input can be opened once, so a stream's monitor (capture + preview only) is stopped,
// and the input released, before its real encoder starts, and comes back after STOP.
interface MonRun { proc: ChildProcess | null; device: string; wanted: string; retry: NodeJS.Timeout | null }
const monRuns = new Map<string, MonRun>()
const monRun = (id: string): MonRun => {
  let r = monRuns.get(id)
  if (!r) { r = { proc: null, device: '', wanted: '', retry: null }; monRuns.set(id, r) }
  return r
}

function stopMonitor(id: string): Promise<void> {
  const m = monRun(id)
  m.wanted = ''
  if (m.retry) { clearTimeout(m.retry); m.retry = null }
  const p = m.proc
  m.proc = null; m.device = ''
  if (!p) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(() => { kill(p); resolve() }, 2000)
    p.once('close', () => { clearTimeout(t); resolve() })
    try { p.stdin?.write('quit\n') } catch { kill(p) }
  })
}

function stopAllMonitors(): Promise<void> { return Promise.all([...monRuns.keys()].map(stopMonitor)).then(() => undefined) }

function spawnMonitor(id: string) {
  const m = monRun(id)
  m.retry = null
  const bin = findBin('link_encoder.exe')
  if (!bin || !m.wanted || encRun(id).wanted || m.proc) return
  const device = m.wanted
  const d = parseDevice(device)
  const args = ['--name', 'monitor', '--backend', d.backend, '--device', d.device,
                ...(d.backend === 'test' ? [] : ['--conn', d.conn]), '--monitor']
  const proc = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  m.proc = proc; m.device = device
  let lastPic = Date.now() + 3000   // grace while the input opens
  lines(proc.stdout, (l) => { try { const j = JSON.parse(l); if (j.type === 'preview') { lastPic = Date.now(); send('encoder-preview', id, j.jpg) } } catch { /* not ours */ } })
  // A monitor that opened the card while it was still being released can sit on one frozen
  // picture: if no new picture arrives, restart it.
  const dog = setInterval(() => { if (m.proc === proc && Date.now() - lastPic > 3000) kill(proc) }, 1000)
  proc.on('error', () => { /* handled by close */ })
  proc.on('close', () => {
    clearInterval(dog)
    if (m.proc !== proc) return
    m.proc = null; m.device = ''
    send('encoder-preview', id, '')
    // Input busy or no signal yet: keep trying while the window still wants it.
    if (m.wanted === device && !encRun(id).wanted) m.retry = setTimeout(() => spawnMonitor(id), 3000)
  })
}

ipcMain.handle('monitor-start', async (_, id: string, device: string) => {
  const m = monRun(id)
  if (!device || encRun(id).wanted) return false
  if (m.wanted === device && (m.proc || m.retry)) return true
  await stopMonitor(id)
  m.wanted = device
  // An encoder that was just stopped may still be letting go of the input.
  const er = encRun(id)
  if (er.closed) { await Promise.race([er.closed, new Promise(r => setTimeout(r, 3000))]); er.closed = null }
  const wait = er.stoppedAt && Date.now() - er.stoppedAt < 3000 ? 400 : 0
  m.retry = setTimeout(() => spawnMonitor(id), wait)
  return true
})
// ── Quality test: encode a live clip with every quality profile and report the scores ──
// Needs the input to itself, so the stream's monitor is paused for the ~1 minute it takes.
let qtestProc: ChildProcess | null = null
ipcMain.handle('quality-test', async (_, id: string) => {
  const s = streamCfg(id)
  const bin = findBin('link_encoder.exe')
  if (!s || !bin) return { ok: false, error: 'link_encoder.exe not found' }
  if (!s.device) return { ok: false, error: 'choose an input first' }
  if (encRun(id).wanted) return { ok: false, error: 'stop the stream first - the test needs the input to itself' }
  if (qtestProc) return { ok: false, error: 'a test is already running' }
  await stopMonitor(id)
  const d = parseDevice(s.device)
  const ladder = [4000, 6000, 8000, 10000, 15000, 20000, 30000]
  const hi = ladder.find(v => v >= s.bitrate * 1.45) ?? ladder[ladder.length - 1]
  const args = ['--qtest', '--backend', d.backend, '--device', d.device,
                ...(d.backend === 'test' ? [] : ['--conn', d.conn]),
                '--codec', s.video === 'h265' ? (s.codec === 'cpu' ? 'libx265' : 'hevc') : s.codec,
                '--qtest-rates', hi > s.bitrate ? `${s.bitrate},${hi}` : `${s.bitrate}`]
  send('log', `[quality test ${s.name.trim()}] ${args.join(' ')}`)
  const proc = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  qtestProc = proc
  lines(proc.stdout, (l) => { try { send('quality-test', id, JSON.parse(l)) } catch { /* not ours */ } })
  lines(proc.stderr, (l) => { if (!/^diag|prewarm/.test(l)) send('log', `[quality test] ${l}`) })
  proc.on('close', (code) => {
    qtestProc = null
    send('quality-test', id, { type: 'qtest-end', code })
    // Bring the monitor back.
    const m = monRun(id)
    if (!encRun(id).wanted) { m.wanted = s.device; m.retry = setTimeout(() => spawnMonitor(id), 2200) }
  })
  return { ok: true }
})
ipcMain.handle('quality-test-cancel', () => { try { qtestProc?.stdin?.write('quit\n') } catch { /* closed */ } return true })
ipcMain.handle('monitor-stop', async (_, id: string) => { await stopMonitor(id); return true })

ipcMain.handle('encoder-start', async (_, id: string) => {
  const err = checkStream(id)
  if (err) return { ok: false, error: err }
  await stopMonitor(id)
  return startEncoder(id)
})
ipcMain.handle('encoder-stop', (_, id: string) => { stopEncoder(id, true, true); return true })
// Renaming a live stream: the name is part of what decoders and the relay see, so the stream is
// restarted under the new name (a few seconds off air).
ipcMain.handle('encoder-restart', async (_, id: string) => {
  stopEncoder(id)
  await stopMonitor(id)
  await new Promise(r => setTimeout(r, 2300))
  return startEncoder(id)
})
ipcMain.handle('encoder-bitrate', (_, id: string, kbps: number) => {
  const s = streamCfg(id)
  if (s) s.bitrate = kbps
  try { encRun(id).proc?.stdin?.write(`bitrate ${Math.round(kbps)}\n`) } catch { /* not running */ }
  return true
})

// ─────────────────────────────────────────────────────────────────────────────
// Decoder: link_decoder (discovery + path choice) supervising sdi_decoder
// ─────────────────────────────────────────────────────────────────────────────
// One link_decoder process per decoder, keyed by the decoder's id. Every event carries that id.
const decRuns = new Map<string, ChildProcess>()
const decLast = new Map<string, unknown>()   // last link_state per decoder, for a panel that was remounted
const decCfg = (id: string) => cfg().decs.find(d => d.id === id)

const AUDIO_SENTINEL = 0xFFFFFFFF

// sdi_decoder writes raw YUV420P preview frames and S32 audio chunks to stdout:
// [u32 w][u32 h][Y][Cb][Cr]  or  [0xFFFFFFFF][rate][channels][frames][samples...]
function streamPreview(proc: ChildProcess, id: string) {
  let pending = Buffer.alloc(0)
  proc.stdout?.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 8) {
      const w = pending.readUInt32LE(0)
      if (w === AUDIO_SENTINEL) {
        if (pending.length < 16) break
        const rate = pending.readUInt32LE(4), ch = pending.readUInt32LE(8), n = pending.readUInt32LE(12)
        const total = 16 + n * ch * 4
        if (pending.length < total) break
        const pcm = pending.slice(16, total)
        pending = pending.slice(total)
        send('preview-audio', id, rate, ch, pcm)
        continue
      }
      const h = pending.readUInt32LE(4)
      if (w === 0 || h === 0 || w > 7680 || h > 4320) { pending = pending.slice(1); continue }
      const total = 8 + (w * h * 3) / 2
      if (pending.length < total) break
      const yuv = pending.slice(8, total)
      pending = pending.slice(total)
      send('preview-yuv', id, w, h, yuv)
    }
    if (pending.length > 16_000_000) pending = Buffer.alloc(0)
  })
}

// Two decoders cannot drive the same SDI output.
function checkDecoder(id: string): string | null {
  const d = decCfg(id)
  if (!d) return 'unknown decoder'
  if (d.output !== 'preview') {
    const other = cfg().decs.find(o => o.id !== id && o.output === d.output && decRuns.has(o.id))
    if (other) return 'that SDI output is already used by another decoder'
  }
  return null
}

function startDecoder(id: string, select: string): { ok: boolean; error?: string } {
  const bin = findBin('link_decoder.exe')
  if (!bin) return { ok: false, error: 'link_decoder.exe not found' }
  if (!findBin('sdi_decoder.exe')) return { ok: false, error: 'sdi_decoder.exe not found' }
  const err = checkDecoder(id)
  if (err) return { ok: false, error: err }
  stopDecoder(id)
  const c = cfg()
  const d = decCfg(id)!
  const out = d.output === 'preview' ? null : parseDevice(d.output)
  // With several decoders the monitor pictures are small and slower: four full-size ones would
  // move hundreds of MB/s through the app. SDI output is always full size.
  const multi = c.decs.length > 1
  const args = [
    '--directory', c.directory,
    ...(select ? ['--select', select] : []),
    '--lan-latency', String(d.lanLatency),
    '--relay-latency', String(d.relayLatency),
    '--',
    ...(out ? ['--backend', out.backend, '--device', out.device, '--conn', out.conn, '--achannels', '2', ...(d.outLevels === 'full' || d.outLevels === 'soft' ? ['--out-range', 'full'] : []),
                                    ...(d.whiteLevel < 100 ? ['--white-level', String(d.whiteLevel)] : [])] : ['--preview-only']),
    ...(multi ? ['--preview-width', '640'] : []),
  ]
  send('log', `[decoder ${id}] ${path.basename(bin)} ${args.join(' ')}`)
  const proc = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LINK_KEY: c.key } })
  decRuns.set(id, proc)
  streamPreview(proc, id)
  lines(proc.stderr, (l) => {
    if (l.startsWith('{')) {
      try {
        const j = JSON.parse(l)
        if (j.type === 'link_state') { decLast.set(id, j); send('decoder-state', id, j); return }
        if (j.type === 'decoder_stats') { send('decoder-stats', id, j); return }
      } catch { /* fall through to log */ }
    }
    send('log', `[decoder ${id}] ${l}`)
  })
  proc.on('error', (e) => send('log', `decoder failed to start: ${e.message}`))
  proc.on('close', (code) => {
    if (decRuns.get(id) === proc) { decRuns.delete(id); decLast.delete(id); send('decoder-state', id, { type: 'link_state', state: 'stopped' }) }
    send('log', `[decoder ${id}] link_decoder ended (code ${code})`)
  })
  return { ok: true }
}

function stopDecoder(id: string) {
  const p = decRuns.get(id)
  decRuns.delete(id)
  decLast.delete(id)
  if (!p) return
  try { p.stdin?.write('quit\n') } catch { /* closed */ }
  setTimeout(() => kill(p), 800)
}

function stopAllDecoders() { for (const id of [...decRuns.keys()]) stopDecoder(id) }

ipcMain.handle('decoder-start', (_, id: string, select: string) => startDecoder(id, select))
ipcMain.handle('decoder-select', (_, id: string, name: string) => {
  try { decRuns.get(id)?.stdin?.write(`select ${name}\n`); return true } catch { return false }
})
ipcMain.handle('decoder-sync', (_, id: string) => (decRuns.has(id) ? decLast.get(id) ?? { state: 'connecting' } : null))
ipcMain.handle('decoder-stop', (_, id: string) => { stopDecoder(id); return true })
