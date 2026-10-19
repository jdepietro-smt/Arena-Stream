import { app, BrowserWindow, ipcMain, dialog } from 'electron'

app.setName('Arena Stream')
app.setAppUserModelId('com.smt.arenastream')
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as net from 'net'
import * as dgram from 'dgram'
import * as http from 'http'
import { SRT_PASSPHRASE_FALLBACK } from './secrets'

// ─────────────────────────────────────────────────────────────────────────────
// SRT passphrase fallback — read once from a userData-local file so going
// live works even when Settings' passphrase field was never filled in
// (avoids requiring it to be typed on machines where pasting isn't available).
// ─────────────────────────────────────────────────────────────────────────────
// Last value successfully read from disk, if any.
let cachedFallbackPassphrase: string | null = null

// Hard, guaranteed-available last resort. The file-based fallback below has
// proven unreliable across many live sessions: fs.readFileSync on this exact,
// unchanged file (independently re-verified present and readable via
// PowerShell/plain Node at the same moments Electron was getting ENOENT)
// intermittently — and on at least one session, consistently — fails, even
// with a 3-attempt retry loop, a cross-click cache, and a startup warmup all
// in place. Whatever OS-level cause that is (real-time AV was confirmed OFF,
// so it isn't that), it kept breaking Go Live mid-broadcast, which matters
// more than avoiding a bundled copy. The value itself lives in the
// gitignored electron/secrets.ts (see secrets.example.ts) so it never
// lands in git history; it must match mediamtx's SRT_PUBLISH_PASSPHRASE.
const HARDCODED_FALLBACK_PASSPHRASE = SRT_PASSPHRASE_FALLBACK

function readFallbackPassphrase(): string {
  const p = path.join(app.getPath('userData'), 'srt-passphrase.txt')
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim()
      cachedFallbackPassphrase = v
      send('log', `[srt-passphrase-fallback] read ${v.length} chars from ${p}`)
      return v
    } catch {
      // Not logged per-attempt anymore — this fails reliably enough on this
      // machine that logging every retry was just noise (and, launched via
      // the desktop .bat, console.log writes into the terminal window
      // behind the app, which can pull it to the front). The single
      // outcome below (cache hit or hardcoded fallback) is all that
      // actually matters, since either one keeps Go Live working.
      if (attempt < 3) {
        // Synchronous, deliberately brief — this runs inline in the go-live
        // handler, so a few ms of blocking here is preferable to silently
        // publishing without a passphrase and getting rejected by the relay.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
  }
  if (cachedFallbackPassphrase !== null) {
    send('log', `[srt-passphrase-fallback] FAILED reading ${p} after 3 attempts — using last known-good value (${cachedFallbackPassphrase.length} chars)`)
    return cachedFallbackPassphrase
  }
  send('log', `[srt-passphrase-fallback] FAILED reading ${p} after 3 attempts — using hardcoded fallback`)
  return HARDCODED_FALLBACK_PASSPHRASE
}

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

  // Previously gated on `!app.isPackaged` instead of the env var itself —
  // app.isPackaged is false for ANY unpackaged launch, including running
  // the raw electron.exe straight against this folder (exactly what the
  // desktop launcher .bat does, with no vite dev server involved at all).
  // That made every such launch try to load a hardcoded
  // 'http://localhost:5173' — normally nothing is listening there, so the
  // window sat retrying forever showing blank; if something UNRELATED
  // happens to be serving on 5173 (e.g. a different project's dev
  // server), this app silently rendered that instead. Gating on the env
  // var directly means dev-server mode is only ever used when something
  // actually set it (npm run electron's cross-env), and every other
  // launch path — the .bat, a real packaged build, anything else — loads
  // the built dist/index.html.
  if (process.env.VITE_DEV_SERVER_URL) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    const loadDevServer = () => win!.loadURL(devServerUrl).catch(() => {
      setTimeout(loadDevServer, 300)
    })
    loadDevServer()
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  startMediaMtx()
  // Warm the passphrase cache now, well before anyone clicks Go Live —
  // confirmed live: reading this exact, unchanged, externally-verified-
  // present file sometimes fails ALL THREE in-click retries (not just an
  // occasional one), so whatever transient condition causes it isn't
  // reliably cleared within milliseconds. Doing a first read at startup,
  // with real time to breathe before it's actually needed, means the
  // click-time code almost always has a cached value already — the
  // in-click retry logic stays as a second-layer safety net, not the
  // only line of defense.
  readFallbackPassphrase()
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
// Device ids whose current captureProcs entry is about to be killed and
// immediately replaced (go-live restarts the channel with a new --dest,
// since the destination is a fixed CLI arg to arena_stream.exe). The old
// process's own 'close' handler still fires — asynchronously, after the new
// one is already running — and used to unconditionally send
// 'capture-stopped', which the renderer treats as "this channel really died"
// and removes it from activeIds, hiding the preview tile. Confirmed live:
// Go Live would connect and stream successfully while the on-screen preview
// went blank, because the OLD preview-only process's exit was indistinguishable
// from a real crash. Set right before the intentional kill; the close handler
// consumes it (delete() returns whether it was present) to skip that one event.
const supersededByLive = new Set<string>()
// Which device's frames actually get forwarded to the renderer's preview
// canvas. Multiple channels can capture concurrently (captureProcs), but only
// one should be ON SCREEN at a time — without this gate, every running
// channel's frames would interleave on the same canvas. Switching preview is
// just reassigning this value; it never touches the underlying processes, so
// switching back to an already-running channel is instant and doesn't
// interrupt its capture.
let previewDeviceId: string | null = null
let previewProc:  ChildProcess | null = null
let relayProc:    ChildProcess | null = null

