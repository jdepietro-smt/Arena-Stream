'use strict'
// Monitoring and alerting. Every few seconds the portal looks at the whole system (streams on air, decoders, services, load,
// memory, disks) and keeps three things: a short history per stream (for graphs and uptime), a list of alerts that are open
// right now, and a log of alerts that opened and closed. When an alert opens or closes it can be sent to a webhook (Slack,
// Teams and most paging tools accept this JSON; the `text` field is the readable message).
//
// Pure logic: `collect()` is given by the caller and returns a snapshot, so all of this is testable without a server.
//   snapshot = { at?, directoryOk, encoders: [{ id, name, kbps, measuredKbps? }], decoders: [{ id, name }],
//                services: [{ name, label, installed, active }], system: { load: [1,5,15], cpus, memTotal, memFree },
//                disks: [{ mount, total, free }] }
const fs = require('node:fs')
const path = require('node:path')

const HISTORY_MS = 24 * 3600 * 1000
const BUCKET_MS = 60 * 1000
const MAX_EVENTS = 500

const DEFAULTS = {
  offlineSec: 15,          // a stream that was on air and is gone this long is an alert
  lowRatePct: 50,          // measured rate under this share of the announced rate ...
  lowRateSec: 20,          // ... for this long
  decoderOfflineSec: 45,
  serviceDownSec: 10,
  cpuLoadPct: 90, cpuSec: 90,        // 1-minute load as a share of all cores
  memFreePct: 8, memSec: 90,
  diskWarnPct: 90, diskCritPct: 97,
  forgetStreamHours: 24,   // a stream that has not been seen for this long stops being expected
}

