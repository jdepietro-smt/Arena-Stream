import { app, BrowserWindow, ipcMain, dialog } from 'electron'

app.setName('Arena Stream')
app.setAppUserModelId('com.smt.arenastream')
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as net from 'net'
import * as dgram from 'dgram'
import * as http from 'http'

// ─────────────────────────────────────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────────────────────────────────────
let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'Arena Stream',
    icon: path.join(__dirname, '../resources/arena_stream.ico'),
    backgroundColor: '#07070d',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#07070d',
      symbolColor: '#e8eaf0',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
    // win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  startMediaMtx()
})

app.on('window-all-closed', () => {
  win = null
  stopAll()
  kill(mediamtxProc); mediamtxProc = null
  app.quit()
})

// ─────────────────────────────────────────────────────────────────────────────
// Process management
// ─────────────────────────────────────────────────────────────────────────────
// One capture process per SDI channel (keyed by device id, e.g. "aja-0-1")
const captureProcs = new Map<string, ChildProcess>()
let captureProc:  ChildProcess | null = null   // kept for non-AJA / compat
let previewProc:  ChildProcess | null = null
let relayProc:    ChildProcess | null = null
let relayStop     = false   // set true to prevent auto-restart
let relayGen      = 0       // incremented each startRelay call; old closures bail when gen changes
let mediamtxProc: ChildProcess | null = null

const APP_DIR = path.dirname(process.execPath)
const DEV_DIR = path.join(__dirname, '../../..')

function findBin(name: string): string | null {
  const candidates = [
    path.join(APP_DIR, name),
    path.join(DEV_DIR, 'ui/electron-app/release/win-unpacked', name),  // dev mode
    path.join(DEV_DIR, 'cpp/build/Release', name),  // MSVC Release layout
    path.join(DEV_DIR, 'cpp/build', name),
    path.join(DEV_DIR, 'ui/SdiStreamUI', name),
  ]
  for (const c of candidates)
    if (fs.existsSync(c)) return c
  return null
}

function findFFmpeg(): string | null {
  // WinGet path
  const winget = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft/WinGet/Packages'
  )
  if (fs.existsSync(winget)) {
    const dirs = fs.readdirSync(winget).filter(d => d.startsWith('Gyan.FFmpeg'))
    for (const d of dirs) {
      const candidate = path.join(winget, d, 'ffmpeg-8.1.1-full_build', 'bin', 'ffmpeg.exe')
      // try glob-style
      const binDir = path.join(winget, d)
      const found = walkFind(binDir, 'ffmpeg.exe')
      if (found) return found
    }
  }
  const known = [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ]
  for (const k of known) if (fs.existsSync(k)) return k
  return null
}

function findGStreamer(): string | null {
  const candidates = [
    'C:\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe',
    'C:\\gstreamer\\1.0\\x86_64\\bin\\gst-launch-1.0.exe',
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

function walkFind(dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === name)
      return path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = walkFind(path.join(dir, entry.name), name)
      if (found) return found
    }
  }
  return null
}

function kill(proc: ChildProcess | null) {
  if (!proc) return
  try { proc.kill('SIGKILL') } catch {}
}

function stopAll() {
  relayStop = true
  for (const [, proc] of captureProcs) kill(proc)
  captureProcs.clear()
  kill(captureProc);  captureProc    = null
  kill(previewProc);  previewProc    = null
  kill(relayProc);    relayProc      = null
  activeNdiSource = ''
}

// Spawn the ffmpeg relay from local mediamtx → external SRT.
// Reads via RTSP (mediamtx default port 8554) — SRT reader connections are
// rejected by mediamtx when using source:publisher path config.
// Re-encodes audio Opus→AAC so the server receives standard AAC-in-MPEG-TS.
// Waits `initialDelay` ms before the first attempt so arena_stream has time
// to establish its publisher connection; retries every 5 s on failure.
function startRelay(streamName: string, extSrt: string, ffmpegBin: string, initialDelay = 4000) {
  relayStop = false
  const gen = ++relayGen
  const rtspUri = `rtsp://127.0.0.1:8554/${streamName}`
  const attempt = () => {
    if (relayStop || gen !== relayGen) return
    send('log', `[relay] ${rtspUri} → ${extSrt}`)
    relayProc = spawn(ffmpegBin, [
      '-rtsp_transport', 'tcp',
      '-i', rtspUri,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-f', 'mpegts', extSrt,
    ], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
    })
    let buf = ''
    relayProc.stderr?.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const l of lines) {
        const t = l.trim()
        if (t && !/configuration:|built with|^lib|Last message|^Input #|^Duration:|^Stream #|^Output #|^Metadata:|^Program \d|Resumed reading at pts|^Press \[q\]|^encoder\s*:/i.test(t))
          send('log', `[relay] ${t}`)
      }
    })
    relayProc.on('close', (code: number | null) => {
      relayProc = null
      send('log', `Relay ended (${code})`)
      if (!relayStop && gen === relayGen) setTimeout(attempt, 5000)
    })
  }
  setTimeout(attempt, initialDelay)
}

// ─────────────────────────────────────────────────────────────────────────────
// DVR reverse proxy
// Proxies the DVR web panel and rewrites /api/streams so the stream name shown
// matches what the user typed in Arena Stream rather than the DVR's hardcoded
// internal path name.
// ─────────────────────────────────────────────────────────────────────────────
let dvrProxySrv:   http.Server | null = null
let dvrProxyPort   = 0
let dvrProxyCookie = ''
let dvrProxyHost   = ''
let dvrStreamLabel = ''

