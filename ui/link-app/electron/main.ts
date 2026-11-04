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
  stopEncoder(false)
  stopDecoder()
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
interface Config {
  mode: 'encoder' | 'decoder'
  directory: string
  key: string
  relayHost: string
  relaySecret: string
  enc: { name: string; device: string; codec: 'gpu' | 'cpu'; bitrate: number; audio: boolean; remote: boolean; relayLatency: number }
  dec: { output: string; lanLatency: number; relayLatency: number; selected: string; monitorAudio: boolean }
}

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
    key: '',
    relayHost: '5.78.236.254',
    relaySecret,
    enc: { name: '', device: '', codec: 'gpu', bitrate: 10000, audio: true, remote: true, relayLatency: 100 },
    dec: { output: 'preview', lanLatency: 40, relayLatency: 100, selected: '', monitorAudio: false },
  }
}

const configFile = () => path.join(app.getPath('userData'), 'config.json')

function loadConfig(): Config {
  const d = defaultConfig()
  try {
    const j = JSON.parse(fs.readFileSync(configFile(), 'utf-8'))
    return { ...d, ...j, enc: { ...d.enc, ...(j.enc ?? {}) }, dec: { ...d.dec, ...(j.dec ?? {}) } }
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
function getDirectory(directory: string, key: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let u: URL
    try { u = new URL(directory.includes('://') ? directory : `http://${directory}`) } catch { reject(new Error('bad directory address')); return }
    const req = http.request({
      method: 'GET', host: u.hostname, port: Number(u.port) || 80, path: '/v1/encoders',
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

function startDirectoryPoll() {
  const tick = async () => {
    if (polling) return
    polling = true
    const c = cfg()
    try {
      const r = await getDirectory(c.directory, c.key)
      if (r.status === 401) send('directory', { ok: false, error: 'the directory rejected the access key', encoders: [] })
      else if (r.status !== 200 || !r.body) send('directory', { ok: false, error: `directory answered HTTP ${r.status}`, encoders: [] })
      else {
        const me: string = r.body.yourIp ?? ''
        const encoders = (r.body.encoders ?? []).map((e: any) => ({
          ...e,
          path: me && e.pubIp === me && e.lanIps?.length && e.directPort > 0 ? 'lan'
              : e.relay?.port > 0 ? 'relay' : 'unreachable',
        }))
        send('directory', { ok: true, yourIp: me, encoders })
      }
    } catch (e) {
      send('directory', { ok: false, error: `directory unreachable (${(e as Error).message})`, encoders: [] })
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
function listDevices(binName: string): Promise<unknown[]> {
  const bin = findBin(binName)
  if (!bin) { send('log', `ERROR: ${binName} not found`); return Promise.resolve([]) }
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--list'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) send('log', l.trim()) })
    proc.on('close', () => { try { resolve(JSON.parse(out)) } catch { resolve([]) } })
    proc.on('error', () => resolve([]))
  })
}
ipcMain.handle('scan-capture', () => listDevices('link_encoder.exe'))
ipcMain.handle('scan-output',  () => listDevices('sdi_decoder.exe'))

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
let encProc: ChildProcess | null = null
let encWanted = false
let encStarted = 0
let encRestart: NodeJS.Timeout | null = null

function startEncoder(): { ok: boolean; error?: string } {
  const bin = findBin('link_encoder.exe')
  if (!bin) return { ok: false, error: 'link_encoder.exe not found' }
  const c = cfg()
  if (!c.enc.name.trim()) return { ok: false, error: 'give the encoder a name first' }
  if (!c.enc.device) return { ok: false, error: 'choose an input first' }
  const d = parseDevice(c.enc.device)

  const args = [
    '--name', c.enc.name.trim(),
    '--backend', d.backend,
    '--device', d.device,
    ...(d.backend === 'test' ? [] : ['--conn', d.conn]),
    '--codec', c.enc.codec,
    '--bitrate', String(c.enc.bitrate),
    '--acodec', c.enc.audio ? 'libopus' : 'none',
    '--direct-port', '4200',
    '--directory', c.directory,
    ...(c.enc.remote && c.relayHost ? ['--relay', c.relayHost, '--relay-latency', String(c.enc.relayLatency)] : []),
  ]
  send('log', `[encoder] ${path.basename(bin)} ${args.join(' ')}`)

  encWanted = true
  encStarted = Date.now()
  const proc = spawn(bin, args, {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LINK_KEY: c.key, LINK_RELAY_SECRET: c.relaySecret },
  })
  encProc = proc
  lines(proc.stdout, (l) => { try { send('encoder-stats', JSON.parse(l)) } catch { send('log', l) } })
  lines(proc.stderr, (l) => send('log', l))
  proc.on('error', (e) => send('log', `encoder failed to start: ${e.message}`))
  proc.on('close', (code) => {
    if (encProc !== proc) return
    encProc = null
    const ranFor = Date.now() - encStarted
    // A crash after a healthy run is retried; a failure right at start (no signal, card busy)
    // is reported instead of looping.
    const retry = encWanted && ranFor > 15000
    send('encoder-exit', { code, retrying: retry })
    if (retry) encRestart = setTimeout(() => { if (encWanted && !encProc) startEncoder() }, 2000)
    else encWanted = false
  })
  return { ok: true }
}

function stopEncoder(graceful = true) {
  encWanted = false
  if (encRestart) { clearTimeout(encRestart); encRestart = null }
  const p = encProc
  encProc = null
  if (!p) return
  try { if (graceful) p.stdin?.write('quit\n') } catch { /* closed */ }
  setTimeout(() => kill(p), graceful ? 1500 : 0)
}

ipcMain.handle('encoder-start', () => startEncoder())
ipcMain.handle('encoder-stop', () => { stopEncoder(); return true })
ipcMain.handle('encoder-bitrate', (_, kbps: number) => {
  cfg().enc.bitrate = kbps
  try { encProc?.stdin?.write(`bitrate ${Math.round(kbps)}\n`) } catch { /* not running */ }
  return true
})

// ─────────────────────────────────────────────────────────────────────────────
// Decoder: link_decoder (discovery + path choice) supervising sdi_decoder
// ─────────────────────────────────────────────────────────────────────────────
let decProc: ChildProcess | null = null

const AUDIO_SENTINEL = 0xFFFFFFFF

// sdi_decoder writes raw YUV420P preview frames and S32 audio chunks to stdout:
// [u32 w][u32 h][Y][Cb][Cr]  or  [0xFFFFFFFF][rate][channels][frames][samples...]
function streamPreview(proc: ChildProcess) {
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
        send('preview-audio', rate, ch, pcm)
        continue
      }
      const h = pending.readUInt32LE(4)
      if (w === 0 || h === 0 || w > 7680 || h > 4320) { pending = pending.slice(1); continue }
      const total = 8 + (w * h * 3) / 2
      if (pending.length < total) break
      const yuv = pending.slice(8, total)
      pending = pending.slice(total)
      send('preview-yuv', w, h, yuv)
    }
    if (pending.length > 16_000_000) pending = Buffer.alloc(0)
  })
}

function startDecoder(select: string): { ok: boolean; error?: string } {
  const bin = findBin('link_decoder.exe')
  if (!bin) return { ok: false, error: 'link_decoder.exe not found' }
  if (!findBin('sdi_decoder.exe')) return { ok: false, error: 'sdi_decoder.exe not found' }
  stopDecoder()
  const c = cfg()
  const out = c.dec.output === 'preview' ? null : parseDevice(c.dec.output)
  const args = [
    '--directory', c.directory,
    ...(select ? ['--select', select] : []),
    '--lan-latency', String(c.dec.lanLatency),
    '--relay-latency', String(c.dec.relayLatency),
    '--',
    ...(out ? ['--backend', out.backend, '--device', out.device, '--conn', out.conn, '--achannels', '2'] : ['--preview-only']),
  ]
  send('log', `[decoder] ${path.basename(bin)} ${args.join(' ')}`)
  const proc = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LINK_KEY: c.key } })
  decProc = proc
  streamPreview(proc)
  lines(proc.stderr, (l) => {
    if (l.startsWith('{')) {
      try {
        const j = JSON.parse(l)
        if (j.type === 'link_state') { send('decoder-state', j); return }
        if (j.type === 'decoder_stats') { send('decoder-stats', j); return }
      } catch { /* fall through to log */ }
    }
    send('log', l)
  })
  proc.on('error', (e) => send('log', `decoder failed to start: ${e.message}`))
  proc.on('close', (code) => { if (decProc === proc) { decProc = null; send('decoder-state', { type: 'link_state', state: 'stopped' }) } send('log', `link_decoder ended (code ${code})`) })
  return { ok: true }
}

function stopDecoder() {
  const p = decProc
  decProc = null
  if (!p) return
  try { p.stdin?.write('quit\n') } catch { /* closed */ }
  setTimeout(() => kill(p), 800)
}

ipcMain.handle('decoder-start', (_, select: string) => startDecoder(select))
ipcMain.handle('decoder-select', (_, name: string) => {
  try { decProc?.stdin?.write(`select ${name}\n`); return true } catch { return false }
})
ipcMain.handle('decoder-stop', () => { stopDecoder(); return true })
