// Outbound alerts: one webhook URL (Slack, Teams, Discord and most chat tools accept a JSON post). The admin
// sets it on the History page; it is kept next to the directory. With no URL set nothing is ever sent.
import fs from 'node:fs'
import path from 'node:path'

export function createAlerter(file = null, fetchImpl = globalThis.fetch) {
  let url = ''
  try { if (file) url = JSON.parse(fs.readFileSync(file, 'utf8')).url ?? '' } catch { /* none yet */ }
  const cooldown = new Map()

  return {
    configured: () => !!url,
    /** Only the host, never the secret path of the URL. */
    host: () => { try { return url ? new URL(url).host : '' } catch { return '' } },
    set(next) {
      const v = String(next ?? '').trim()
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error('That is not a web address (it must start with http:// or https://)')
      url = v
      if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ url }), { mode: 0o600 }) }
    },
    /** Send `text`; `key` throttles repeats of the same alert to once per `coolMs`. Resolves true when delivered. */
    async notify(text, key = '', coolMs = 0) {
      if (!url) return false
      const now = Date.now()
      if (key && coolMs && now - (cooldown.get(key) ?? 0) < coolMs) return false
      if (key) cooldown.set(key, now)
      try {
        const r = await fetchImpl(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `Arena Comms: ${text}`, content: `Arena Comms: ${text}` }), // Slack/Teams read "text", Discord "content"
          signal: AbortSignal.timeout(8000),
        })
        return r.ok
      } catch (e) {
        console.warn(`[arena-comms] alert not delivered: ${e.message}`)
        return false
      }
    },
  }
}
