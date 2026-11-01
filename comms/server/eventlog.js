// Operational history: who joined and left, loss episodes, and a per-minute link-quality summary per
// person. Kept in memory for the admin page and appended to a JSON-lines file so it survives restarts.
import fs from 'node:fs'
import path from 'node:path'

const KEEP_MS = 14 * 24 * 3600 * 1000
const MAX_ENTRIES = 20_000

export function createEventLog(file = null, now = () => Date.now()) {
  let entries = []
  if (file) {
    try {
      const cutoff = now() - KEEP_MS
      entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) } catch { return null } })
        .filter(e => e && e.t >= cutoff).slice(-MAX_ENTRIES)
      fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
    } catch { /* first run */ }
    try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* ignore */ }
  }

  function add(e) {
    entries.push(e)
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES / 2)
    if (file) fs.appendFile(file, JSON.stringify(e) + '\n', () => {})
  }

  return {
    /** kind: join | leave | loss | recovered. */
    event(kind, name, detail = '') { const e = { t: now(), k: kind, name, detail }; add(e); this.onEvent?.(e) },
    /** Optional hook, called for every event (the server wires alerts here). */
    onEvent: null,

    /** One link report from a station; folded into a per-minute record. `agg` lives on the peer. */
    link(name, agg, sample) {
      const minute = Math.floor(now() / 60_000) * 60_000
      if (agg.minute !== undefined && agg.minute !== minute) this.flush(name, agg)
      if (agg.minute !== minute) Object.assign(agg, { minute, tx: 0, rx: 0, n: 0, bad: 0, sumTx: 0, sumRx: 0 })
      agg.tx = Math.max(agg.tx, sample.tx); agg.rx = Math.max(agg.rx, sample.rx)
      agg.sumTx += sample.tx; agg.sumRx += sample.rx; agg.n++
      if (sample.tx > 2 || sample.rx > 2) agg.bad++
      // Loss episode: log once when it starts and once when it clears.
      const lossy = sample.tx > 5 || sample.rx > 5
      if (lossy && !agg.inLoss) { agg.inLoss = true; this.event('loss', name, `send ${sample.tx.toFixed(0)}% · hear ${sample.rx.toFixed(0)}%`) }
      else if (!lossy && agg.inLoss && sample.tx < 1 && sample.rx < 1) { agg.inLoss = false; this.event('recovered', name) }
    },

    flush(name, agg) {
      if (agg.minute === undefined || !agg.n) return
      add({ t: agg.minute, k: 'link', name, tx: +agg.tx.toFixed(1), rx: +agg.rx.toFixed(1), avgTx: +(agg.sumTx / agg.n).toFixed(2), avgRx: +(agg.sumRx / agg.n).toFixed(2), n: agg.n, bad: agg.bad })
      agg.n = 0
    },

    /** Newest-first events (not the per-minute link records). */
    recent(limit = 200) {
      return entries.filter(e => e.k !== 'link').slice(-limit).reverse()
    },

    /** Per person, last `hours`: minutes observed, minutes with loss over 2 %, worst loss, mean loss. */
    history(hours = 24) {
      const since = now() - hours * 3600 * 1000
      const by = new Map()
      for (const e of entries) {
        if (e.k !== 'link' || e.t < since) continue
        const h = by.get(e.name) ?? { name: e.name, minutes: 0, lossyMinutes: 0, worstTx: 0, worstRx: 0, sumTx: 0, sumRx: 0, last: 0 }
        h.minutes++; if (e.bad) h.lossyMinutes++
        h.worstTx = Math.max(h.worstTx, e.tx); h.worstRx = Math.max(h.worstRx, e.rx)
        h.sumTx += e.avgTx; h.sumRx += e.avgRx; h.last = Math.max(h.last, e.t)
        by.set(e.name, h)
      }
      return [...by.values()].map(h => ({
        name: h.name, minutes: h.minutes, lossyMinutes: h.lossyMinutes, worstTx: h.worstTx, worstRx: h.worstRx,
        avgTx: +(h.sumTx / h.minutes).toFixed(2), avgRx: +(h.sumRx / h.minutes).toFixed(2), last: h.last,
      })).sort((a, b) => b.lossyMinutes - a.lossyMinutes || a.name.localeCompare(b.name))
    },
  }
}
