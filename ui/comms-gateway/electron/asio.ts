// ASIO bridge. The window's audio engine (Chromium) cannot use ASIO, and an interface like a Focusrite only offers a stereo
// pair to Windows' own audio. The real work happens in a helper process (asio-worker.ts) because audify's native module
// cannot be loaded inside Electron; the installer ships a plain node.exe for it. This file starts that helper and relays:
//
//   ASIO input channels  --planar blocks-->  window ('asio:rx')   (each block is one device buffer)
//   window output blocks ('asio:tx') --> helper --> per-channel rings --> mixed into each device output buffer
//
// Dante Virtual Soundcard shows up as an ASIO driver too, so it works through the same path.

import { app, BrowserWindow, ipcMain } from 'electron'
import { ChildProcess, ForkOptions, fork } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface AsioDevice { id: number; name: string; inputChannels: number; outputChannels: number; sampleRates: number[] }

let child: ChildProcess | null = null
let seq = 0
const pending = new Map<number, (r: unknown) => void>()
let rxTarget: (() => BrowserWindow | null) | null = null

/** The Node binary for the helper: the one shipped beside the app, else the Node on this machine (development). */
function nodeBinary(): string | undefined {
  const shipped = path.join(process.resourcesPath ?? '', 'node', 'node.exe')
  return fs.existsSync(shipped) ? shipped : undefined
}

function workerPath(): string {
  // Packaged: the script and audify sit unpacked beside app.asar so a plain Node can read them.
  return path.join(__dirname, 'asio-worker.js').replace('app.asar', 'app.asar.unpacked')
}

function start(): ChildProcess | null {
  if (child && child.connected) return child
  const exec = nodeBinary()
  if (app.isPackaged && !exec) return null
  const c = fork(workerPath(), [], {
    ...(exec ? { execPath: exec } : {}),
    windowsHide: true, // node.exe is a console program; do not show its window
    serialization: 'advanced', // typed arrays travel as binary
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  } as ForkOptions)
  c.on('message', (m: { id?: number; result?: unknown; type?: string; planar?: Float32Array }) => {
    if (m.id != null) {
      const done = pending.get(m.id)
      pending.delete(m.id)
      done?.(m.result)
    } else if (m.type === 'rx') {
      const win = rxTarget?.()
      if (win && !win.isDestroyed()) win.webContents.send('asio:rx', m.planar)
    }
  })
  const gone = () => {
    if (child === c) child = null
    for (const done of pending.values()) done({ ok: false, error: 'The ASIO helper stopped' })
    pending.clear()
  }
  c.on('exit', gone)
  c.on('error', gone)
  child = c
  return c
}

function call(type: string, cfg?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const c = start()
  if (!c) return Promise.resolve({ ok: false, error: 'ASIO helper is missing from this install' })
  return new Promise(resolve => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'The ASIO driver did not answer' }) }, 20000)
    pending.set(id, r => { clearTimeout(timer); resolve(r as { ok: boolean }) })
    c.send({ id, type, cfg })
  })
}

export function asioClose() {
  if (!child) return
  const c = child
  child = null
  try { c.send({ id: 0, type: 'close' }) } catch { /* gone */ }
  setTimeout(() => { try { c.kill() } catch { /* gone */ } }, 500)
}

export function registerAsio(getWindow: () => BrowserWindow | null) {
  rxTarget = getWindow
  ipcMain.handle('asio:list', () => call('list'))
  ipcMain.handle('asio:open', (_e, cfg) => call('open', cfg))
  ipcMain.handle('asio:close', async () => { if (child) await call('close') })
  ipcMain.on('asio:tx', (_e, planar: Float32Array) => {
    if (child?.connected) child.send({ type: 'tx', planar })
  })
}