// Serializes start-stream/stop-stream calls per device id. Without this, two
// concurrent calls for the same channel (e.g. an impatient double-click on
// "Go Live" while the first click's IPC round-trip was still in flight) both
// read captureProcs BEFORE either had written its new process into it —
// neither call ever sees the other's process to kill, so both spawns survive
// and the same physical SDI input ends up captured and published twice at
// once. Chaining every call for a given device id through this lock makes
// them run strictly one at a time, so the kill-existing-then-set step in
// each is always accurate.
const deviceLocks = new Map<string, Promise<unknown>>()
function withDeviceLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const prior = deviceLocks.get(deviceId) ?? Promise.resolve()
  const run = prior.then(fn, fn)
  deviceLocks.set(deviceId, run.then(() => {}, () => {}))
  return run
}
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
  stopBeacon()
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

interface CodecEntry {
  name: string; label: string; available: boolean
  resolves_to?: string; resolves_label?: string   // only on the "gpu" / "cpu" entries
}

// Last --list-codecs result. Which encoder is used is arena_stream's decision
// (codec_policy.h): the UI sends "gpu" or "cpu" and arena_stream resolves it.
// This cache only lets the few places that need a concrete encoder name for
// something else (the legacy webcam path, discovery beacons) look the answer
// up rather than re-deriving it here.
let codecList: CodecEntry[] = []

function concreteEncoderName(codec: string): string {
  if (codec !== 'gpu' && codec !== 'cpu') return codec
  return codecList.find(c => c.name === codec)?.resolves_to || 'libx264'
}

