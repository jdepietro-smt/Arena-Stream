// Software updates inside the app: every ten minutes ask the directory whether a newer version is offered to this PC, download it
// in the background, and install it at a safe moment (see installDecision). The installer is the same NSIS installer people use
// by hand, run silently; it replaces the app and starts it again.
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { Offer, UpdateMode, Window, installDecision, worthTaking } from './update-core'
import { checkOffer, downloadRelease, cleanOld } from './update-net'
import { withDirectories, dirState } from './dirs'

export interface UpdaterStatus {
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error' | 'off'
  pending?: string          // version waiting to be installed
  pct?: number
  waiting?: string          // what it is waiting for before installing
  error?: string
  checkedAt?: number
}

export interface UpdaterEnv {
  app: 'link' | 'decoder' | 'comms'
  version: string
  host: string
  dir: string                                   // where installers are kept
  config: () => { directory: string; key: string; updateMode?: UpdateMode; updateWindow?: Window | null }
  isLive: () => boolean                         // an encoder or decoder is running
  prepareToQuit: () => Promise<void>            // stop everything gracefully so the installer can replace the files
  quit: () => void
  run?: (file: string, args: string[]) => void  // starts the installer (tests replace this)
  onStatus: (s: UpdaterStatus) => void
  log: (m: string) => void
}

const CHECK_EVERY_MS = 10 * 60 * 1000
const FIRST_CHECK_MS = 60 * 1000

export function startUpdater(env: UpdaterEnv) {
  let status: UpdaterStatus = { state: 'idle' }
  let offer: (Offer & { version: string; file: string; sha256: string; size: number }) | null = null
  let file: string | null = null          // downloaded and checked
  let busy = false, manual = false, idleSince = Date.now(), failures = 0
  const set = (s: UpdaterStatus) => { status = s; env.onStatus(s) }
  const mode = (): UpdateMode => env.config().updateMode ?? 'idle'

  async function check() {
    if (busy || status.state === 'installing') return
    const c = env.config()
    if (mode() === 'off') { set({ state: 'off', checkedAt: Date.now() }); return }
    if (!c.directory || !c.key) return
    busy = true
    try {
      set({ ...status, state: file ? 'ready' : 'checking' })
      const o = await withDirectories(c.directory, u => checkOffer({ directory: u, key: c.key, app: env.app, host: env.host, version: env.version }), dirState)
      if (!worthTaking(o, env.version)) {
        // "nothing to install" from the backup directory is not proof: it may simply not hold the release files. Only the main
        // directory (first address) can withdraw an update that is already downloaded.
        if (dirState.last !== 0 && file && offer) { set({ state: 'ready', pending: offer.version, checkedAt: Date.now(), waiting: installDecision(ctx()).waiting }); return }
        offer = null; file = null; cleanOld(env.dir, null)
        set({ state: 'idle', checkedAt: Date.now() }); failures = 0; return
      }
      if (!file || !offer || offer.version !== o.version || offer.sha256 !== o.sha256) {
        offer = o; file = null
        set({ state: 'downloading', pending: o.version, pct: 0, checkedAt: Date.now() })
        env.log(`[update] ${o.version} is offered, downloading`)
        let last = 0
        file = await withDirectories(c.directory, u => downloadRelease({ directory: u, key: c.key, app: env.app, offer: o, dir: env.dir, onProgress: pct => { if (pct !== last && pct % 5 === 0) { last = pct; set({ state: 'downloading', pending: o.version, pct, checkedAt: Date.now() }) } } }), dirState)
        cleanOld(env.dir, o.file)
        env.log(`[update] ${o.version} downloaded and checked`)
      }
      failures = 0
      set({ state: 'ready', pending: offer!.version, checkedAt: Date.now(), waiting: installDecision(ctx()).waiting })
    } catch (e) {
      failures++
      const msg = (e as Error).message
      env.log(`[update] ${msg}`)
      set({ state: 'error', pending: offer?.version, error: msg, checkedAt: Date.now() })
    } finally { busy = false }
  }

  const ctx = () => ({ mode: mode(), live: env.isLive(), idleMs: Date.now() - idleSince, now: new Date(), window: env.config().updateWindow, manual })

  async function tick() {
    if (env.isLive()) idleSince = Date.now()
    if (status.state !== 'ready' || !file || !offer) return
    const d = installDecision(ctx())
    if (d.waiting !== status.waiting) set({ ...status, waiting: d.waiting })
    if (d.install) await install()
  }

  async function install() {
    if (!file || status.state === 'installing') return
    const target = file, version = offer?.version
    set({ state: 'installing', pending: version })
    env.log(`[update] installing ${version}: stopping everything first`)
    try {
      await env.prepareToQuit()
      // The same silent switches electron-updater uses: no screens, and the installer starts the new app afterwards.
      const args = ['/S', '--updated', '--force-run']
      if (env.run) env.run(target, args)
      else spawn(target, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch (e) { set({ state: 'error', pending: version, error: `could not start the installer: ${(e as Error).message}` }); manual = false; return }
    setTimeout(env.quit, 1500)
  }

  setTimeout(() => { void check() }, FIRST_CHECK_MS).unref?.()
  setInterval(() => { void check() }, CHECK_EVERY_MS).unref?.()
  setInterval(() => { void tick() }, 15000).unref?.()

  return {
    status: () => status,
    // "Install now" and "Check now" from the window.
    installNow: async () => { manual = true; if (status.state !== 'ready') await check(); if (status.state === 'ready') await install(); else manual = false },
    checkNow: () => check(),
    failures: () => failures,
  }
}

export const installerPath = (dir: string, f: string) => path.join(dir, f)
