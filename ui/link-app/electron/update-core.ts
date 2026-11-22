// Software updates, the parts with no side effects (so they can be tested on their own).
//
// A PC is offered a release by the Link directory (see link/directory/directory.py). It downloads the installer in the
// background, checks it, and then waits for a good moment to install: never while something is live unless a maintenance
// window says it may.

export type UpdateMode = 'idle' | 'ask' | 'off'
export interface Window { from: string; to: string }              // local times "HH:MM"; to < from means overnight

export interface Offer {
  update: boolean
  version?: string
  file?: string
  sha256?: string
  size?: number
  notes?: string
  exact?: boolean
}

// 1.10.0 is newer than 1.9.0; anything unreadable counts as 0.
export function parseVersion(v: string): number[] {
  const out = String(v ?? '').split('.').slice(0, 4).map(p => { const m = /^\d+/.exec(p); return m ? parseInt(m[0], 10) : 0 })
  while (out.length < 4) out.push(0)
  return out
}
export function cmpVersion(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

// Only a plain file name from the directory is ever used on disk: no folders, no ".." tricks.
export const safeFileName = (n: unknown): n is string => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(n)

// Should this offer be taken at all? The directory already filters, but the app does not trust that blindly.
export function worthTaking(offer: Offer | null | undefined, current: string): offer is Offer & { version: string; file: string; sha256: string; size: number } {
  if (!offer || !offer.update || !offer.version || !safeFileName(offer.file) || !/^[0-9a-f]{64}$/i.test(String(offer.sha256 || ''))) return false
  if (!(Number(offer.size) > 1024 * 1024)) return false
  return cmpVersion(offer.version, current) > 0 || (!!offer.exact && cmpVersion(offer.version, current) !== 0)
}

const mins = (hhmm: string): number | null => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm || ''); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null }

export function validWindow(w: Window | null | undefined): w is Window {
  return !!w && mins(w.from) !== null && mins(w.to) !== null && w.from !== w.to
}
export function inWindow(now: Date, w: Window | null | undefined): boolean {
  if (!validWindow(w)) return false
  const t = now.getHours() * 60 + now.getMinutes(), a = mins(w.from)!, b = mins(w.to)!
  return a < b ? t >= a && t < b : t >= a || t < b
}

export interface InstallContext {
  mode: UpdateMode
  live: boolean            // an encoder or decoder is running on this PC right now
  idleMs: number           // how long nothing has been live
  now: Date
  window?: Window | null
  manual: boolean          // someone pressed Install now
}
export const IDLE_BEFORE_INSTALL_MS = 2 * 60 * 1000

// Whether to install now, and if not, what it is waiting for (shown in the app and in the portal).
export function installDecision(c: InstallContext): { install: boolean; waiting: string } {
  if (c.manual) return { install: true, waiting: '' }
  if (c.mode === 'off') return { install: false, waiting: 'updates are turned off' }
  if (c.mode === 'ask') return { install: false, waiting: 'your go-ahead' }
  if (inWindow(c.now, c.window)) return { install: true, waiting: '' }
  if (c.live) return { install: false, waiting: c.window && validWindow(c.window) ? `the maintenance window (${c.window.from}-${c.window.to}) or the stream to stop` : 'the stream to stop' }
  if (c.idleMs < IDLE_BEFORE_INSTALL_MS) return { install: false, waiting: 'a quiet moment' }
  return { install: true, waiting: '' }
}
