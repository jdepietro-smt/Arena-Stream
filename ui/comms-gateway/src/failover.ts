// Backup internet line. Watches the audio the gateway sends and, when the main line is dropping it, moves the PC onto the
// backup network adapter and reconnects; later it tries the main line again. Every decision is kept in `log` for the Home page.
import type { CommsEngine } from '@engine'

const TICK_MS = 2000
const BAD_LOSS = 8          // % of sent audio lost, over a tick
const BAD_TICKS = 4         // in a row (8 s) before switching
const MIN_BACKUP_MS = 10 * 60_000
const MAX_BACKUP_MS = 60 * 60_000

export type LineState = 'off' | 'main' | 'backup' | 'error'
export interface LineEvent { t: number; text: string }

export class LineFailover {
  state: LineState = 'off'
  error = ''
  log: LineEvent[] = []
  private cfg: { primary: string; secondary: string } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private bad = 0
  private disconnected = 0
  private since = 0
  private backupHold = MIN_BACKUP_MS
  private lastFailback = 0
  private busy = false

  constructor(private engine: CommsEngine, private onChange: () => void) {}

  /** Start, stop or re-aim the watcher whenever the settings change. */
  configure(c: { enabled: boolean; primary: string; secondary: string } | undefined) {
    const on = !!c?.enabled && !!c.primary && !!c.secondary && c.primary !== c.secondary && !!window.gw?.netPrefer
    const same = this.cfg && c && this.cfg.primary === c.primary && this.cfg.secondary === c.secondary
    if (!on) {
      if (this.timer) { clearInterval(this.timer); this.timer = null }
      if (this.state === 'backup') void window.gw?.netPrefer(null)
      this.cfg = null; this.state = 'off'; this.error = ''; this.onChange()
      return
    }
    if (same && this.timer) return
    this.cfg = { primary: c!.primary, secondary: c!.secondary }
    this.state = 'main'; this.error = ''; this.bad = 0; this.disconnected = 0; this.since = Date.now()
    if (!this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.use(this.cfg.primary, 'Started on the main line').then(() => this.onChange())
  }

  dispose() { if (this.timer) clearInterval(this.timer); this.timer = null }

  private note(text: string) { this.log = [{ t: Date.now(), text }, ...this.log].slice(0, 30); this.onChange() }

  private async use(alias: string, why: string): Promise<boolean> {
    const r = await window.gw!.netPrefer(alias)
    if (!r.ok) {
      this.state = 'error'; this.error = r.error
      this.note(`Could not switch to ${alias}: ${r.error}`)
      return false
    }
    this.note(why)
    return true
  }

  private async tick() {
    if (!this.cfg || this.busy) return
    const e = this.engine
    const link = e.linkNow
    const lossy = e.status === 'connected' && link.ok && link.tx > BAD_LOSS
    this.disconnected = e.status === 'connected' ? 0 : this.disconnected + 1
    this.bad = lossy ? this.bad + 1 : 0
    const trouble = this.bad >= BAD_TICKS || this.disconnected >= 5 // five ticks without a connection is also a bad line

    if (this.state === 'main' && trouble) return this.switchTo('backup', this.disconnected >= 5 ? 'The main line stopped carrying the connection' : `The main line was losing ${link.tx.toFixed(0)}% of the audio`)
    if (this.state === 'backup') {
      const held = Date.now() - this.since
      if (trouble && held > 30_000) return this.switchTo('main', 'The backup line is also having trouble: trying the main line') // both bad: alternate, slowly
      if (held >= this.backupHold && !trouble) return this.switchTo('main', 'Trying the main line again')
    }
    if (this.state === 'error' && Date.now() - this.since > 60_000) { this.state = 'main'; this.since = Date.now() } // let the user see the error, then retry
  }

  private async switchTo(which: 'main' | 'backup', why: string) {
    if (!this.cfg) return
    this.busy = true
    try {
      const shortStay = which === 'backup' && this.lastFailback > 0 && Date.now() - this.lastFailback < 3 * 60_000 // main failed soon after we went back to it: stay away longer
      const ok = await this.use(which === 'backup' ? this.cfg.secondary : this.cfg.primary, `${why}: switching to the ${which === 'backup' ? 'backup' : 'main'} line`)
      if (!ok) return
      this.backupHold = which === 'backup' ? (shortStay ? Math.min(this.backupHold * 2, MAX_BACKUP_MS) : MIN_BACKUP_MS) : this.backupHold
      if (which === 'main') this.lastFailback = Date.now()
      this.state = which; this.since = Date.now(); this.bad = 0; this.disconnected = 0
      this.engine.reconnect() // new connections leave by the new line
    } finally { this.busy = false; this.onChange() }
  }

  /** Settings button: move to the other line now, to prove that the PC can switch. */
  async testSwitch() {
    if (!this.cfg || this.busy) return
    await this.switchTo(this.state === 'backup' ? 'main' : 'backup', 'Manual test')
  }
}