function dvrDoLogin(host: string): Promise<string> {
  const body = 'password=' + encodeURIComponent('Un1ver$ity88')
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host, port: 80, path: '/login', method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      res.resume()
      const cookies = (res.headers['set-cookie'] ?? []) as string[]
      const sess = cookies.map(c => c.match(/^session=[^;]+/)?.[0]).find(Boolean)
      if (sess) resolve(sess as string)
      else reject(new Error('DVR login failed'))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function ensureDvrProxy(host: string, streamLabel: string): Promise<number> {
  dvrProxyHost   = host
  dvrStreamLabel = streamLabel
  if (dvrProxySrv) return Promise.resolve(dvrProxyPort)

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url ?? '/'
      const fwdHdrs: Record<string, string> = { host: dvrProxyHost }
      if (dvrProxyCookie) fwdHdrs['cookie'] = dvrProxyCookie
      if (req.headers['content-type'])   fwdHdrs['content-type']   = req.headers['content-type'] as string
      if (req.headers['content-length']) fwdHdrs['content-length'] = req.headers['content-length'] as string

      // Intercept /preview/*.ts — spawn ffmpeg locally reading from mediamtx SRT.
      // Output goes to a TCP loopback socket to avoid Electron's pipe:1 size limit.
      if (req.method === 'GET' && urlPath.startsWith('/preview/') && urlPath.endsWith('.ts')) {
        const rawName   = urlPath.slice('/preview/'.length, -'.ts'.length)
        const srtName   = decodeURIComponent(rawName).replace(/[^A-Za-z0-9._-]/g, '_')
        const ffmpegBin = findFFmpeg()
        send('log', `[dvr-preview] "${srtName}"`)
        if (!ffmpegBin) { res.writeHead(503); res.end('ffmpeg not found'); return }

        const tcpServer = net.createServer()
        tcpServer.listen(0, '127.0.0.1', () => {
          const tcpPort = (tcpServer.address() as { port: number }).port
          const srtUri  = `srt://127.0.0.1:8890?streamid=read:${srtName}&mode=caller&latency=80000`

          const ffProc = spawn(ffmpegBin, [
            '-i', srtUri,
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '96k',
            '-f', 'mpegts', `tcp://127.0.0.1:${tcpPort}`,
          ], { windowsHide: true, stdio: 'ignore' })

          let tcpConnected = false
          tcpServer.once('connection', (sock) => {
            tcpConnected = true
            tcpServer.close()
            res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache' })
            sock.pipe(res)
            req.on('close', () => { ffProc.kill(); sock.destroy() })
            sock.on('end', () => res.end())
          })

          ffProc.on('close', (code) => {
            tcpServer.close()
            if (!tcpConnected && !res.headersSent) {
              send('log', `[dvr-preview] ffmpeg exited ${code} before stream started`)
              res.writeHead(502); res.end('stream not available')
            }
          })
        })
        return
      }

      const upstream = http.request(
        { hostname: dvrProxyHost, port: 80, path: urlPath, method: req.method, headers: fwdHdrs },
        upRes => {
          for (const c of (upRes.headers['set-cookie'] ?? []) as string[]) {
            const m = c.match(/^session=[^;]+/)
            if (m) dvrProxyCookie = m[0]
          }

          if (urlPath.startsWith('/api/streams')) {
            let body = ''
            upRes.on('data', (chunk: Buffer) => { body += chunk.toString() })
            upRes.on('end', () => {
              try {
                const data: any[] = JSON.parse(body)
                const fixed = data.map(s => ({ ...s, name: dvrStreamLabel || s.name }))
                const out   = JSON.stringify(fixed)
                res.writeHead(200, {
                  'content-type':   'application/json',
                  'content-length': String(Buffer.byteLength(out)),
                })
                res.end(out)
              } catch {
                res.writeHead(upRes.statusCode ?? 200)
                res.end(body)
              }
            })
          } else {
            const hdrs: Record<string, any> = { ...upRes.headers }
            if (typeof hdrs['location'] === 'string' && hdrs['location'].startsWith('http://'))
              hdrs['location'] = hdrs['location'].replace(`http://${dvrProxyHost}`, `http://127.0.0.1:${dvrProxyPort}`)
            const ct = String(hdrs['content-type'] ?? '')
            if (ct.includes('text/html')) {
              let body = ''
              upRes.on('data', (d: Buffer) => { body += d.toString() })
              upRes.on('end', () => {
                body = body.replace(
                  /var hlsInst\s*=\s*new Hls\(\{[\s\S]*?\}\)[\s\S]*?window\._hlsInst\s*=\s*hlsInst/,
                  `var hlsInst = new Hls({
                    maxBufferLength: 8,
                    liveSyncDurationCount: 3,
                    startLevel: 0,
                    abrEwmaDefaultEstimate: 5000000
                })
                hlsInst.on(Hls.Events.MEDIA_ATTACHED, function() {
                    hlsInst.loadSource(src)
                })
                hlsInst.on(Hls.Events.MANIFEST_PARSED, function() {
                    v.muted = true
                    v.play().catch(function(){})
                    hlsInst.startLoad(-1)
                })
                hlsInst.on(Hls.Events.ERROR, function(ev, d) {
                    if (d.fatal) showErr('Preview unavailable.')
                })
                hlsInst.attachMedia(v)
                window._hlsInst = hlsInst`
                )
                delete hdrs['content-length']
                res.writeHead(upRes.statusCode ?? 200, hdrs)
                res.end(body)
              })
            } else {
              res.writeHead(upRes.statusCode ?? 200, hdrs)
              upRes.pipe(res)
            }
          }
        }
      )
      upstream.on('error', e => { res.writeHead(502); res.end((e as Error).message) })
      req.pipe(upstream)
    })

    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address() as { port: number }
      dvrProxyPort = addr.port
      dvrProxySrv  = server
      try { dvrProxyCookie = await dvrDoLogin(host) } catch { /* user can log in manually */ }
      resolve(dvrProxyPort)
    })
    server.on('error', reject)
  })
}

ipcMain.handle('open-dvr', async (_, opts: { host: string; streamName: string }) => {
  try {
    const port = await ensureDvrProxy(opts.host, opts.streamName)
    const win = new BrowserWindow({
      width: 1100, height: 740,
      title: `DVR Monitor — ${opts.streamName}`,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    win.setMenu(null)
    win.loadURL(`http://127.0.0.1:${port}/`)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e.message) }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// mediamtx
// ─────────────────────────────────────────────────────────────────────────────
function startMediaMtx() {
  const bin = findBin('mediamtx.exe')
  if (!bin) {
    send('log', 'mediamtx not found — HLS/WebRTC disabled')
    return
  }
  const cfg = path.join(require('os').tmpdir(), 'sdistream-mediamtx.yml')
  fs.writeFileSync(cfg, `
logLevel: warn
srtAddress: :8890
rtspAddress: :8554
api: yes
apiAddress: :9997
hlsAddress: :8888
webrtcAddress: :8889
paths:
  '~.*':
    source: publisher
`)
  mediamtxProc = spawn(bin, [cfg], { windowsHide: true })
  mediamtxProc.stderr?.on('data', d => {
    const line = d.toString().trim()
    if (line) send('log', `[mediamtx] ${line}`)
  })
  send('log', 'mediamtx started (SRT:8890  HLS:8888  API:9997)')
}

// ─────────────────────────────────────────────────────────────────────────────
// Device enumeration
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('query-formats', async (_, deviceName: string) => {
  const ffmpeg = findFFmpeg()
  if (!ffmpeg) return []

  // SDI cards (AJA, DeckLink) lock to whatever signal is present — the driver
  // does not expose a useful capability list via dshow list_options, and forcing
  // a format causes immediate failure.  Return empty so the UI doesn't constrain.
  const isSdiName = /aja|kona|corvid|decklink|blackmagic/i.test(deviceName)
  if (isSdiName) return []

  return new Promise<Array<{width: number, height: number, fps: number}>>(resolve => {
    // Use dshow list_options to get actual supported formats
    const proc = spawn(ffmpeg,
      ['-list_options', 'true', '-f', 'dshow', '-i', `video=${deviceName}`],
      { windowsHide: true })

    let output = ''
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString() })
    proc.on('close', () => {
      const formats: Array<{width: number, height: number, fps: number}> = []
      const seen = new Set<string>()
      for (const line of output.split(/\r?\n/)) {
        // Match lines like: vcodec=... min s=1280x720 fps=30 max s=1280x720 fps=30
        const m = line.match(/min s=(\d+)x(\d+) fps=(\d+)/)
        if (m) {
          const key = `${m[1]}x${m[2]}@${m[3]}`
          if (!seen.has(key)) {
            seen.add(key)
            formats.push({ width: +m[1], height: +m[2], fps: +m[3] })
          }
        }
      }
      // Sort best first
      formats.sort((a, b) => (b.width * b.height * b.fps) - (a.width * a.height * a.fps))
      resolve(formats)
    })
    setTimeout(() => { proc.kill(); resolve([]) }, 8000)
  })
})

ipcMain.handle('scan-devices', async () => {
  const ffmpeg = findFFmpeg()
  const seen = new Set<string>()
  const devices: Device[] = []

  // ── 1. SDI cards: prefer sdi_stream --list (accurate), fall back to PnP ──
  const sdiStream = findBin('arena_stream.exe')
  const ajaDevices = sdiStream ? await scanViaSdiStream(sdiStream) : await scanAjaPnp()
  for (const d of ajaDevices) {
    if (!seen.has(d.id)) { seen.add(d.id); devices.push(d) }
  }

  // ── 2. DirectShow (webcams, DeckLink, some other SDI cards) ──
  if (ffmpeg) {
    const dshowDevices = await scanDirectShow(ffmpeg)
    for (const d of dshowDevices) {
      if (!seen.has(d.id)) { seen.add(d.id); devices.push(d) }
    }
  } else {
    if (devices.length === 0)
      send('log', 'ffmpeg not found — install via: winget install Gyan.FFmpeg')
  }

  send('log', `Found ${devices.length} device(s): ${devices.map(d => d.name).join(', ') || 'none'}`)
  return devices
})

ipcMain.handle('list-codecs', async () => {
  const bin = findBin('arena_stream.exe')
  if (!bin) return []
  return new Promise<{ name: string; label: string; available: boolean }[]>(resolve => {
    const proc = spawn(bin, ['--list-codecs'], { windowsHide: true })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => {
      try { resolve(JSON.parse(out)) } catch { resolve([]) }
    })
    setTimeout(() => { proc.kill(); resolve([]) }, 5000)
  })
})

