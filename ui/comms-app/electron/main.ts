import { app, BrowserWindow, session } from 'electron'
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
    createWindow()
  })
}

app.on('window-all-closed', () => {
  win = null
  app.quit()
})
