// Hardware call lights: when someone calls on the intercom, switch something on this gateway's network (a relay, a Companion
// button, a lighting controller), and switch it off again after a few seconds.

export interface LightAction { kind: 'http' | 'tcp' | 'udp'; target: string; data: string }
export interface LightRule {
  id: string
  name: string
  /** Channel ids whose calls light this. Empty = a call on any channel. */
  channels: string[]
  /** Also light for an ALL CALL. */
  allCall: boolean
  /** Seconds the light stays on after the last call. */
  holdSec: number
  on: LightAction
  off: LightAction
}

export const newRule = (n: number): LightRule => ({
  id: 'l' + Date.now().toString(36) + n, name: `Call light ${n}`, channels: [], allCall: true, holdSec: 10,
  on: { kind: 'http', target: '', data: '' }, off: { kind: 'http', target: '', data: '' },
})

/** A call key is a channel id, '*' for an all-call, or 'u:<peer>' for a call to one person. */
export function ruleMatches(rule: LightRule, key: string): boolean {
  if (key.startsWith('u:')) return false // a call to one person is not for the room's light
  if (key === '*') return rule.allCall
  return rule.channels.length === 0 || rule.channels.includes(key)
}

type Fire = (a: LightAction) => Promise<{ ok: boolean; error?: string }>

export class CallLights {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Last result per rule, for the page: undefined = never fired. */
  results = new Map<string, { at: number; ok: boolean; error?: string }>()
  constructor(private rules: () => LightRule[], private fire: Fire, private changed: () => void) {}

  /** A call arrived: light every rule it matches. */
  handle(key: string) { for (const r of this.rules()) if (ruleMatches(r, key)) void this.light(r) }

  async light(r: LightRule) {
    clearTimeout(this.timers.get(r.id))
    await this.run(r, r.on)
    if (r.holdSec > 0 && r.off.target.trim()) this.timers.set(r.id, setTimeout(() => void this.run(r, r.off), r.holdSec * 1000))
  }

  /** The Test button: on, then off after the hold time, exactly like a real call. */
  test(r: LightRule) { return this.light(r) }

  private async run(r: LightRule, a: LightAction) {
    const res = await this.fire(a).catch((e: Error) => ({ ok: false, error: e.message }))
    this.results.set(r.id, { at: Date.now(), ok: res.ok, error: res.ok ? undefined : res.error })
    this.changed()
  }

  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear() }
}