async function scanViaSdiStream(bin: string): Promise<Device[]> {
  return new Promise<Device[]>(resolve => {
    const proc = spawn(bin, ['--list'], { windowsHide: true })
    let output = ''
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
    proc.on('close', () => {
      const result: Device[] = []
      try {
        const items = JSON.parse(output.trim())
        if (Array.isArray(items)) {
          items.forEach((item: {
            index: number; device: number; channel: number;
            name: string; backend: string; source_name?: string
          }) => {
            if (item.backend === 'ndi') {
              // NDI sources: id encodes the full NDI source name (used as --device arg).
              // The "ndi::" prefix lets start-capture distinguish NDI ids from SDI ones.
              const sourceName = item.source_name ?? item.name
              const id = `ndi::${sourceName}`
              result.push({ id, name: item.name, type: 'ndi' })
              send('log', `[sdi_stream] NDI source: ${item.name}`)
            } else {
              const type = item.backend === 'aja' ? 'aja' : item.backend === 'decklink' ? 'decklink' : 'webcam'
              // Encode device+channel into id so start-capture can recover them
              const dev = item.device ?? 0
              const ch  = item.channel ?? 1
              const id  = `${item.backend}-${dev}-${ch}`
              result.push({ id, name: item.name, type })
              send('log', `[sdi_stream] found: ${item.name} (${item.backend} device=${dev} ch=${ch})`)
            }
          })
        }
      } catch { /* binary not ready or no devices */ }
      resolve(result)
    })
    setTimeout(() => { proc.kill(); resolve([]) }, 6000)   // +1s for NDI discovery
  })
}

async function scanAjaPnp(): Promise<Device[]> {
  return new Promise<Device[]>(resolve => {
    // PowerShell enumerates WDM MEDIA class devices — AJA NTV2 driver registers here.
    const ps = [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-PnpDevice | Where-Object { $_.Class -eq 'MEDIA' -and $_.Status -eq 'OK' -and $_.FriendlyName -match 'AJA' } | Select-Object FriendlyName | ConvertTo-Json -Compress`
    ]
    const proc = spawn('powershell.exe', ps, { windowsHide: true })
    let output = ''
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
    proc.on('close', () => {
      const result: Device[] = []
      try {
        let raw = JSON.parse(output.trim() || 'null')
        if (!raw) { resolve(result); return }
        if (!Array.isArray(raw)) raw = [raw]
        const seen = new Set<string>()
        raw.forEach((item: any, idx: number) => {
          const name: string = (item.FriendlyName || '').trim()
          if (!name || seen.has(name)) return
          seen.add(name)
          // Device index for arena_stream.exe: first unique AJA device = 0, second = 1, ...
          result.push({ id: `aja-${idx}`, name, type: 'aja' })
          send('log', `[pnp] AJA device found: ${name} (index ${idx})`)
        })
      } catch { /* no AJA devices or parse error */ }
      resolve(result)
    })
    setTimeout(() => { proc.kill(); resolve([]) }, 6000)
  })
}

async function scanDirectShow(ffmpeg: string): Promise<Device[]> {
  return new Promise<Device[]>(resolve => {
    const proc = spawn(ffmpeg,
      ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { windowsHide: true })

    let output = ''
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString() })
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })

    proc.on('close', () => {
      const devices: Device[] = []
      const seen = new Set<string>()
      for (const raw of output.split(/\r?\n/)) {
        const line = raw.trim()
        if (line.includes('Alternative name') || line.includes('@device_pnp')) continue
        if (!line.includes('(video)') || !line.includes('"')) continue
        const first = line.indexOf('"'), second = line.indexOf('"', first + 1)
        if (first === -1 || second === -1) continue
        const name = line.slice(first + 1, second).trim()
        if (!name || name.startsWith('@') || seen.has(name)) continue
        seen.add(name)
        devices.push({ id: name, name, type: inferType(name) })
      }
      resolve(devices)
    })
    setTimeout(() => { proc.kill(); resolve([]) }, 8000)
  })
}

// Format the mode string from sdi_stream stats for display in the UI.
// Input: "1920x1080i@59.94"  Output: "1920×1080i  59.94"
// Input: "1920x1080p@29.97"  Output: "1920×1080p  29.97"
function formatMode(raw: string): string {
  // raw = "WxHi@fps" or "WxHp@fps"
  const m = raw.match(/^(\d+)x(\d+)([ip])@([\d.]+)$/)
  if (!m) return raw
  const [, w, h, ip, fps] = m
  return `${w}×${h}${ip}  ${fps}`
}

function inferType(name: string): 'decklink' | 'aja' | 'webcam' {
  if (/blackmagic|decklink/i.test(name)) return 'decklink'
  if (/aja/i.test(name)) return 'aja'
  return 'webcam'
}

interface Device {
  id:   string
  name: string
  type: 'decklink' | 'aja' | 'webcam' | 'ndi'
}

// ─────────────────────────────────────────────────────────────────────────────
// MJPEG preview server — serves preview as multipart JPEG over HTTP.
// Renderer uses <img src="http://localhost:5101/preview"> — Chromium handles
// decode natively, zero IPC overhead, hardware accelerated.
// ─────────────────────────────────────────────────────────────────────────────
const PREVIEW_PORT = 5101
const mjpegClients = new Set<any>()

function startMjpegServer() {
  const http = require('http')
  http.createServer((req: any, res: any) => {
    if (req.url !== '/preview') { res.end(); return }
    res.writeHead(200, {
      'Content-Type':  'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    mjpegClients.add(res)
    req.on('close', () => mjpegClients.delete(res))
  }).listen(PREVIEW_PORT)
}

// Rate-limit IPC preview to 15fps — MJPEG from sdi_stream arrives at the
// Send every frame to the renderer — 30fps from sdi_stream.
// At 1280×720 q=2 each JPEG is ~200-400KB; 30fps = ~8MB/s IPC, well within
// Electron's capacity on a local machine.  No rate-limiting = no stutter.
let _lastPush = 0
const PREVIEW_IPC_INTERVAL_MS = 0   // 0 = send every frame (30fps)

function pushMjpegFrame(jpegBuf: Buffer) {
  const now = Date.now()

  // Always forward to HTTP MJPEG clients (they can handle full rate)
  const header = Buffer.from(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegBuf.length}\r\n\r\n`
  )
  const dead: any[] = []
  for (const res of mjpegClients) {
    try { res.write(Buffer.concat([header, jpegBuf, Buffer.from('\r\n')])) }
    catch { dead.push(res) }
  }
  dead.forEach(r => mjpegClients.delete(r))

  // IPC to renderer: rate-limited to avoid swamping Electron's GPU/renderer
  if (now - _lastPush < PREVIEW_IPC_INTERVAL_MS) return
  _lastPush = now

  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      const b64 = jpegBuf.toString('base64')
      win.webContents.send('preview-frame', `data:image/jpeg;base64,${b64}`)
    }
  } catch { /* window closing */ }
}

