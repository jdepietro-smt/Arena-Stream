// ASIO bridge. The window's audio engine (Chromium) cannot use ASIO, and an interface like a Focusrite only offers a stereo
// pair to Windows' own audio. The real work happens in a helper process (asio-worker.ts) because audify's native module
// cannot be loaded inside Electron; the installer ships a plain node.exe for it. This file starts that helper and relays:
//
//   ASIO input channels  --planar blocks-->  window ('asio:rx', slot, block)   (each block is one device buffer)
//   window output blocks ('asio:tx', slot, block) --> helper --> per-channel rings --> mixed into each device output buffer
//
// A process can hold only one ASIO driver, so every interface (a Focusrite, Dante Virtual Soundcard, ...) gets its own helper,
// keyed by a slot name.

import { app, BrowserWindow, ipcMain } from 'electron'
import { ChildProcess, ForkOptions, fork } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface AsioDevice { id: number; name: string; inputChannels: number; outputChannels: number; sampleRates: number[] }

interface Slot { child: ChildProcess; pending: Map<number, (r: unknown) => void> }
const slots = new Map<string, Slot>()
let seq = 0
let rxTarget: (() => BrowserWindow | null) | null = null
let lastList: { ok: boolean; devices?: AsioDevice[]; error?: string } | null = null

/** The Node binary for the helper: the one shipped beside the app, else the Node on this machine (development). */
function nodeBinary(): string | undefined {
  const shipped = path.join(process.resourcesPath ?? '', 'node', 'node.exe')
  return fs.existsSync(shipped) ? shipped : undefined
}

function workerPath(): string {
  // Packaged: the script and audify sit unpacked beside app.asar so a plain Node can read them.
  return path.join(__dirname, 'asio-worker.js').replace('app.asar', 'app.asar.unpacked')
}

function start(name: string): Slot | null {
  const have = slots.get(name)
  if (have && have.child.connected) return have
  const exec = nodeBinary()
  if (app.isPackaged && !exec) return null
  const c = fork(workerPath(), [], {
    ...(exec ? { execPath: exec } : {}),
    windowsHide: true, // node.exe is a console program; do not show its window
    serialization: 'advanced', // typed arrays travel as binary
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  } as ForkOptions)
  const slot: Slot = { child: c, pending: new Map() }
  c.on('message', (m: { id?: number; result?: unknown; type?: string; planar?: Float32Array; peaks?: Float32Array }) => {
    if (m.id != null) {
      const done = slot.pending.get(m.id)
      slot.pending.delete(m.id)
      done?.(m.result)
    } else if (m.type === 'rx') {
      const win = rxTarget?.()
      if (win && !win.isDestroyed()) win.webContents.send('asio:rx', name, m.planar, m.peaks)
    }
  })
  const gone = () => {
    if (slots.get(name) === slot) slots.delete(name)
    for (const done of slot.pending.values()) done({ ok: false, error: 'The ASIO helper stopped' })
    slot.pending.clear()
  }
  c.on('exit', gone)
  c.on('error', gone)
  slots.set(name, slot)
  return slot
}

function call(name: string, type: string, cfg?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const s = start(name)
  if (!s) return Promise.resolve({ ok: false, error: 'ASIO helper is missing from this install' })
  return new Promise(resolve => {
    const id = ++seq
    const timer = setTimeout(() => { s.pending.delete(id); resolve({ ok: false, error: 'The ASIO driver did not answer' }) }, 20000)
    s.pending.set(id, r => { clearTimeout(timer); resolve(r as { ok: boolean }) })
    s.child.send({ id, type, cfg })
  })
}

/** Close one interface, or all of them. */
export function asioClose(name?: string) {
  for (const [n, s] of [...slots]) {
    if (name && n !== name) continue
    slots.delete(n)
    try { s.child.send({ id: 0, type: 'close' }) } catch { /* gone */ }
    setTimeout(() => { try { s.child.kill() } catch { /* gone */ } }, 500)
  }
}

export function registerAsio(getWindow: () => BrowserWindow | null) {
  rxTarget = getWindow
  ipcMain.handle('asio:list', async () => {
    // Probing drivers while another process holds one can fail, so reuse the last good list while any interface is open.
    if (slots.size && lastList?.ok) return lastList
    const r = await call('_list', 'list')
    if (r.ok) lastList = r as typeof lastList
    if (!slots.has('_list')) return r
    asioClose('_list')
    return r
  })
  ipcMain.handle('asio:open', async (_e, name: string, cfg: { deviceId: number }) => {
    const r = await call(name, 'open', cfg)
    // Opening reports the driver's real channel counts; keep the cached list in step (it can be older than a driver setting change).
    const d = lastList?.devices?.find(x => x.id === cfg.deviceId)
    if (r.ok && d) { d.inputChannels = r.inputChannels as number; d.outputChannels = r.outputChannels as number }
    return r
  })
  ipcMain.handle('asio:close', async (_e, name?: string) => { asioClose(name) })
  ipcMain.on('asio:tx', (_e, name: string, planar: Float32Array, first: number) => {
    const s = slots.get(name)
    if (s?.child.connected) s.child.send({ type: 'tx', planar, first })
  })
}
