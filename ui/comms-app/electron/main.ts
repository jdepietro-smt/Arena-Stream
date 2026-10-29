import { app, BrowserWindow, desktopCapturer, session } from 'electron'
import * as path from 'path'

app.setName('Arena Comms')
app.setAppUserModelId('com.smt.arenacomms')

const hasSingleLock = app.requestSingleInstanceLock()
let win: BrowserWindow | null = null

if (!hasSingleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'Arena Comms',
    backgroundColor: '#07070d',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07070d', symbolColor: '#e8eaf0', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // An intercom must keep talking/listening when the window is covered or
      // minimised; Chromium would otherwise throttle timers and audio.
      backgroundThrottling: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

if (hasSingleLock) {
  app.whenReady().then(() => {
    // Only the microphone (and speaker selection) is needed.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media')
    })
    // The A1's music source: "Computer / tab audio" captures everything this PC plays (Windows loopback),
    // so any music app works without a virtual audio cable. Only the audio is used by the app.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then(
        sources => callback({ video: sources[0], audio: 'loopback' }),
        () => callback({}),
      )
    })
    createWindow()
  })

  // A server reached by bare IP address cannot have a public CA certificate, so it runs a
  // self-signed one. Accept that only for IP literals; named hosts must still verify.
  app.on('certificate-error', (event, _wc, url, _error, _cert, cb) => {
    let host = ''
    try { host = new URL(url).hostname } catch { /* fall through to reject */ }
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
    if (isIp) event.preventDefault()
    cb(isIp)
  })
}

app.on('window-all-closed', () => {
  win = null
  app.quit()
})