startMjpegServer()

// ─────────────────────────────────────────────────────────────────────────────
// Capture (preview + encoded stream to UDP:5200)
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle('start-capture', async (_, device: Device, opts: StreamOpts) => {
  kill(captureProc); captureProc = null
  kill(previewProc); previewProc = null
  stopBeacon()  // capture-only mode — clear any stale stream beacon

  // ── AJA path: arena_stream.exe (NTV2 SDK) → SRT → ffmpeg → MJPEG ──────────
  if (device.type === 'aja') {
    const sdiStream = findBin('arena_stream.exe')
    const ffmpeg    = findFFmpeg()

    if (!sdiStream) {
      send('log', 'ERROR: arena_stream.exe not found')
      return { ok: false, error: 'arena_stream.exe not found' }
    }

    // id format: "aja-{device}-{channel}"  e.g. "aja-0-2"
    const idParts    = device.id.split('-')   // ["aja","0","2"]
    const deviceIdx  = idParts[1] ?? '0'
    const channelNum = idParts[2] ?? '1'

    // Kill any existing capture on this specific channel (re-selecting toggles it)
    const existing = captureProcs.get(device.id)
    if (existing) { kill(existing); captureProcs.delete(device.id) }

    // sdi_stream writes MJPEG preview frames directly to stdout (no ffmpeg needed).
    // Each SDI channel gets its own sdi_stream process; they run concurrently.
    const captureArgs = [
      '--backend',   'aja',
      '--device',    deviceIdx,
      '--conn',      channelNum,
      '--codec',     opts.codec.includes('nvenc') ? opts.codec : 'libx264',
      '--bitrate',   String(opts.bitrateKbps),
      '--acodec',    (opts.audioEnabled ?? true) ? ('libopus') : 'none',
      '--achannels', '2',
      '--dest',      'none',
    ]
    send('log', `[sdi_stream] ${sdiStream} ${captureArgs.join(' ')}`)
    const proc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    captureProcs.set(device.id, proc)
    captureProc = proc  // last-clicked channel drives the shared preview panel
    streamMjpegFrames(proc)

    // stderr = JSON stats + diagnostics
    const devLabel = `SDI ${channelNum}`
    let stderrBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString()
      const lines = stderrBuf.split('\n')
      stderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t || /configuration:|built with| lib|Last message repeated/i.test(t)) continue
        if (t.startsWith('{')) {
          send('log', t)
          try {
            const fixed = t.replace(/:on([,}])/g, ':"on"$1').replace(/:off([,}])/g, ':"off"$1')
            const stat = JSON.parse(fixed)
            if (stat.mode) send('capture-format', { id: device.id, format: formatMode(stat.mode) })
            if (typeof stat.audio_captured === 'number')
              send('audio-stats', { id: device.id, captured: stat.audio_captured })
          } catch {}
        } else {
          send('log', `[aja ${devLabel}] ${t}`)
        }
      }
    })
    proc.on('close', (code: number | null) => {
      captureProcs.delete(device.id)
      if (proc === captureProc) { captureProc = null; send('capture-stopped', { code }) }
      send('log', `AJA ${devLabel} ended (${code})`)
    })
    activeCaptureType = 'aja'
    activeDeviceId    = deviceIdx
    activeChannelNum  = channelNum
    return { ok: true }
  }

  // ── NDI source path: arena_stream.exe --backend ndi → preview + optional SRT ──
  if (device.type === 'ndi') {
    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) {
      send('log', 'ERROR: arena_stream.exe not found (needed for NDI backend)')
      return { ok: false, error: 'arena_stream.exe not found' }
    }

    // id format: "ndi::Source Name"  e.g. "ndi::WORKSTATION (NDI Cam 1)"
    const sourceName = device.id.replace(/^ndi::/, '')

    const existing = captureProcs.get(device.id)
    if (existing) { kill(existing); captureProcs.delete(device.id) }

    const captureArgs = [
      '--backend',   'ndi',
      '--device',    sourceName,
      '--codec',     opts.codec.includes('nvenc') ? opts.codec : 'libx264',
      '--bitrate',   String(opts.bitrateKbps),
      '--acodec',    (opts.audioEnabled ?? true) ? ('libopus') : 'none',
      '--achannels', '2',
      '--dest',      'none',
    ]
    send('log', `[sdi_stream/ndi] ${sdiStream} ${captureArgs.join(' ')}`)

    const proc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    captureProcs.set(device.id, proc)
    captureProc = proc
    streamMjpegFrames(proc)

    let ndiStderrBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      ndiStderrBuf += d.toString()
      const lines = ndiStderrBuf.split('\n')
      ndiStderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t || /configuration:|built with| lib|Last message repeated/i.test(t)) continue
        if (t.startsWith('{')) {
          send('log', t)
          try {
            const fixed = t.replace(/:on([,}])/g, ':"on"$1').replace(/:off([,}])/g, ':"off"$1')
            const stat = JSON.parse(fixed)
            if (stat.mode) send('capture-format', { id: device.id, format: formatMode(stat.mode) })
            if (typeof stat.audio_captured === 'number')
              send('audio-stats', { id: device.id, captured: stat.audio_captured })
          } catch {}
        } else {
          send('log', `[ndi] ${t}`)
        }
      }
    })
    proc.on('close', (code: number | null) => {
      captureProcs.delete(device.id)
      if (proc === captureProc) { captureProc = null; send('capture-stopped', { code }) }
      send('log', `NDI source ended (${code})`)
    })
    activeCaptureType = 'aja'    // NDI re-uses the same sdi_stream restart logic in start-stream
    activeDeviceId    = sourceName
    activeNdiSource   = sourceName
    return { ok: true }
  }

  // ── DeckLink path via arena_stream.exe (SDK-enumerated, id = "decklink-N-M") ──
  if (device.type === 'decklink' && device.id.startsWith('decklink-')) {
    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) {
      send('log', 'ERROR: arena_stream.exe not found')
      return { ok: false, error: 'arena_stream.exe not found' }
    }

    const idParts   = device.id.split('-')   // ["decklink","0","1"]
    const deviceIdx = idParts[1] ?? '0'

    const existing = captureProcs.get(device.id)
    if (existing) { kill(existing); captureProcs.delete(device.id) }

    const captureArgs = [
      '--backend',   'decklink',
      '--device',    deviceIdx,
      '--conn',      'sdi',
      '--codec',     opts.codec.includes('nvenc') ? opts.codec : 'libx264',
      '--bitrate',   String(opts.bitrateKbps),
      '--acodec',    (opts.audioEnabled ?? true) ? ('libopus') : 'none',
      '--achannels', '2',
      '--dest',      'none',
    ]
    send('log', `[arena_stream] ${sdiStream} ${captureArgs.join(' ')}`)
    const proc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    captureProcs.set(device.id, proc)
    captureProc = proc
    streamMjpegFrames(proc)

    let stderrBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString()
      const lines = stderrBuf.split('\n')
      stderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        const m = line.match(/"mode":"([^"]+)"/)
        if (m) send('format-changed', { id: device.id, format: formatMode(m[1]) })
        if (line.trim()) send('log', `[decklink] ${line}`)
      }
    })
    proc.on('close', (code: number | null) => {
      captureProcs.delete(device.id)
      if (proc === captureProc) { captureProc = null; send('capture-stopped', { code }) }
      send('log', `DeckLink capture ended (${code})`)
    })
    activeCaptureType = 'decklink'
    activeDeviceId    = device.id
    return { ok: true }
  }

  // ── Webcam / DeckLink path (DirectShow via GStreamer or ffmpeg) ───────────
  activeCaptureType = device.type === 'decklink' ? 'decklink' : 'webcam'
  const gst = findGStreamer()
  const ffmpeg = findFFmpeg()

  if (!gst && !ffmpeg) return { ok: false, error: 'No capture engine found' }

  if (gst) {
    // GStreamer pipeline
    const src    = gstSource(device, opts)
    const enc    = gstEncoder(opts)
    const parser = opts.codec.includes('hevc') ? 'h265parse' : 'h264parse config-interval=-1'

    const pipeline = [
      src,
      '! videoconvert',
      '! tee name=t',
      // Preview branch
      `t. ! queue max-size-buffers=2 leaky=downstream`,
      `! videoscale ! video/x-raw,width=640,height=480`,
      '! videoconvert ! video/x-raw,format=BGR',
      '! fdsink fd=1 sync=false',
      // Stream branch
      't. ! queue max-size-buffers=4 leaky=downstream',
      '! videoconvert ! video/x-raw,format=I420',
      `! ${enc}`,
      `! ${parser}`,
      '! mpegtsmux',
      '! udpsink host=127.0.0.1 port=5200 sync=false',
    ].join(' ')

    send('log', `[gst] ${pipeline}`)
    captureProc = spawn(gst, ['-q', pipeline], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    // FFmpeg via DirectShow
    // SDI devices (AJA, DeckLink) negotiate format with the driver — never force
    // pixel_format/video_size/framerate; those constraints cause immediate failure
    // when the driver is locked to a broadcast format like 1080i59.94.
    // Webcams need them for a stable capture mode, so we only add them for non-SDI.
    const encFlags = encFlagsForCodec(opts.codec, opts.fps)
    const isSdi = device.type === 'decklink'  // AJA handled above; only decklink reaches here
    const inputArgs: string[] = isSdi
      ? ['-f', 'dshow', '-rtbufsize', '700M']
      : [
          '-f', 'dshow', '-rtbufsize', '200M',
          '-pixel_format', 'yuyv422',
          '-video_size',   `${opts.width || 1280}x${opts.height || 720}`,
          '-framerate',    String(opts.fps || 30),
        ]

    const args = [
      ...inputArgs,
      '-i', `video=${device.name}`,
      '-filter_complex',
      `[0:v]split=2[raw1][raw2];[raw1]format=yuv420p[s];[raw2]scale=640:360,format=yuv420p[p]`,
      '-map', '[s]', '-c:v', opts.codec,
      ...encFlags,
      '-b:v', `${opts.bitrateKbps}k`, '-an', '-f', 'mpegts', 'udp://127.0.0.1:5200',
      '-map', '[p]', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'mjpeg', 'pipe:1',
    ]
    send('log', `[ffmpeg] ${ffmpeg} ${args.join(' ')}`)
    captureProc = spawn(ffmpeg!, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  // Push MJPEG frames to the HTTP preview server
  streamMjpegFrames(captureProc)

  captureProc.stderr?.on('data', d => {
    const line = d.toString().trim()
    if (!line) return
    if (/configuration:|built with| lib|Last message repeated|too full/i.test(line)) return
    send('log', formatFfmpegStats(line))
  })
  captureProc.on('close', code => {
    send('capture-stopped', { code })
    send('log', `Capture ended (${code})`)
  })

  return { ok: true }
})

// Raw YUV420P frame parser.
// Wire format: [uint32 LE width][uint32 LE height][Y plane][Cb plane][Cr plane]
// Sends every complete frame to the renderer as raw binary — no JPEG, no artifacts.
function streamMjpegFrames(proc: ChildProcess) {
  if (!proc.stdout) return
  let pending = Buffer.alloc(0)

  proc.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])

    // Drain all complete frames from the buffer
    while (pending.length >= 8) {
      const w = pending.readUInt32LE(0)
      const h = pending.readUInt32LE(4)
      if (w === 0 || h === 0 || w > 7680 || h > 4320) {
        // Bad header — resync by scanning for a plausible width/height pair
        pending = pending.slice(1); continue
      }
      const frameBytes = w * h * 3 / 2   // YUV420P
      const total = 8 + frameBytes
      if (pending.length < total) break   // wait for more data

      const yuv = pending.slice(8, total)
      pending = pending.slice(total)

      // Send raw YUV to renderer — no encoding, pure signal
      try {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('preview-yuv', w, h, yuv)
        }
      } catch {}
    }

    // Prevent runaway buffer growth (> 16MB = something is wrong)
    if (pending.length > 16_000_000) pending = Buffer.alloc(0)
  })
}