ipcMain.handle('list-codecs', async () => {
  const bin = findBin('arena_stream.exe')
  if (!bin) return []
  return new Promise<CodecEntry[]>(resolve => {
    const proc = spawn(bin, ['--list-codecs'], { windowsHide: true })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => {
      try { codecList = JSON.parse(out); resolve(codecList) } catch { resolve([]) }
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

ipcMain.handle('start-capture', (_, device: Device, opts: StreamOpts) => withDeviceLock(device.id, async () => {
  // Confirmed via a live orphan: clicking Stop Stream killed the tracked
  // captureProcs entry, but this handler (preview restart) wasn't behind
  // the same per-device lock as start-stream/stop-stream — if it ran
  // interleaved with a stop-stream call for the same device.id, it could
  // read/replace the captureProcs entry out of order, leaving the OLD
  // live-streaming process (still publishing) orphaned and untracked while
  // a brand new preview-only process took over the map slot. The server
  // kept receiving that orphaned process's stream indefinitely, with no
  // way to stop it from the UI since nothing referenced it anymore.
  //
  // NOTE: this used to unconditionally kill captureProc here, which made
  // sense when only one capture could ever be active — but captureProc is
  // just "whichever device was started/selected most recently", not "the
  // device being started now". With concurrent multi-channel capture, that
  // killed a DIFFERENT, unrelated channel's process every time a new one
  // was started (confirmed via diagnostic logging: starting SDI 2 silently
  // stopped SDI 1's already-running capture). The per-device kill below
  // (via captureProcs, keyed by device.id) already correctly handles
  // restarting the SAME channel; that's the only case that needs it.
  kill(previewProc); previewProc = null
  // Scoped to this device only — previously an unqualified stopBeacon() wiped
  // EVERY channel's discovery beacon just because a different channel started
  // local preview capture, making other independently-live streams vanish
  // from receivers' discovery lists.
  stopBeacon(device.id)

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
      '--codec',     opts.codec,
      '--bitrate',   String(opts.bitrateKbps),
      ...(opts.abrEnabled ? ['--abr'] : []),
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
    previewDeviceId = device.id   // newly-started channel becomes the on-screen preview
    streamMjpegFrames(proc, device.id)

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
            if (typeof stat.encoder === 'string') send('encoder-used', { id: device.id, encoder: stat.encoder })
            if (typeof stat.audio_captured === 'number')
              send('audio-stats', { id: device.id, captured: stat.audio_captured })
          } catch {}
        } else {
          send('log', `[aja ${devLabel}] ${t}`)
        }
      }
    })
    proc.on('close', (code: number | null) => {
      // Only clear the slot if it's still THIS process — a superseded
      // process (e.g. killed by go-live replacing preview with a live
      // stream) fires 'close' asynchronously, well after the map already
      // points to the new process. Deleting unconditionally here orphaned
      // the new process from tracking entirely while it kept running and
      // publishing, with no way to stop it from the UI (confirmed live:
      // captureProcs ended up empty while the SRT publish stayed up).
      if (captureProcs.get(device.id) === proc) captureProcs.delete(device.id)
      if (proc === captureProc) captureProc = null
      // id included unconditionally (not just when this was the foreground
      // preview process) — the renderer's activeIds set tracks every
      // background channel, not just the one currently shown, and needs to
      // know THIS one died however it exited (clean stop, a codec crash,
      // etc.) or a re-click on it forever just re-attaches to the dead
      // process instead of restarting it. Confirmed live: this was
      // previously omitted, and a channel that crashed on the encoder
      // (e.g. libx264 on an interlaced source it can't handle — see
      // aja_device.cpp/encoder.h) stayed stuck showing black forever, with
      // no way to restart it short of relaunching the whole app.
      // EXCEPT when this exit is go-live's own intentional restart of this
      // same channel (see supersededByLive) — the new process is already
      // running by the time this fires, so treating it as a real death
      // would rip the (still-live) preview tile out of activeIds for no reason.
      if (!supersededByLive.delete(device.id))
        send('capture-stopped', { id: device.id, code })
      send('log', `AJA ${devLabel} ended (${code})`)
    })
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
      '--codec',     opts.codec,
      '--bitrate',   String(opts.bitrateKbps),
      ...(opts.abrEnabled ? ['--abr'] : []),
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
    previewDeviceId = device.id
    streamMjpegFrames(proc, device.id)

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
            if (typeof stat.encoder === 'string') send('encoder-used', { id: device.id, encoder: stat.encoder })
            if (typeof stat.audio_captured === 'number')
              send('audio-stats', { id: device.id, captured: stat.audio_captured })
          } catch {}
        } else {
          send('log', `[ndi] ${t}`)
        }
      }
    })
    proc.on('close', (code: number | null) => {
      // See the AJA close handler above for why this must be guarded, and
      // why `id` is always included in capture-stopped now.
      if (captureProcs.get(device.id) === proc) captureProcs.delete(device.id)
      if (proc === captureProc) captureProc = null
      // See the AJA close handler above — skip when this is go-live's own
      // intentional restart of this channel, not a real death.
      if (!supersededByLive.delete(device.id))
        send('capture-stopped', { id: device.id, code })
      send('log', `NDI source ended (${code})`)
    })
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
      '--codec',     opts.codec,
      '--bitrate',   String(opts.bitrateKbps),
      ...(opts.abrEnabled ? ['--abr'] : []),
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
    previewDeviceId = device.id
    streamMjpegFrames(proc, device.id)

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
      // See the AJA close handler above for why this must be guarded, and
      // why `id` is always included in capture-stopped now.
      if (captureProcs.get(device.id) === proc) captureProcs.delete(device.id)
      if (proc === captureProc) captureProc = null
      // See the AJA close handler above — skip when this is go-live's own
      // intentional restart of this channel, not a real death.
      if (!supersededByLive.delete(device.id))
        send('capture-stopped', { id: device.id, code })
      send('log', `DeckLink capture ended (${code})`)
    })
    return { ok: true }
  }

  // ── Webcam / DeckLink path (DirectShow via GStreamer or ffmpeg) ───────────
  // This path doesn't track its process in captureProcs (unlike AJA/NDI/
  // DeckLink-via-NTV2 above) since webcams aren't meant to run concurrently
  // with each other — so it still needs its own explicit kill of whatever
  // captureProc previously held, now that the removed top-level kill no
  // longer does it implicitly.
  kill(captureProc); captureProc = null
  // This path drives GStreamer/ffmpeg directly rather than arena_stream, so it
  // needs a concrete encoder name, not "gpu"/"cpu".
  opts = { ...opts, codec: concreteEncoderName(opts.codec) }
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
  previewDeviceId = device.id
  streamMjpegFrames(captureProc, device.id)

  captureProc.stderr?.on('data', d => {
    const line = d.toString().trim()
    if (!line) return
    if (/configuration:|built with| lib|Last message repeated|too full/i.test(line)) return
    send('log', formatFfmpegStats(line))
  })
  captureProc.on('close', code => {
    send('capture-stopped', { id: device.id, code })
    send('log', `Capture ended (${code})`)
  })

  return { ok: true }
}))

