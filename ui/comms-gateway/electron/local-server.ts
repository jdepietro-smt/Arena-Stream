// Runs a small Comms server on this PC as a read-only copy of the main one, so that crew in the venue can still talk to
// each other if the internet to the main server goes down. Crew apps use it as their "Backup server"; they move back to
// the main server by themselves when it returns. Audio here is peer to peer on the local network.
import { app, ipcMain } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import { LocalServerCfg, localServerEnv, validLocalCfg } from './local-core'

let child: ChildProcess | null = null
let current: LocalServerCfg | null = null
let lastError = ''
let restart: ReturnType<typeof setTimeout> | null = null

const serverDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'comms-server') : path.resolve(__dirname, '../../../comms/server'))
const nodeBin = () => (app.isPackaged ? path.join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node') : 'node')
const dataDir = () => path.join(app.getPath('userData'), 'local-comms')

function stop() {
  current = null
  if (restart) clearTimeout(restart)
  restart = null
  const c = child
  child = null
  if (c && !c.killed) c.kill()
}

function launch(cfg: LocalServerCfg) {
  const bad = validLocalCfg(cfg)
  if (bad) { lastError = bad; return }
  fs.mkdirSync(dataDir(), { recursive: true })
  const log = fs.openSync(path.join(dataDir(), 'server.log'), 'a')
  lastError = ''
  const c = spawn(nodeBin(), ['server.js'], {
    cwd: serverDir(), windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, ...localServerEnv(cfg, path.join(dataDir(), 'directory.json')) },
  })
  child = c
  c.on('error', e => { lastError = `Could not start: ${e.message}` })
  c.on('exit', code => {
    fs.closeSync(log)
    if (child !== c) return
    child = null
    lastError = `The local server stopped (code ${code}); restarting`
    restart = setTimeout(() => { if (current) launch(current) }, 5000)
  })
}

function health(port: number): Promise<{ standby?: boolean; lastSync?: number; peers?: number } | null> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, res => {
      let b = ''
      res.on('data', d => { b += d })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

export function registerLocalServer() {
  ipcMain.handle('local:start', (_e, cfg: LocalServerCfg) => {
    const same = current && JSON.stringify(current) === JSON.stringify(cfg) && child
    if (same) return { ok: true }
    stop()
    const bad = validLocalCfg(cfg)
    if (bad) { lastError = bad; return { ok: false, error: bad } }
    current = cfg
    launch(cfg)
    return { ok: true }
  })
  ipcMain.handle('local:stop', () => { stop(); lastError = ''; return { ok: true } })
  ipcMain.handle('local:status', async () => {
    const port = current?.port
    const h = port && child ? await health(port) : null
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal).map(i => i.address)
    return { running: !!child && !!h, starting: !!child && !h, error: lastError, lan, port: port ?? null, lastSync: h?.lastSync ?? 0, peers: h?.peers ?? 0, standby: !!h?.standby }
  })
  app.on('before-quit', stop)
}