// Receive-side raw YUV parser — ffmpeg outputs headerless rawvideo, dimensions known.
function streamRawYuv(proc: ChildProcess, w: number, h: number) {
  if (!proc.stdout) return
  const frameBytes = w * h * 3 / 2   // YUV420P
  let pending = Buffer.alloc(0)

  proc.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= frameBytes) {
      const yuv = pending.slice(0, frameBytes)
      pending = pending.slice(frameBytes)
      try {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed())
          win.webContents.send('preview-yuv', w, h, yuv)
      } catch {}
    }
    if (pending.length > 16_000_000) pending = Buffer.alloc(0)
  })
}

ipcMain.handle('stop-capture', () => {
  kill(captureProc); captureProc = null
  return { ok: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// Stream (SRT out to network)
// For AJA: restart sdi_stream with --dest2 = external SRT listener, keeping
//          --dest = local preview decoder (port 5200).
// For webcam/DirectShow: relay from local UDP:5200 → SRT via ffmpeg.
// ─────────────────────────────────────────────────────────────────────────────

// Track the active capture device so start-stream knows which relay strategy to use.
let activeCaptureType: 'aja' | 'decklink' | 'webcam' | null = null
let activeDeviceId: string = '0'
let activeChannelNum: string = '1'  // AJA SDI channel (1-8)
let activeNdiSource: string = ''   // full NDI source name when activeCaptureType = 'ndi' (via aja path)

ipcMain.handle('start-stream', async (_, opts: StreamOpts) => {
  kill(relayProc); relayProc = null

  const lat        = opts.latencyMs ?? 150
  const port       = opts.destPort  ?? 4200
  const destIp     = opts.destIp?.trim()    || ''
  const relayUrl   = opts.relayUrl?.trim()  || ''
  const streamName = opts.streamName?.trim() || `sdi-${activeDeviceId}`
  const localIp    = getLocalIp()

  // Keep DVR proxy label in sync so an open DVR Monitor window picks up the name change
  if (relayUrl) {
    const stripped  = relayUrl.replace(/^(https?|srt):\/\//, '')
    dvrProxyHost   = stripped.includes('@') ? stripped.split('@')[1].split(':')[0] : stripped.split(':')[0]
    dvrStreamLabel = streamName
  }

  const protocol = opts.protocol || 'srt'

  // ── UDP (GStreamer point-to-point) ──────────────────────────────────────────
  // Plain MPEG-TS over UDP: push to destIp:port.  No handshake, no error
  // correction.  Any GStreamer / ffplay / VLC receiver can consume it directly.
  if (protocol === 'udp' || protocol === 'rtp') {
    if (!destIp) return { ok: false, error: 'DEST IP required for UDP/RTP mode' }
    const destUri  = protocol === 'rtp' ? `rtp://${destIp}:${port}` : `udp://${destIp}:${port}`
    const viewUri  = destUri
    send('log', `[${protocol}] pushing to ${destUri}`)
    startBeacon(streamName, port, '', opts.codec, '', opts.bitrateKbps)
    // Fall through to AJA path with destUri as the destination
    if (activeCaptureType === 'aja') {
      const sdiStream = findBin('arena_stream.exe')
      if (!sdiStream) return { ok: false, error: 'arena_stream.exe not found' }
      const udpBackend = activeNdiSource ? 'ndi' : 'aja'
      const udpDevice  = activeNdiSource || activeDeviceId
      const captureArgs = [
        '--backend', udpBackend, '--device', udpDevice,
        '--codec',   opts.codec.includes('nvenc') ? opts.codec : 'libx264',
        '--bitrate', String(opts.bitrateKbps),
        // RTP muxer is single-stream (video only) — audio would corrupt the H.264
        // RTP session.  Optics PRO doesn't have an audio branch in its GStreamer
        // pipeline anyway, so there is nothing to send audio to.
        '--acodec',  (protocol === 'rtp') ? 'none' : ((opts.audioEnabled ?? true) ? ('libopus') : 'none'),  // RTP is video-only
        '--achannels', '2',
        '--dest',    destUri,
      ]
      kill(captureProc); captureProc = null
      await new Promise(r => setTimeout(r, 300))
      send('log', `[sdi_stream] ${protocol} → ${destUri}${protocol === 'rtp' ? ' (audio disabled — RTP is video-only)' : ''}`)
      captureProc = spawn(sdiStream, captureArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      streamMjpegFrames(captureProc)
      let buf = ''
      captureProc.stderr?.on('data', (d: Buffer) => {
        buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop() ?? ''
        for (const l of ls) { const t = l.trim(); if (!t || /built with| lib/i.test(t)) continue; send('log', t.startsWith('{') ? t : `[aja] ${t}`) }
      })
      captureProc.on('close', (code: number | null) => { captureProc = null; send('stream-stopped', { code }) })
      activeCaptureType = 'aja'
      send('stream-url', viewUri)
      return { ok: true, viewerUri: viewUri }
    }
    return { ok: false, error: 'UDP mode only supported with AJA backend' }
  }

  // ── NDI (LAN broadcast, no SRT) ────────────────────────────────────────────
  if (protocol === 'ndi') {
    if (activeCaptureType !== 'aja') {
      return { ok: false, error: 'NDI output only supported with AJA/SDI backend' }
    }
    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) return { ok: false, error: 'arena_stream.exe not found' }

    const captureBackend = activeNdiSource ? 'ndi' : 'aja'
    const captureDevice  = activeNdiSource || activeDeviceId
    const ndiName = opts.ndiName?.trim() || 'SDI Stream'

    const captureArgs = [
      '--backend',   captureBackend,
      '--device',    captureDevice,
      '--codec',     opts.codec.includes('nvenc') ? opts.codec : 'libx264',
      '--bitrate',   String(opts.bitrateKbps),
      '--acodec',    (opts.audioEnabled ?? true) ? ('libopus') : 'none',
      '--achannels', '2',
      '--dest',      'none',
      '--ndi-out',
      '--ndi-name',  ndiName,
    ]
    kill(captureProc); captureProc = null
    await new Promise(r => setTimeout(r, 300))
    send('log', `[ndi] broadcasting as "${ndiName}" on LAN`)
    captureProc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    streamMjpegFrames(captureProc)
    let ndiBuf = ''
    captureProc.stderr?.on('data', (d: Buffer) => {
      ndiBuf += d.toString()
      const lines = ndiBuf.split('\n'); ndiBuf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t || /configuration:|built with| lib|Last message repeated/i.test(t)) continue
        if (t.startsWith('{')) {
          send('log', t)
          // No source-list row corresponds to this NDI *broadcast output* process
          // (it isn't a capture device selection), so there's no device id to key
          // a capture-format/audio-stats event by — logging is enough here.
        } else {
          send('log', `[ndi] ${t}`)
        }
      }
    })
    captureProc.on('close', (code: number | null) => {
      captureProc = null
      send('stream-stopped', { code })
      send('log', `NDI stream ended (${code})`)
    })
    send('stream-url', `ndi://${ndiName}`)
    return { ok: true, viewerUri: `ndi://${ndiName}` }
  }

  // ── SRT (default) — relay > direct caller > listener ──────────────────────
  let externalSrt: string, viewerUri: string

  if (relayUrl) {
    // Parse optional credentials: user:pass@host[:port]
    const stripped = relayUrl.replace(/^(https?|srt):\/\//, '')
    let relayUser = '', relayPass = '', relayHost = '', relaySrtPort = 8890
    const atIdx = stripped.indexOf('@')
    if (atIdx !== -1) {
      const creds    = stripped.slice(0, atIdx)
      const hostPart = stripped.slice(atIdx + 1)
      const ci = creds.indexOf(':')
      relayUser = ci !== -1 ? creds.slice(0, ci) : creds
      relayPass = ci !== -1 ? creds.slice(ci + 1) : ''
      const hp  = hostPart.split(':')
      relayHost = hp[0]
      if (hp[1]) relaySrtPort = parseInt(hp[1])
    } else {
      const hp  = stripped.split(':')
      relayHost = hp[0]
      if (hp[1]) relaySrtPort = parseInt(hp[1])
    }
    const authPfx = relayUser && relayPass ? `${relayUser}:${relayPass}@` : ''
    const srtRelayName = streamName.replace(/[^A-Za-z0-9._-]/g, '_')
    const wanLatUs = Math.max(200, lat) * 1000  // minimum 200ms for WAN relay
    externalSrt = `srt://${authPfx}${relayHost}:${relaySrtPort}?streamid=publish:${srtRelayName}&mode=caller&latency=${wanLatUs}`
    viewerUri   = `srt://${relayHost}:${relaySrtPort}?streamid=${srtRelayName}&mode=caller&latency=${wanLatUs}`
    send('log', `[relay] publishing to ${relayHost}:${relaySrtPort} as "${streamName}"`)
  } else if (destIp && destIp !== '0.0.0.0') {
    externalSrt = `srt://${destIp}:${port}?mode=caller&latency=${lat * 1000}`
    viewerUri   = externalSrt
  } else {
    externalSrt = `srt://0.0.0.0:${port}?mode=listener&latency=${lat * 1000}`
    viewerUri   = `srt://${localIp}:${port}?mode=caller&latency=${lat * 1000}`
  }

  if (activeCaptureType === 'aja') {
    // AJA / NDI: preview is on stdout (MJPEG direct from sdi_stream), SRT goes to external.
    // Restart sdi_stream with the external dest — preview keeps working via the pipe.
    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) return { ok: false, error: 'arena_stream.exe not found' }

    const deviceIdx = activeDeviceId
    // Determine backend: if activeNdiSource is set the device was an NDI source.
    const captureBackend = activeNdiSource ? 'ndi' : 'aja'
    const captureDevice  = activeNdiSource || deviceIdx
    // Reconstruct the same device.id format used by the preview handlers
    // above, so the "go live" stats keep updating the same source-list badge
    // that showed this device during preview, instead of a global slot.
    const goLiveDeviceId = captureBackend === 'ndi'
      ? `ndi::${captureDevice}`
      : `aja-${deviceIdx}-${activeChannelNum}`

    // Push directly to the external SRT destination (server or relay URL).
    // Bypassing the local-mediamtx intermediate hop eliminates the RTSP burst/
    // timing issues that caused the ffmpeg relay to fail.
    // arena_stream's built-in ReconnectingSrtOutput handles reconnection.
    const srtSafeName = streamName.replace(/\s+/g, '_')
    const destUri = externalSrt || `srt://127.0.0.1:8890?streamid=publish:${srtSafeName}&mode=caller&latency=${lat * 1000}`
    const captureArgs = [
      '--backend',   captureBackend,
      '--device',    captureDevice,
      '--conn',      activeChannelNum,
      '--codec',     opts.codec.includes('nvenc') ? opts.codec : 'libx264',
      '--bitrate',   String(opts.bitrateKbps),
      '--acodec',    (opts.audioEnabled ?? true) ? 'libopus' : 'none',
      '--achannels', '2',
      '--dest',      destUri,
      '--latency',   String(Math.max(200, lat)),
    ]
    kill(captureProc); captureProc = null
    await new Promise(r => setTimeout(r, 300))
    send('log', `[sdi_stream/${captureBackend}] go live → ${destUri}`)
    captureProc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // stdout = binary MJPEG frames — must use streamMjpegFrames, NOT a text reader
    streamMjpegFrames(captureProc)
    // stderr = JSON stats + diagnostics
    let goLiveStderrBuf = ''
    captureProc.stderr?.on('data', (d: Buffer) => {
      goLiveStderrBuf += d.toString()
      const lines = goLiveStderrBuf.split('\n')
      goLiveStderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t || /configuration:|built with| lib|Last message repeated/i.test(t)) continue
        if (t.startsWith('{')) {
          send('log', t)
          try {
            const fixed = t.replace(/:on([,}])/g, ':"on"$1').replace(/:off([,}])/g, ':"off"$1')
            const stat = JSON.parse(fixed)
            if (stat.mode) send('capture-format', { id: goLiveDeviceId, format: formatMode(stat.mode) })
            if (typeof stat.audio_captured === 'number')
              send('audio-stats', { id: goLiveDeviceId, captured: stat.audio_captured })
          } catch {}
        } else {
          send('log', `[aja] ${t}`)
        }
      }
    })
    captureProc.on('close', (code: number | null) => {
      send('stream-stopped', { code })
      send('log', `AJA stream ended (${code})`)
    })
    startBeacon(streamName, port, '', opts.codec, `${localIp}:8890`, opts.bitrateKbps)
    send('stream-url', viewerUri)
    return { ok: true, viewerUri }
  }

  // DeckLink via arena_stream.exe (SDK-captured, id starts with "decklink-")
  if (activeCaptureType === 'decklink' && activeDeviceId?.startsWith('decklink-')) {
    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) return { ok: false, error: 'arena_stream.exe not found' }

    const idParts   = activeDeviceId.split('-')
    const deviceIdx = idParts[1] ?? '0'

    const dlSrtSafeName = streamName.replace(/\s+/g, '_')
    const dlDestUri = externalSrt || `srt://127.0.0.1:8890?streamid=publish:${dlSrtSafeName}&mode=caller&latency=${lat * 1000}`
    const captureArgs = [
      '--backend',   'decklink',
      '--device',    deviceIdx,
      '--conn',      'sdi',
      '--codec',     opts.codec.includes('nvenc') ? opts.codec : 'libx264',
      '--bitrate',   String(opts.bitrateKbps),
      '--acodec',    (opts.audioEnabled ?? true) ? 'libopus' : 'none',
      '--achannels', '2',
      '--dest',      dlDestUri,
      '--latency',   String(Math.max(200, lat)),
    ]
    kill(captureProc); captureProc = null
    await new Promise(r => setTimeout(r, 300))
    send('log', `[arena_stream/decklink] go live → ${dlDestUri}`)
    captureProc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    streamMjpegFrames(captureProc)
    let buf = ''
    captureProc.stderr?.on('data', (d: Buffer) => {
      buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop() ?? ''
      for (const l of ls) { const t = l.trim(); if (!t || /built with| lib/i.test(t)) continue; send('log', t.startsWith('{') ? t : `[decklink] ${t}`) }
    })
    captureProc.on('close', (code: number | null) => {
      captureProc = null
      send('stream-stopped', { code })
      send('log', `DeckLink stream ended (${code})`)
    })
    startBeacon(streamName, port, '', opts.codec, `${localIp}:8890`, opts.bitrateKbps)
    send('stream-url', viewerUri)
    return { ok: true, viewerUri }
  }

  // Webcam/DeckLink: ffmpeg relay from local UDP:5200 → SRT listener
  const ffmpeg = findFFmpeg()
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not found' }

  const args = [
    '-fflags', '+discardcorrupt+genpts+nobuffer',
    '-flags', 'low_delay',
    '-i', `udp://0.0.0.0:5200?overrun_nonfatal=1&fifo_size=100000`,
    '-c', 'copy',
    '-f', 'mpegts', externalSrt,
  ]

  relayProc = spawn(ffmpeg, args, { windowsHide: true })
  relayProc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (!line || /configuration:|built with| lib|Last message repeated/i.test(line)) return
    send('log', `[relay] ${line}`)
  })
  relayProc.on('close', (code: number | null) => {
    send('stream-stopped', { code })
    send('log', `Stream ended (${code})`)
  })

  startBeacon(streamName, port, '', opts.codec || '', relayUrl, opts.bitrateKbps)
  send('stream-url', viewerUri)
  return { ok: true, viewerUri }
})