function openMonitor({ dir, collect, notify, now = Date.now, opts = {} }) {
  const o = { ...DEFAULTS, ...opts }
  const file = dir ? path.join(dir, 'monitor.json') : null
  let data = { streams: {}, decoders: {}, events: [], seq: 0 }
  if (file) { try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { /* first run */ } }
  const active = new Map()   // key -> alert (kept in memory; a restart re-derives them within a few seconds)
  const since = new Map()    // condition key -> when it first became true (for "for this long" rules)
  let lastTick = 0, lastSave = 0, lastSnap = null, collectFailing = 0

  const save = (force) => {
    if (!file) return
    const t = now()
    if (!force && t - lastSave < 60000) return
    lastSave = t
    try { fs.mkdirSync(dir, { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file) } catch { /* disk trouble is reported by the disk rule */ }
  }

  function raise(key, severity, title, detail) {
    const cur = active.get(key)
    if (cur) { cur.detail = detail; cur.severity = severity; return }
    const a = { id: ++data.seq, key, severity, title, detail, openedAt: now() }
    active.set(key, a)
    data.events.push({ id: a.id, key, severity, title, detail, openedAt: a.openedAt, closedAt: 0 })
    if (data.events.length > MAX_EVENTS) data.events.splice(0, data.events.length - MAX_EVENTS)
    fire('open', a)
  }
  function clear(key) {
    const a = active.get(key)
    if (!a) return
    active.delete(key)
    const ev = data.events.find(e => e.id === a.id)
    if (ev) ev.closedAt = now()
    fire('resolved', { ...a, closedAt: now() })
  }
  function fire(kind, a) {
    if (!notify) return
    try { Promise.resolve(notify(kind, a)).catch(() => {}) } catch { /* a bad webhook must never stop monitoring */ }
  }
  // A condition has to hold for `sec` seconds before it is an alert (so a blip is not one); it clears at once when it stops.
  function sustained(key, cond, sec) {
    if (!cond) { since.delete(key); return false }
    if (!since.has(key)) since.set(key, now())
    return now() - since.get(key) >= sec * 1000
  }

  function bucketOf(t) { return Math.floor(t / BUCKET_MS) * BUCKET_MS }
  function addPoint(rec, t, up, kbps) {
    const b = bucketOf(t)
    let p = rec.history[rec.history.length - 1]
    if (!p || p.t !== b) { p = { t: b, n: 0, up: 0, kbps: 0 }; rec.history.push(p) }
    p.n++; if (up) { p.up++; p.kbps += kbps || 0 }
    const cut = t - HISTORY_MS
    while (rec.history.length && rec.history[0].t < cut) rec.history.shift()
  }

  async function tick() {
    const t = now()
    let s
    try { s = await collect(); collectFailing = 0 } catch (e) {
      collectFailing++
      if (collectFailing >= 3) raise('monitor.collect', 'warning', 'Monitoring cannot read the server', String(e && e.message || e))
      return
    }
    clear('monitor.collect')
    lastSnap = s; lastTick = t

    // Directory down means we cannot tell streams from decoders: say that, and do not blame every stream.
    if (!s.directoryOk) {
      if (sustained('dir', true, 10)) raise('app.directory', 'critical', 'Arena Link directory is not reachable', 'Streams and decoders cannot be listed. Check the arena-link-directory service.')
    } else { sustained('dir', false); clear('app.directory') }

    if (s.directoryOk) {
      // Streams
      const seen = new Set()
      for (const e of s.encoders || []) {
        seen.add(e.id)
        const rec = data.streams[e.id] || (data.streams[e.id] = { id: e.id, name: e.name, firstSeen: t, history: [] })
        rec.name = e.name; rec.lastSeen = t; rec.kbps = e.kbps; rec.measuredKbps = e.measuredKbps ?? null
        addPoint(rec, t, true, e.measuredKbps ?? e.kbps)
        clear('stream.offline:' + e.id)
        const low = e.measuredKbps != null && e.kbps > 0 && e.measuredKbps < e.kbps * o.lowRatePct / 100
        if (sustained('low:' + e.id, low, o.lowRateSec)) raise('stream.lowrate:' + e.id, 'warning', `${e.name}: video rate is low`, `Receiving about ${Math.round(e.measuredKbps)} kbps of the ${e.kbps} kbps it announces. The link from this site may be struggling.`)
        else if (!low) clear('stream.lowrate:' + e.id)
      }
      for (const rec of Object.values(data.streams)) {
        if (seen.has(rec.id)) continue
        addPoint(rec, t, false, 0)
        since.delete('low:' + rec.id); clear('stream.lowrate:' + rec.id)
        const gone = (t - (rec.lastSeen || 0)) / 1000
        if (t - rec.lastSeen > o.forgetStreamHours * 3600 * 1000) { delete data.streams[rec.id]; clear('stream.offline:' + rec.id); continue }
        if (gone >= o.offlineSec) raise('stream.offline:' + rec.id, 'critical', `${rec.name} went off air`, `Last seen ${Math.round(gone)} s ago.`)
      }
      // Decoders
      const dseen = new Set()
      for (const d of s.decoders || []) { dseen.add(d.id); data.decoders[d.id] = { id: d.id, name: d.name, lastSeen: t }; clear('decoder.offline:' + d.id) }
      for (const d of Object.values(data.decoders)) {
        if (dseen.has(d.id)) continue
        if (t - d.lastSeen > o.forgetStreamHours * 3600 * 1000) { delete data.decoders[d.id]; clear('decoder.offline:' + d.id); continue }
        if ((t - d.lastSeen) / 1000 >= o.decoderOfflineSec) raise('decoder.offline:' + d.id, 'warning', `Decoder ${d.name} is offline`, `Last heard from ${Math.round((t - d.lastSeen) / 1000)} s ago.`)
      }
    }

    // Services
    for (const sv of s.services || []) {
      if (!sv.installed) continue
      const down = !sv.active
      if (sustained('svc:' + sv.name, down, o.serviceDownSec)) raise('service.down:' + sv.name, 'critical', `${sv.label || sv.name} is not running`, `The ${sv.name} service is stopped or failing.`)
      else if (!down) clear('service.down:' + sv.name)
    }

    // Machine
    const sys = s.system
    if (sys && sys.cpus) {
      const pct = sys.load[0] / sys.cpus * 100
      if (sustained('cpu', pct >= o.cpuLoadPct, o.cpuSec)) raise('system.cpu', 'warning', 'Server is overloaded', `Load is ${sys.load[0].toFixed(1)} on ${sys.cpus} cores (${Math.round(pct)}%). Streams may start to drop.`)
      else if (pct < o.cpuLoadPct - 10) clear('system.cpu')
      const freePct = sys.memTotal ? sys.memFree / sys.memTotal * 100 : 100
      if (sustained('mem', freePct <= o.memFreePct, o.memSec)) raise('system.memory', 'warning', 'Server is low on memory', `Only ${freePct.toFixed(1)}% of memory is free.`)
      else if (freePct > o.memFreePct + 4) clear('system.memory')
    }
    for (const d of s.disks || []) {
      const used = d.total ? (d.total - d.free) / d.total * 100 : 0
      const key = 'disk:' + d.mount
      if (used >= o.diskCritPct) raise(key, 'critical', `Disk ${d.mount} is almost full`, `${used.toFixed(1)}% used. Recording and logs will fail.`)
      else if (used >= o.diskWarnPct) raise(key, 'warning', `Disk ${d.mount} is getting full`, `${used.toFixed(1)}% used.`)
      else if (used < o.diskWarnPct - 2) clear(key)
    }
    save(false)
  }

  const uptimePct = rec => {
    const h = rec.history; if (!h.length) return null
    let n = 0, up = 0; for (const p of h) { n += p.n; up += p.up }
    return n ? Math.round(up / n * 1000) / 10 : null
  }
  function state() {
    const t = now()
    return {
      at: t, lastTick, running: !!lastTick && t - lastTick < 30000,
      alerts: [...active.values()].sort((a, b) => (a.severity === b.severity ? b.openedAt - a.openedAt : a.severity === 'critical' ? -1 : 1)),
      streams: Object.values(data.streams).map(r => ({
        id: r.id, name: r.name, live: r.lastSeen === lastTick, lastSeen: r.lastSeen, kbps: r.kbps, measuredKbps: r.measuredKbps, uptimePct: uptimePct(r),
        series: r.history.slice(-180).map(p => ({ t: p.t, kbps: p.up ? Math.round(p.kbps / p.up) : 0, up: p.n ? p.up / p.n : 0 })),
      })).sort((a, b) => a.name.localeCompare(b.name)),
      decoders: Object.values(data.decoders).map(d => ({ ...d, live: d.lastSeen === lastTick })),
      events: data.events.slice(-100).reverse(),
      snapshot: lastSnap && { system: lastSnap.system, disks: lastSnap.disks },
    }
  }
  return { tick, state, flush: () => save(true), _active: active }
}

// The message sent to a webhook. `text` is what Slack and Teams show; the rest is for tools that read JSON.
function webhookBody(kind, a, site = 'Arena Portal') {
  const icon = kind === 'resolved' ? 'OK' : a.severity === 'critical' ? 'CRITICAL' : 'WARNING'
  const text = kind === 'resolved'
    ? `[${icon}] Resolved: ${a.title} (was down ${Math.max(1, Math.round((a.closedAt - a.openedAt) / 1000))} s)`
    : `[${icon}] ${a.title}. ${a.detail || ''}`.trim()
  return { text: `${site}: ${text}`, kind, severity: a.severity, title: a.title, detail: a.detail, key: a.key, openedAt: new Date(a.openedAt).toISOString(), ...(a.closedAt ? { closedAt: new Date(a.closedAt).toISOString() } : {}) }
}

module.exports = { openMonitor, webhookBody, DEFAULTS }