// Raw YUV420P frame parser.
// Wire format: [uint32 LE width][uint32 LE height][Y plane][Cb plane][Cr plane]
// Sends every complete frame to the renderer as raw binary — no JPEG, no artifacts.
function streamMjpegFrames(proc: ChildProcess, deviceId: string) {
  if (!proc.stdout) return
  // Chunk LIST + running length, not a single buffer rebuilt via
  // Buffer.concat on every 'data' event. A raw 1920x1080 YUV420P frame is
  // ~3.1MB but arrives in ~64KB pipe chunks — concatenating the growing
  // "pending" buffer on every single chunk meant re-copying an
  // ever-larger buffer ~48 times per frame (classic O(n²) accumulation).
  // With 4 concurrent channels each doing this on Node's one main thread,
  // that's real, measured stutter: confirmed live — system-wide CPU and
  // GPU both sat under 15% while 4 channels ran, meaning the bottleneck
  // wasn't compute capacity at all, it was this single thread doing
  // avoidable repeated copying. Chunks are only ever merged once we
  // already have enough bytes to actually extract a frame, so the merge
  // cost amortizes to ~1 concat per frame instead of ~1 per pipe chunk.
  let chunks: Buffer[] = []
  let totalLen = 0
  let diagCount = 0

  proc.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    totalLen += chunk.length

    while (totalLen >= 8) {
      const pending = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLen)
      chunks = [pending]

      const w = pending.readUInt32LE(0)
      const h = pending.readUInt32LE(4)
      if (w === 0 || h === 0 || w > 7680 || h > 4320) {
        // Bad header — resync by scanning for a plausible width/height pair
        chunks = [pending.subarray(1)]
        totalLen -= 1
        continue
      }
      const frameBytes = w * h * 3 / 2   // YUV420P
      const total = 8 + frameBytes
      if (pending.length < total) break   // wait for more data

      const yuv = pending.subarray(8, total)
      chunks = [pending.subarray(total)]
      totalLen = pending.length - total

      if (++diagCount % 120 === 1) {
        send('log', `[diag] streamMjpegFrames sending deviceId=${deviceId} w=${w} h=${h}`)
      }

      // Forward every active channel's frames, tagged by device id, so the
      // renderer can show all of them at once in a grid — previously this
      // was gated to only the single "selected" preview device, which was
      // right for a one-canvas layout but wrong for a multi-tile grid.
      try {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('preview-yuv', deviceId, w, h, yuv)
        }
      } catch {}
    }

    // Prevent runaway buffer growth (> 16MB = something is wrong)
    if (totalLen > 16_000_000) { chunks = []; totalLen = 0 }
  })
}

ipcMain.handle('stop-capture', (_, deviceId?: string) => {
  if (deviceId) {
    // Same per-device lock as start-capture/start-stream/stop-stream — this
    // reads and mutates captureProcs for deviceId too, so it needs to be in
    // the same serialized queue or it can race them the same way that left
    // an orphaned, still-publishing process behind (see start-capture).
    return withDeviceLock(deviceId, async () => {
      const proc = captureProcs.get(deviceId)
      if (proc) { kill(proc); captureProcs.delete(deviceId) }
      if (proc === captureProc) captureProc = null
      if (previewDeviceId === deviceId) previewDeviceId = null
      // The same process slot serves both local preview and go-live — if this
      // channel happened to be live, killing it here (e.g. via clicking its
      // source card) must also clear the renderer's live/beacon state for it,
      // or the LIVE badge would keep showing a channel that's actually dead.
      stopBeacon(deviceId)
      send('stream-stopped', { id: deviceId })
      return { ok: true }
    })
  }
  kill(captureProc); captureProc = null
  previewDeviceId = null
  return { ok: true }
})

