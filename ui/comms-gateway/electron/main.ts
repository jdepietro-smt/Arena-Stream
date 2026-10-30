import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { RtpReceiver, RtpSender, RxStats } from './rtp'
import { PcmFormat } from './rtp-codec'
import { asioClose, registerAsio } from './asio'

// An unattended gateway has no user to click before audio may start.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.setName('Arena Comms Gateway')
app.setAppUserModelId('com.smt.arenacommsgateway')

const hasSingleLock = app.requestSingleInstanceLock()
let win: BrowserWindow | null = null

if (!hasSingleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 820, minHeight: 560,
    title: 'Arena Comms Gateway',
    backgroundColor: '#07070d',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07070d', symbolColor: '#e8eaf0', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A gateway must keep bridging audio while minimised or behind other windows.
      backgroundThrottling: false,
    },
  })
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
}

// ── config (password encrypted with the OS keystore when available) ──────────
const configFile = () => path.join(app.getPath('userData'), 'gateway-config.json')

ipcMain.handle('config:get', () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    if (cfg.passwordEnc && safeStorage.isEncryptionAvailable()) {
      cfg.password = safeStorage.decryptString(Buffer.from(cfg.passwordEnc, 'base64'))
    }
    delete cfg.passwordEnc
    return cfg
  } catch {
    return null
  }
})

ipcMain.handle('config:set', (_e, cfg: Record<string, unknown>) => {
  const out = { ...cfg }
  if (typeof out.password === 'string' && out.password && safeStorage.isEncryptionAvailable()) {
    out.passwordEnc = safeStorage.encryptString(out.password).toString('base64')
    delete out.password
  }
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(out, null, 2))
})

// ── RTP ports (AES67-style network audio) ────────────────────────────────────
interface RtpPortCfg {
  rxAddr: string; rxPort: number; rxFormat: PcmFormat; rxChannels: number; rxChannel: number; rxPayloadType?: number
  txAddr: string; txPort: number; txFormat: PcmFormat; txPayloadType: number; ptimeMs: number
}
const rtpPorts = new Map<string, { rx?: RtpReceiver; tx?: RtpSender }>()

function closeRtp(id: string) {
  const p = rtpPorts.get(id)
  p?.rx?.stop(); p?.tx?.stop()
  rtpPorts.delete(id)
}

ipcMain.handle('rtp:open', async (_e, id: string, c: RtpPortCfg) => {
  closeRtp(id)
  const entry: { rx?: RtpReceiver; tx?: RtpSender } = {}
  try {
    if (c.rxPort) {
      entry.rx = new RtpReceiver({
        address: c.rxAddr, port: c.rxPort, format: c.rxFormat, channels: c.rxChannels, channel: c.rxChannel,
        payloadType: c.rxPayloadType,
        onSamples: s => win?.webContents.send('rtp:rx', id, s),
        onStats: (s: RxStats) => win?.webContents.send('rtp:stats', id, s),
      })
      await entry.rx.start()
    }
    if (c.txPort && c.txAddr) {
      entry.tx = new RtpSender({ address: c.txAddr, port: c.txPort, format: c.txFormat, payloadType: c.txPayloadType, ptimeMs: c.ptimeMs })
    }
    rtpPorts.set(id, entry)
    return { ok: true }
  } catch (e) {
    entry.rx?.stop(); entry.tx?.stop()
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.on('rtp:tx', (_e, id: string, samples: Float32Array) => { rtpPorts.get(id)?.tx?.push(samples) })
ipcMain.handle('rtp:close', (_e, id: string) => { closeRtp(id) })

// ── ASIO (every channel of an interface Windows only offers as a stereo pair) ──
registerAsio(() => win)
app.on('before-quit', () => asioClose())

if (hasSingleLock) app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  for (const id of [...rtpPorts.keys()]) closeRtp(id)
  win = null
  app.quit()
})
