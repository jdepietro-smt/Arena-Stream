// Arena Remote — Electron main process. Owns everything privileged: the identity key, screen capture
// selection and input injection. The renderer (UI + WebRTC) is sandboxed and reaches this only through preload.js.

const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session } = require('electron')
const path = require('node:path')
const identity = require('./identity')
const { SecureHelper } = require('./secure')
const { startDirect } = require('./direct')
const os = require('node:os')

const helper = new SecureHelper()

// Smooth, low-latency video: hardware encode/decode, no frame-rate cap, GPU raster.
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('disable-frame-rate-limit')
app.commandLine.appendSwitch('disable-gpu-vsync')
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns:false')
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/')

if (!process.env.ARENA_MULTI && !app.requestSingleInstanceLock()) app.quit()

let win = null
const host = { armed: false, sourceId: null, bounds: null, session: null, control: false }
const bucket = { tokens: 2000, last: Date.now() } // input rate limit: 2000 events/s

const sender = e => win && e.sender === win.webContents // only our own window may call privileged IPC
const ipc = (name, fn) => ipcMain.handle(name, (e, ...a) => { if (!sender(e)) throw new Error('forbidden'); return fn(...a) })

function physicalBounds(display) {
  return screen.dipToScreenRect(null, display.bounds)
}

function endHostSession() {
  if (helper.connected) { helper.send({ t: 'control', on: false }); helper.send({ t: 'frames', on: false }); helper.close() }
  if (host.control) { try { require('./input').releaseAll() } catch {} }
  host.session = null
  host.control = false
}

ipc('identity:info', () => identity.info())
ipc('identity:sign', msg => identity.sign(msg))
ipc('identity:verify', args => identity.verifyHostSignature(args))
ipc('pin:status', (id, key) => identity.pinStatus(id, key))
ipc('pin:accept', (id, key) => identity.pinAccept(id, key))
ipc('passcode:set', pw => identity.setPasscode(pw))
ipc('passcode:has', () => identity.hasPasscode())
ipc('passcode:check', pw => identity.checkPasscode(pw))

// Serverless mode: this app listens for viewers itself (see direct.js).
let direct = null
ipc('direct:start', async () => {
  const id = identity.info()
  if (!direct) {
    const d = startDirect({ pubKey: id.pubKey, name: os.hostname(), onMessage: m => win?.webContents.send('direct:msg', m) })
    try { await d.ready } catch (e) { d.stop(); throw new Error(e.code === 'EADDRINUSE' ? 'Port 8951 is already in use' : e.message) }
    direct = d
  }
  return { code: direct.code, port: direct.port, addresses: direct.addresses, readable: id.readable }
})
ipc('direct:send', m => direct?.send(m))
ipc('direct:stop', () => { direct?.stop(); direct = null; return true })

ipc('host:sources', async () => {
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
  const displays = screen.getAllDisplays()
  return srcs.map((s, i) => {
    const d = displays.find(x => String(x.id) === s.display_id) ?? displays[i]
    return { id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), w: d ? Math.round(d.size.width * d.scaleFactor) : 0, h: d ? Math.round(d.size.height * d.scaleFactor) : 0 }
  })
})
ipc('host:arm', (armed, sourceId) => {
  host.armed = !!armed
  host.sourceId = armed ? sourceId : null
  if (!armed) endHostSession()
  if (armed) {
    const displays = screen.getAllDisplays()
    // source ids look like "screen:<index>:0"; resolve via a fresh listing so bounds match the chosen monitor
    return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then(list => {
      const src = list.find(x => x.id === sourceId)
      const d = displays.find(x => String(x.id) === src?.display_id) ?? screen.getPrimaryDisplay()
      host.bounds = physicalBounds(d)
      return true
    })
  }
  return true
})
ipc('host:begin', async ({ sessionId, control }) => {
  host.session = String(sessionId); host.control = !!control
  // Optional service helper: lets input and capture reach UAC / the login screen. Absent = local injection only.
  if (await helper.connect()) {
    helper.send({ t: 'hello', x: host.bounds.x, y: host.bounds.y, w: host.bounds.width, h: host.bounds.height })
    helper.send({ t: 'control', on: host.control })
  }
  return helper.connected
})
ipc('host:frames', on => helper.send({ t: 'frames', on: !!on }))
ipc('helper:status', () => helper.connected)
ipc('host:setControl', c => {
  host.control = !!c && !!host.session
  helper.send({ t: 'control', on: host.control })
  if (!host.control) try { require('./input').releaseAll() } catch {}
  return host.control
})
ipc('host:end', () => { endHostSession(); return true })

// Input is fire-and-forget (hot path): validated, rate limited, and dropped unless the host approved control.
ipcMain.on('host:input', (e, ev) => {
  if (!sender(e) || !host.control || !host.session || !host.bounds) return
  const now = Date.now()
  bucket.tokens = Math.min(2000, bucket.tokens + ((now - bucket.last) / 1000) * 2000)
  bucket.last = now
  if (bucket.tokens < 1) return
  bucket.tokens--
  try {
    if (helper.connected) {
      // The helper injects on whichever desktop has input focus; it needs raw scancodes, resolved here from the key code.
      const out = { t: 'in', ...ev }
      if (ev.k === 'kd' || ev.k === 'ku') { const s = require('./input').scancode(ev.c); if (!s) return; out.sc = s[0]; out.ext = !!s[1] }
      helper.send(out)
    } else require('./input').inject(ev, host.bounds)
  } catch (err) { console.error('input error', err.message) }
})

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600, backgroundColor: '#0b0f14', title: 'Arena Remote', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
  })
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.on('closed', () => { win = null })
}

app.whenReady().then(() => {
  const ses = session.defaultSession
  // Only screen/audio capture requested by our own host mode, and fullscreen/keyboard-lock for the viewer.
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(['fullscreen', 'keyboardLock', 'pointerLock', 'display-capture'].includes(permission) || (permission === 'media' && host.armed)))
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    if (!host.armed || !host.sourceId) return cb({})
    const list = await desktopCapturer.getSources({ types: ['screen'] })
    const video = list.find(s => s.id === host.sourceId)
    video ? cb({ video, audio: 'loopback' }) : cb({})
  })
  helper.on('desktop', name => win?.webContents.send('desktop', name))
  helper.on('frame', f => win?.webContents.send('frame', f))
  createWindow()
  // Kill switch on the host machine: ends any remote session no matter what the viewer does.
  globalShortcut.register('Control+Alt+Shift+End', () => { endHostSession(); win?.webContents.send('kill') })
})

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
app.on('window-all-closed', () => { endHostSession(); app.quit() })
app.on('will-quit', () => { globalShortcut.unregisterAll(); direct?.stop() })