ipcMain.handle('stop-stream', () => {
  relayStop = true
  kill(relayProc); relayProc = null
  stopBeacon()
  return { ok: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// Discovery beacon — broadcast stream presence so receivers can find us
// Protocol: UDP broadcast to 255.255.255.255:4210, 1s interval, JSON payload
// ─────────────────────────────────────────────────────────────────────────────
const DISCOVERY_PORT = 4210
let beaconSocket: dgram.Socket | null = null
let beaconTimer:  ReturnType<typeof setInterval> | null = null

const DISCOVERY_FILE = require('os').homedir() + '\\.sdi-streams.json'

function writeDiscoveryFile(streams: object[]) {
  try { fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(streams), 'utf8') } catch {}
}
function clearDiscoveryFile() {
  try { fs.writeFileSync(DISCOVERY_FILE, '[]', 'utf8') } catch {}
}

function startBeacon(name: string, port: number, format: string, codec: string, relay = '', bitrateKbps = 0) {
  stopBeacon()
  const ip = getLocalIp()
  const payload = Buffer.from(JSON.stringify({
    type: 'sdi-stream', name, ip, port, format, codec,
    bitrateKbps: bitrateKbps || undefined,
    relay: relay || undefined,
  }))
  beaconSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  // Write to discovery file — instant same-machine discovery (no UDP needed)
  const streamEntry = { type: 'sdi-stream', name, ip, port, format, codec,
                        bitrateKbps: bitrateKbps || undefined, relay: relay || undefined }
  writeDiscoveryFile([streamEntry])

  // Also broadcast UDP for different machines on LAN
  beaconSocket.on('error', () => {})
  const sendBeacon = () => {
    beaconSocket?.send(payload, DISCOVERY_PORT, '255.255.255.255')
    beaconSocket?.send(payload, DISCOVERY_PORT, '127.0.0.1')
  }
  beaconSocket.bind(() => {
    beaconSocket?.setBroadcast(true)
    sendBeacon()
  })
  beaconTimer = setInterval(sendBeacon, 500)
  send('log', `[beacon] broadcasting "${name}" on port ${port}`)
}

function stopBeacon() {
  clearDiscoveryFile()
  if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null }
  if (beaconSocket) { try { beaconSocket.close() } catch {} beaconSocket = null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery listener — listen for beacons from encoders on the LAN
// ─────────────────────────────────────────────────────────────────────────────
let discoverySocket: dgram.Socket | null = null
// Track when each feed was last seen so stale ones can be expired
const feedLastSeen = new Map<string, number>()

ipcMain.handle('start-discovery', () => {
  if (discoverySocket) return { ok: true }
  discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  discoverySocket.bind(DISCOVERY_PORT, () => {
    discoverySocket?.setBroadcast(true)
  })
  discoverySocket.on('message', (msg, rinfo) => {
    try {
      const beacon = JSON.parse(msg.toString())
      if (beacon.type !== 'sdi-stream') return
      // Use the actual sender IP (more reliable than self-reported)
      beacon.ip = rinfo.address
      const key = `${beacon.ip}:${beacon.port}`
      feedLastSeen.set(key, Date.now())
      send('discovered-feed', beacon)
    } catch {}
  })
  // Expire feeds not seen for 4s
  const expireTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, ts] of feedLastSeen) {
      if (now - ts > 4000) {
        feedLastSeen.delete(key)
        const [ip, portStr] = key.split(':')
        send('feed-expired', { ip, port: parseInt(portStr, 10) })
      }
    }
  }, 1000)
  discoverySocket.on('close', () => clearInterval(expireTimer))
  return { ok: true }
})