// Switches which already-running channel's frames are forwarded to the
// preview canvas, without starting or stopping any capture process.
ipcMain.handle('select-preview', (_, deviceId: string) => {
  previewDeviceId = deviceId
  return { ok: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// Stream (SRT out to network)
// For AJA: restart sdi_stream with --dest2 = external SRT listener, keeping
//          --dest = local preview decoder (port 5200).
// For webcam/DirectShow: relay from local UDP:5200 → SRT via ffmpeg.
// ─────────────────────────────────────────────────────────────────────────────

// Every branch below is keyed off the `device` argument passed in from the
// renderer, NOT shared "active*" globals — that was the root cause of only
// ever being able to run one stream at a time: every go-live restarted
// whatever process the single global `captureProc` happened to reference,
// regardless of which channel the user actually clicked. Each channel's own
// process now lives in `captureProcs` (keyed by device.id, the same map
// preview capture already uses), so starting/stopping one channel's stream
// never touches another's. Also: going live no longer reassigns
// `previewDeviceId` — it used to silently steal the on-screen preview to
// whichever channel just went live, which is jarring once multiple channels
// can be independently live at once.
ipcMain.handle('start-stream', async (_, device: Device, opts: StreamOpts) => withDeviceLock(device.id, async () => {
  const lat        = opts.latencyMs ?? 150
  const port       = opts.destPort  ?? 4200
  const destIp     = opts.destIp?.trim()    || ''
  const relayUrl   = opts.relayUrl?.trim()  || ''
  const streamName = opts.streamName?.trim() || `sdi-${device.id}`
  const localIp    = getLocalIp()
  // Must match the receiving server's srtPublishPassphrase or mediamtx
  // rejects the connection outright — empty when the server hasn't set one
  // (or for a purely local/loopback test target that doesn't require it).
  // Falls back to a userData-local secrets file so going live works even
  // if the passphrase field in Settings was never filled in.
  const effectivePassphrase = opts.srtPassphrase?.trim() || readFallbackPassphrase()
  const srtPassphraseParam = effectivePassphrase
    ? `&passphrase=${encodeURIComponent(effectivePassphrase)}`
    : ''

  // Keep DVR proxy label in sync so an open DVR Monitor window picks up the name change
  if (relayUrl) {
    const stripped  = relayUrl.replace(/^(https?|srt):\/\//, '')
    dvrProxyHost   = stripped.includes('@') ? stripped.split('@')[1].split(':')[0] : stripped.split(':')[0]
    dvrStreamLabel = streamName
  }

  const protocol = opts.protocol || 'srt'

  const isNdi      = device.type === 'ndi'
  const isAja      = device.type === 'aja'
  const isDecklink = device.type === 'decklink' && device.id.startsWith('decklink-')
  const ndiSourceName = isNdi ? device.id.replace(/^ndi::/, '') : ''
  const ajaIdParts    = isAja ? device.id.split('-') : []       // "aja-{idx}-{channel}"
  const ajaDeviceIdx  = ajaIdParts[1] ?? '0'
  const ajaChannelNum = ajaIdParts[2] ?? '1'
  const dlIdParts     = isDecklink ? device.id.split('-') : []  // "decklink-{idx}-..."
  const dlDeviceIdx   = dlIdParts[1] ?? '0'

  function replaceStreamProc(proc: ChildProcess) {
    const existing = captureProcs.get(device.id)
    if (existing) { supersededByLive.add(device.id); kill(existing) }
    captureProcs.set(device.id, proc)
  }

  // ── UDP (GStreamer point-to-point) ──────────────────────────────────────────
  // Plain MPEG-TS over UDP: push to destIp:port.  No handshake, no error
  // correction.  Any GStreamer / ffplay / VLC receiver can consume it directly.
  if (protocol === 'udp' || protocol === 'rtp') {
    if (!destIp) return { ok: false, error: 'DEST IP required for UDP/RTP mode' }
    if (!isAja && !isNdi) return { ok: false, error: 'UDP mode only supported with AJA backend' }
    const destUri  = protocol === 'rtp' ? `rtp://${destIp}:${port}` : `udp://${destIp}:${port}`
    send('log', `[${protocol}] pushing to ${destUri}`)
    startBeacon(device.id, streamName, port, '', concreteEncoderName(opts.codec),'', opts.bitrateKbps)

    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) return { ok: false, error: 'arena_stream.exe not found' }
    const captureBackend = isNdi ? 'ndi' : 'aja'
    const captureDevice  = isNdi ? ndiSourceName : ajaDeviceIdx
    const captureArgs = [
      '--backend', captureBackend, '--device', captureDevice,
      '--codec',   opts.codec,
      '--bitrate', String(opts.bitrateKbps),
      ...(opts.abrEnabled ? ['--abr'] : []),
      // RTP muxer is single-stream (video only) — audio would corrupt the H.264
      // RTP session.  Optics PRO doesn't have an audio branch in its GStreamer
      // pipeline anyway, so there is nothing to send audio to.
      '--acodec',  (protocol === 'rtp') ? 'none' : ((opts.audioEnabled ?? true) ? ('libopus') : 'none'),  // RTP is video-only
      '--achannels', '2',
      '--dest',    destUri,
    ]
    await new Promise(r => setTimeout(r, 300))
    send('log', `[sdi_stream] ${protocol} → ${destUri}${protocol === 'rtp' ? ' (audio disabled — RTP is video-only)' : ''}`)
    const proc = spawn(sdiStream, captureArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    replaceStreamProc(proc)
    streamMjpegFrames(proc, device.id)
    let buf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop() ?? ''
      for (const l of ls) { const t = l.trim(); if (!t || /built with| lib/i.test(t)) continue; send('log', t.startsWith('{') ? t : `[aja] ${t}`) }
    })
    proc.on('close', (code: number | null) => {
      // See the AJA close handler further up for why this must be guarded
      // — this is the actual root cause of the process-orphaning bug: a
      // superseded process's delayed 'close' event deleting the NEW
      // process's already-set map entry, leaving it untracked while still
      // running and publishing, with no way to stop it from the UI.
      if (captureProcs.get(device.id) === proc) captureProcs.delete(device.id)
      send('stream-stopped', { id: device.id, code })
      send('capture-stopped', { id: device.id, code })
    })
    send('stream-url', { id: device.id, url: destUri })
    return { ok: true, viewerUri: destUri }
  }

  // ── NDI (LAN broadcast, no SRT) ────────────────────────────────────────────
  if (protocol === 'ndi') {
    if (!isAja && !isNdi) return { ok: false, error: 'NDI output only supported with AJA/SDI backend' }
    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) return { ok: false, error: 'arena_stream.exe not found' }

    const captureBackend = isNdi ? 'ndi' : 'aja'
    const captureDevice  = isNdi ? ndiSourceName : ajaDeviceIdx
    const ndiName = opts.ndiName?.trim() || 'SDI Stream'

    const captureArgs = [
      '--backend',   captureBackend,
      '--device',    captureDevice,
      '--codec',     opts.codec,
      '--bitrate',   String(opts.bitrateKbps),
      ...(opts.abrEnabled ? ['--abr'] : []),
      '--acodec',    (opts.audioEnabled ?? true) ? ('libopus') : 'none',
      '--achannels', '2',
      '--dest',      'none',
      '--ndi-out',
      '--ndi-name',  ndiName,
    ]
    await new Promise(r => setTimeout(r, 300))
    send('log', `[ndi] broadcasting as "${ndiName}" on LAN`)
    const proc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    replaceStreamProc(proc)
    streamMjpegFrames(proc, device.id)
    let ndiBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      ndiBuf += d.toString()
      const lines = ndiBuf.split('\n'); ndiBuf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t || /configuration:|built with| lib|Last message repeated/i.test(t)) continue
        if (t.startsWith('{')) {
          send('log', t)
        } else {
          send('log', `[ndi] ${t}`)
        }
      }
    })
    proc.on('close', (code: number | null) => {
      // See the AJA close handler further up for why this must be guarded
      // — this is the actual root cause of the process-orphaning bug: a
      // superseded process's delayed 'close' event deleting the NEW
      // process's already-set map entry, leaving it untracked while still
      // running and publishing, with no way to stop it from the UI.
      if (captureProcs.get(device.id) === proc) captureProcs.delete(device.id)
      send('stream-stopped', { id: device.id, code })
      send('capture-stopped', { id: device.id, code })
      send('log', `NDI stream ended (${code})`)
    })
    send('stream-url', { id: device.id, url: `ndi://${ndiName}` })
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
    externalSrt = `srt://${authPfx}${relayHost}:${relaySrtPort}?streamid=publish:${srtRelayName}&mode=caller&latency=${wanLatUs}${srtPassphraseParam}`
    viewerUri   = `srt://${relayHost}:${relaySrtPort}?streamid=${srtRelayName}&mode=caller&latency=${wanLatUs}`
    send('log', `[relay] publishing to ${relayHost}:${relaySrtPort} as "${streamName}"`)
  } else if (destIp && destIp !== '0.0.0.0') {
    externalSrt = `srt://${destIp}:${port}?mode=caller&latency=${lat * 1000}`
    viewerUri   = externalSrt
  } else {
    externalSrt = `srt://0.0.0.0:${port}?mode=listener&latency=${lat * 1000}`
    viewerUri   = `srt://${localIp}:${port}?mode=caller&latency=${lat * 1000}`
  }

  if (isAja || isNdi) {
    // AJA / NDI: preview is on stdout (MJPEG direct from sdi_stream), SRT goes to external.
    // Restart sdi_stream with the external dest — preview keeps working via the pipe.
    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) return { ok: false, error: 'arena_stream.exe not found' }

    const captureBackend = isNdi ? 'ndi' : 'aja'
    const captureDevice  = isNdi ? ndiSourceName : ajaDeviceIdx

    // Push directly to the external SRT destination (server or relay URL).
    // Bypassing the local-mediamtx intermediate hop eliminates the RTSP burst/
    // timing issues that caused the ffmpeg relay to fail.
    // arena_stream's built-in ReconnectingSrtOutput handles reconnection.
    const srtSafeName = streamName.replace(/\s+/g, '_')
    const destUri = externalSrt || `srt://127.0.0.1:8890?streamid=publish:${srtSafeName}&mode=caller&latency=${lat * 1000}${srtPassphraseParam}`
    const captureArgs = [
      '--backend',   captureBackend,
      '--device',    captureDevice,
      '--conn',      ajaChannelNum,
      '--codec',     opts.codec,
      '--bitrate',   String(opts.bitrateKbps),
      ...(opts.abrEnabled ? ['--abr'] : []),
      '--acodec',    (opts.audioEnabled ?? true) ? 'libopus' : 'none',
      '--achannels', '2',
      '--dest',      destUri,
      '--latency',   String(Math.max(200, lat)),
    ]
    await new Promise(r => setTimeout(r, 300))
    send('log', `[sdi_stream/${captureBackend}] go live → ${destUri}`)
    const proc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    replaceStreamProc(proc)
    // stdout = binary MJPEG frames — must use streamMjpegFrames, NOT a text reader
    streamMjpegFrames(proc, device.id)
    // stderr = JSON stats + diagnostics
    let goLiveStderrBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
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
            if (stat.mode) send('capture-format', { id: device.id, format: formatMode(stat.mode) })
            if (typeof stat.encoder === 'string') send('encoder-used', { id: device.id, encoder: stat.encoder })
            if (typeof stat.audio_captured === 'number')
              send('audio-stats', { id: device.id, captured: stat.audio_captured })
          } catch {}
        } else {
          send('log', `[aja] ${t}`)
        }
      }
    })
    proc.on('close', (code: number | null) => {
      // See the AJA close handler further up for why this must be guarded
      // — this is the actual root cause of the process-orphaning bug: a
      // superseded process's delayed 'close' event deleting the NEW
      // process's already-set map entry, leaving it untracked while still
      // running and publishing, with no way to stop it from the UI.
      if (captureProcs.get(device.id) === proc) captureProcs.delete(device.id)
      send('stream-stopped', { id: device.id, code })
      send('capture-stopped', { id: device.id, code })
      send('log', `AJA stream ended (${code})`)
    })
    startBeacon(device.id, streamName, port, '', concreteEncoderName(opts.codec),`${localIp}:8890`, opts.bitrateKbps)
    send('stream-url', { id: device.id, url: viewerUri })
    return { ok: true, viewerUri }
  }

  // DeckLink via arena_stream.exe (SDK-captured, id starts with "decklink-")
  if (isDecklink) {
    const sdiStream = findBin('arena_stream.exe')
    if (!sdiStream) return { ok: false, error: 'arena_stream.exe not found' }

    const dlSrtSafeName = streamName.replace(/\s+/g, '_')
    const dlDestUri = externalSrt || `srt://127.0.0.1:8890?streamid=publish:${dlSrtSafeName}&mode=caller&latency=${lat * 1000}${srtPassphraseParam}`
    const captureArgs = [
      '--backend',   'decklink',
      '--device',    dlDeviceIdx,
      '--conn',      'sdi',
      '--codec',     opts.codec,
      '--bitrate',   String(opts.bitrateKbps),
      ...(opts.abrEnabled ? ['--abr'] : []),
      '--acodec',    (opts.audioEnabled ?? true) ? 'libopus' : 'none',
      '--achannels', '2',
      '--dest',      dlDestUri,
      '--latency',   String(Math.max(200, lat)),
    ]
    await new Promise(r => setTimeout(r, 300))
    send('log', `[arena_stream/decklink] go live → ${dlDestUri}`)
    const proc = spawn(sdiStream, captureArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    replaceStreamProc(proc)
    streamMjpegFrames(proc, device.id)
    let buf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop() ?? ''
      for (const l of ls) { const t = l.trim(); if (!t || /built with| lib/i.test(t)) continue; send('log', t.startsWith('{') ? t : `[decklink] ${t}`) }
    })
    proc.on('close', (code: number | null) => {
      // See the AJA close handler further up for why this must be guarded
      // — this is the actual root cause of the process-orphaning bug: a
      // superseded process's delayed 'close' event deleting the NEW
      // process's already-set map entry, leaving it untracked while still
      // running and publishing, with no way to stop it from the UI.
      if (captureProcs.get(device.id) === proc) captureProcs.delete(device.id)
      send('stream-stopped', { id: device.id, code })
      send('capture-stopped', { id: device.id, code })
      send('log', `DeckLink stream ended (${code})`)
    })
    startBeacon(device.id, streamName, port, '', concreteEncoderName(opts.codec),`${localIp}:8890`, opts.bitrateKbps)
    send('stream-url', { id: device.id, url: viewerUri })
    return { ok: true, viewerUri }
  }

  // Webcam/DirectShow: ffmpeg relay from local UDP:5200 → SRT listener.
  // Unlike the AJA/DeckLink/NDI paths above, this doesn't have a per-device
  // slot — all webcam captures multiplex onto the same fixed UDP:5200 port,
  // so only one webcam stream can ever run at a time (pre-existing limitation
  // of the webcam capture pipeline, not something this per-device refactor
  // changes).
  const ffmpeg = findFFmpeg()
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not found' }

  const args = [
    '-fflags', '+discardcorrupt+genpts+nobuffer',
    '-flags', 'low_delay',
    '-i', `udp://0.0.0.0:5200?overrun_nonfatal=1&fifo_size=100000`,
    '-c', 'copy',
    '-f', 'mpegts', externalSrt,
  ]

  kill(relayProc); relayProc = null
  relayProc = spawn(ffmpeg, args, { windowsHide: true })
  relayProc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim()
    if (!line || /configuration:|built with| lib|Last message repeated/i.test(line)) return
    send('log', `[relay] ${line}`)
  })
  relayProc.on('close', (code: number | null) => {
    send('stream-stopped', { id: device.id, code })
    send('log', `Stream ended (${code})`)
  })

  startBeacon(device.id, streamName, port, '', concreteEncoderName(opts.codec || ''), relayUrl, opts.bitrateKbps)
  send('stream-url', { id: device.id, url: viewerUri })
  return { ok: true, viewerUri }
}))

