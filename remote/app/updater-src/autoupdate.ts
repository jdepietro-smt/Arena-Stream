// Self-update for this app: the same updater the Arena Link app uses (see updater.ts), wired up with the few things this app has to say:
// whether something is live right now, and how to stop it cleanly before the installer replaces the files.
//
// Where releases come from: the Arena Link directory (the portal publishes the installers there). The address and access key are built in,
// so a fresh install needs no setup. To change them, or to choose when updates install, put any of these in
// "update-config.json" in the app's data folder (%APPDATA%\<app name>):
//   { "directory": "http://main:8002,http://backup:8002", "key": "...", "updateMode": "idle" | "ask" | "off", "updateWindow": {"from":"02:00","to":"05:00"} }
import { app, ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { startUpdater } from './updater'
import type { UpdateMode, Window } from './update-core'

const DEFAULT_DIRECTORY = 'http://5.78.236.254:8002'
const DEFAULT_KEY = '5jpmzaedzkm5'

interface UpdateCfg { directory: string; key: string; updateMode?: UpdateMode; updateWindow?: Window | null }

function readCfg(): UpdateCfg {
  let user: Partial<UpdateCfg> = {}
  try { user = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'update-config.json'), 'utf8')) } catch { /* none: use the built-in values */ }
  // Default 'ask': installing needs administrator approval (Windows asks), so an unattended computer must not start it by itself. The window shows
  // "Update ready - Install now"; a connected viewer can approve the Windows prompt through the elevated helper.
  const mode = user.updateMode === 'idle' || user.updateMode === 'off' ? user.updateMode : 'ask'
  return { directory: String(user.directory || DEFAULT_DIRECTORY), key: String(user.key || DEFAULT_KEY), updateMode: mode, updateWindow: user.updateWindow ?? null }
}

export function setupAutoUpdate(o: {
  app: 'remote'
  isLive: () => boolean
  prepareToQuit: () => Promise<void>
  send: (channel: string, ...args: unknown[]) => void
}) {
  let updater: ReturnType<typeof startUpdater> | null = null
  // The handlers exist in every run so the window never errors; only the installed app actually checks for updates.
  ipcMain.handle('updater-status', () => updater?.status() ?? { state: 'idle' })
  ipcMain.handle('updater-install-now', () => { void updater?.installNow(); return true })
  ipcMain.handle('updater-check-now', () => { void updater?.checkNow(); return true })
  if (!app.isPackaged) return
  updater = startUpdater({
    app: o.app, version: app.getVersion(), host: os.hostname(), dir: path.join(app.getPath('userData'), 'updates'),
    config: readCfg,
    isLive: o.isLive,
    prepareToQuit: o.prepareToQuit,
    quit: () => app.quit(),
    onStatus: s => o.send('updater-status', s),
    log: m => console.log(m),
  })
}