ipcMain.handle('stop-discovery', () => {
  if (discoverySocket) { try { discoverySocket.close() } catch {} discoverySocket = null }
  feedLastSeen.clear()
  return { ok: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// Receive a feed — ffmpeg SRT caller → MJPEG → Electron preview pipe
// ─────────────────────────────────────────────────────────────────────────────
let receiveProc: ChildProcess | null = null

ipcMain.handle('connect-feed', async (_, feed: { ip: string; port: number; latencyMs?: number; relay?: string; name?: string }) => {
  if (receiveProc) { kill(receiveProc); receiveProc = null }

  const ffmpeg = findFFmpeg()
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not found' }

  const lat = feed.latencyMs ?? 150
  const RW = 960, RH = 540

  // When a relay server is configured, read from its read: streamid endpoint.
  // Direct mode (no relay): connect to the encoder's local SRT listener.
  let srtUri: string
  if (feed.relay) {
    const streamName = (feed.name ?? 'sdi-0').replace(/\s+/g, '_')
    srtUri = `srt://${feed.relay}?streamid=read:${streamName}&mode=caller&latency=${lat * 1000}`
  } else {
    srtUri = `srt://${feed.ip}:${feed.port}?mode=caller&latency=${lat * 1000}`
  }

  const args = [
    '-use_wallclock_as_timestamps', '1',
    '-i', srtUri,
    '-vf', `scale=${RW}:${RH},format=yuv420p`,
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1',
  ]
  send('log', `[receive] ffmpeg ${args.join(' ')}`)
  receiveProc = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  streamRawYuv(receiveProc, RW, RH)
  receiveProc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (line && !/configuration:|built with| lib|Last message/i.test(line))
      send('log', `[receive] ${line}`)
  })
  receiveProc.on('close', (code: number | null) => {
    receiveProc = null
    send('receive-stopped', { code })
    send('log', `Receive ended (${code})`)
  })
  return { ok: true }
})

ipcMain.handle('disconnect-feed', () => {
  kill(receiveProc); receiveProc = null
  return { ok: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// RTT measurement — ping the destination IP, return {rttMs, recommendedMs}
// recommendedMs = max(ceil(rttMs × 4 × 1.2), 20)  (4× RTT + 20% headroom)
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('measure-rtt', async (_, ip: string) => {
  if (!ip || ip === '0.0.0.0') return { error: 'No destination IP set' }

  // Loopback is always <1ms — skip the ping and return the minimum
  if (ip === '127.0.0.1' || ip === 'localhost') {
    return { rttMs: 0, recommendedMs: 20 }
  }

  return new Promise(resolve => {
    // Windows: ping -n 4 <ip>  →  parse "Average = Xms"
    const proc = spawn('ping', ['-n', '4', ip], { windowsHide: true })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => {
      const m = out.match(/Average = (\d+)ms/i)
      if (!m) return resolve({ error: `Could not reach ${ip}` })
      const rttMs = parseInt(m[1], 10)
      const recommendedMs = Math.max(Math.ceil(rttMs * 4 * 1.2), 20)
      resolve({ rttMs, recommendedMs })
    })
    setTimeout(() => { proc.kill(); resolve({ error: 'Ping timed out' }) }, 8000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
interface StreamOpts {
  codec:        string
  bitrateKbps:  number
  latencyMs:    number
  destIp:       string   // destination IP for caller mode + RTT ping
  destPort:     number
  relayUrl:     string   // relay server URL — if set, publish to relay instead of direct
  streamName:   string   // stream name for relay publish (shown in receiver)
  protocol:      string   // 'srt' | 'udp' | 'rtp' | 'ndi'
  audioCodec:    string
  audioBitrateKbps: number
  audioEnabled:  boolean
  ndiName?:      string  // NDI source name (when protocol === 'ndi')
  width?:        number
  height?:       number
  fps?:          number
}

function gstSource(device: Device, _opts: StreamOpts): string {
  if (device.type === 'decklink') return `decklinkvideosrc device-number=0`
  if (device.type === 'aja')     return `ajantv2src device-identifier=0`
  const safe = device.name.replace(/"/g, '\\"')
  return `ksvideosrc device-name="${safe}"`
}

function gstEncoder(opts: StreamOpts): string {
  if (/nvenc.*hevc/i.test(opts.codec)) return `nvh265enc bitrate=${opts.bitrateKbps} zerolatency=true`
  if (/nvenc/i.test(opts.codec))       return `nvh264enc bitrate=${opts.bitrateKbps} zerolatency=true`
  return `x264enc tune=zerolatency bitrate=${opts.bitrateKbps} key-int-max=25 option-string="repeat-headers=1:bframes=0"`
}

function encFlagsForCodec(codec: string, fps = 30): string[] {
  const gop = fps * 2  // 2-second GOP
  if (/nvenc/i.test(codec)) return ['-preset', 'p4', '-bf', '0', '-g', String(gop), '-forced-idr', '1']
  return ['-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0', '-g', String(gop),
          '-x264-params', 'repeat-headers=1']
}

// Convert FFmpeg's raw stats line to human-readable format
// "frame= 729 fps= 20 q=0.0 q=3.0 size= 30749KiB bitrate=183001kbits/s speed=0.999x"
// → "frame=729  fps=20  bitrate=179 Mbps  speed=1.00x"
function formatFfmpegStats(line: string): string {
  if (!line.startsWith('frame=')) return line
  const fps     = line.match(/fps=\s*(\d+(?:\.\d+)?)/)
  const br      = line.match(/bitrate=\s*([\d.]+)kbits\/s/)
  const speed   = line.match(/speed=\s*([\d.]+)x/)
  const frame   = line.match(/frame=\s*(\d+)/)
  if (!fps && !br) return line

  const mbps = br ? (parseFloat(br[1]) / 1000).toFixed(1) : '?'
  const fpsVal = fps ? fps[1] : '?'
  const spd  = speed ? parseFloat(speed[1]).toFixed(2) : '?'
  const frm  = frame ? frame[1] : '?'
  return `frame=${frm}  fps=${fpsVal}  bitrate=${mbps} Mbps  speed=${spd}x`
}

function getLocalIp(): string {
  const os = require('os')
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

function send(channel: string, ...args: any[]) {
  win?.webContents.send(channel, ...args)
}