ipcMain.handle('stop-stream', (_, deviceId: string) => withDeviceLock(deviceId, async () => {
  relayStop = true
  const proc = captureProcs.get(deviceId)
  if (proc) {
    kill(proc); captureProcs.delete(deviceId)
  } else {
    // No per-device slot for this id — assumed to mean "must be the
    // single-instance webcam relay path", but that assumption was never
    // actually verified: confirmed via a live repro that this branch can
    // be hit for a device that IS a real tracked AJA/NDI capture, silently
    // no-opping (kill(null) does nothing) while returning {ok: true} — the
    // stream keeps publishing with zero visible error. Logging exactly
    // what was requested vs what's tracked so the next occurrence has
    // real evidence instead of another guess.
    send('log', `[warn] stop-stream: no captureProcs entry for "${deviceId}" — tracked ids: [${[...captureProcs.keys()].join(', ')}]. Falling back to relayProc (${relayProc ? 'present' : 'null'}).`)
    kill(relayProc); relayProc = null
  }
  stopBeacon(deviceId)
  send('stream-stopped', { id: deviceId })
  send('capture-stopped', { id: deviceId })
  return { ok: true }
}))

// ─────────────────────────────────────────────────────────────────────────────
// Discovery beacon — broadcast stream presence so receivers can find us
// Protocol: UDP broadcast to 255.255.255.255:4210, 1s interval, JSON payload
// ─────────────────────────────────────────────────────────────────────────────
const DISCOVERY_PORT = 4210
let beaconSocket: dgram.Socket | null = null
let beaconTimer:  ReturnType<typeof setInterval> | null = null

const DISCOVERY_FILE = require('os').homedir() + '\\.sdi-streams.json'

// One entry per independently-live channel, keyed by device id. Previously
// this was single-slot (one socket/timer/file for ONE stream), so going live
// on a second channel silently wiped the first channel's discovery beacon
// even though its stream kept running — receivers would just stop seeing it.
const beaconEntries = new Map<string, object>()

function writeDiscoveryFile() {
  try { fs.writeFileSync(DISCOVERY_FILE, JSON.stringify(Array.from(beaconEntries.values())), 'utf8') } catch {}
}

function startBeacon(deviceId: string, name: string, port: number, format: string, codec: string, relay = '', bitrateKbps = 0) {
  const ip = getLocalIp()
  const streamEntry = { type: 'sdi-stream', name, ip, port, format, codec,
                        bitrateKbps: bitrateKbps || undefined, relay: relay || undefined }
  beaconEntries.set(deviceId, streamEntry)
  writeDiscoveryFile()

  if (!beaconSocket) {
    beaconSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    beaconSocket.on('error', () => {})
    beaconSocket.bind(() => beaconSocket?.setBroadcast(true))
  }
  if (!beaconTimer) {
    // Single shared timer broadcasts every currently-live entry each tick,
    // rather than one timer per channel.
    beaconTimer = setInterval(() => {
      for (const entry of beaconEntries.values()) {
        const payload = Buffer.from(JSON.stringify(entry))
        beaconSocket?.send(payload, DISCOVERY_PORT, '255.255.255.255')
        beaconSocket?.send(payload, DISCOVERY_PORT, '127.0.0.1')
      }
    }, 500)
  }
  send('log', `[beacon] broadcasting "${name}" on port ${port}`)
}

// Omit deviceId to tear down every beacon (used on app quit).
function stopBeacon(deviceId?: string) {
  if (deviceId) beaconEntries.delete(deviceId)
  else beaconEntries.clear()
  writeDiscoveryFile()
  if (beaconEntries.size === 0) {
    if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null }
    if (beaconSocket) { try { beaconSocket.close() } catch {} beaconSocket = null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
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
  srtPassphrase?: string // must match the receiving server's srtPublishPassphrase
  abrEnabled?:    boolean // adaptive bitrate — --bitrate becomes a ceiling, steps down under real network congestion
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
  // Temporary: 'log' lines (spawn commands, child stderr passthrough) only
  // ever reached the renderer over IPC — nothing outside the app's own log
  // panel could see them, which made a crash that killed the window (or
  // that nobody was watching live) impossible to diagnose after the fact.
  // Mirrors to disk so a failure can be read back without having to
  // reproduce it live in front of someone watching the panel.
  if (channel === 'log') {
    try {
      fs.appendFileSync(
        path.join(__dirname, '..', 'live_debug.txt'),
        `${new Date().toISOString()} ${args[0]}\n`
      )
    } catch { /* best-effort */ }
  }
}
