'use strict'
// Monitoring and alerting. Every few seconds the portal looks at the whole system (streams on air, decoders, services, load,
// memory, disks) and keeps three things: a short history per stream (for graphs and uptime), a list of alerts that are open
// right now, and a log of alerts that opened and closed. When an alert opens or closes it can be sent to a webhook (Slack,
// Teams and most paging tools accept this JSON; the `text` field is the readable message).
//
// Pure logic: `collect()` is given by the caller and returns a snapshot, so all of this is testable without a server.
//   snapshot = { at?, directoryOk, encoders: [{ id, name, kbps, measuredKbps? }], decoders: [{ id, name }],
//                (encoders may carry paths: { total, up, fec, lossPct, relays: [{ host, port, up, rttMs }] }; decoders paths: { paths, up, pathUp, rttMs })
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
  recSec: 60,                        // a chosen stream is on air but not being recorded this long
  standbySec: 30,                    // the backup directory unreachable, or missing streams, this long
  pathSec: 20,                       // a relay down (or a decoder path lost) this long is an alert
  lossyPct: 5, lossySec: 30,         // re-sends above this share of packets on the way to the relay
  forgetStreamHours: 24,   // a stream that has not been seen for this long stops being expected
}

function openMonitor({ dir, collect, notify, now = Date.now, opts = {} }) {
  const o = { ...DEFAULTS, ...opts }
  const file = dir ? path.join(dir, 'monitor.json') : null
  let data = { streams: {}, decoders: {}, events: [], seq: 0, stopped: {} }
  if (file) { try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { /* first run */ } }
  const active = new Map()   // key -> alert (kept in memory; a restart re-derives them within a few seconds)
  const since = new Map()    // condition key -> when it first became true (for "for this long" rules)
  const ext = new Map()      // alerts raised from outside (a failed scheduled start): key -> when they close by themselves
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

  // A stream stopped on purpose (from the portal, or by a schedule) is not "off air": no alert until it is seen live again.
  function expectOff(name) { data.stopped[String(name)] = now() }
  // An alert raised by something other than the checks above. It closes by itself after `ttlSec`.
  function external(key, severity, title, detail, ttlSec = 900) { raise(key, severity, title, detail); ext.set(key, now() + ttlSec * 1000) }

  async function tick() {
    const t = now()
    for (const [k, until] of ext) if (t >= until) { ext.delete(k); clear(k) }
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

    // The backup directory (if one is set): it should answer, and know the same streams as the main one.
    const sb = s.standby
    if (sb && s.directoryOk) {
      if (sustained('sbdown', !sb.ok, o.standbySec)) raise('directory.standby', 'warning', 'The backup directory is not reachable', `${sb.error || 'no answer'}. If the main directory fails now, PCs have nothing to fall back to.`)
      else if (sb.ok) clear('directory.standby')
      const missing = sb.ok ? (s.encoders || []).filter(e => !(sb.ids || []).includes(e.id)) : []
      if (sustained('sbsync', missing.length > 0, o.standbySec + 10)) raise('directory.standby.sync', 'warning', `${missing.length} stream${missing.length > 1 ? 's' : ''} not announced to the backup directory`, `${missing.map(e => e.name).slice(0, 6).join(', ')}${missing.length > 6 ? ', ...' : ''}. These PCs need the backup address in the Link app's Settings (and the new app version); until then they would disappear if the main directory failed.`)
      else if (!missing.length) clear('directory.standby.sync')
    } else if (!sb) { since.delete('sbdown'); since.delete('sbsync'); clear('directory.standby'); clear('directory.standby.sync') }

    // Recording: the service is up, everything chosen that is on air is really being recorded, and the disk has room.
    const rc = s.recorder
    if (rc) {
      if (sustained('recdown', !rc.ok, o.standbySec)) raise('recorder.down', 'warning', 'The recording service is not answering', `${rc.error || 'no answer'}. Nothing new is being recorded until it is back (check the arena-recorder service).`)
      else if (rc.ok) clear('recorder.down')
      const names = new Set()
      for (const r of rc.streams || []) {
        if (!r.selected || !r.live) continue
        names.add(r.name)
        const bad = r.state !== 'recording'
        if (sustained('rec:' + r.name, bad, o.recSec)) raise('recording.stalled:' + r.name, 'warning', `${r.name} is on air but not being recorded`, `The recorder reports it as "${r.state}". Check the stream's relay connection and the recorder log.`)
        else if (!bad) clear('recording.stalled:' + r.name)
      }
      for (const k of [...active.keys()]) if (k.startsWith('recording.stalled:') && !names.has(k.slice(18))) clear(k)
      const low = rc.ok && typeof rc.freePct === 'number' && rc.freePct < (rc.minFreePct || 10) + 2
      if (low) raise('recording.disk', 'warning', 'The recording disk is nearly full', `${rc.freePct.toFixed(1)}% is free. The recorder deletes the oldest recordings when it falls below ${rc.minFreePct || 10}%, so fewer than the chosen days will be kept. Record fewer streams, or give it more space.`)
      else if (rc.ok) clear('recording.disk')
      const recentTrim = rc.ok && rc.trimmedAt && t - rc.trimmedAt < 3600 * 1000
      if (recentTrim) raise('recording.trimmed', 'warning', 'The disk filled up: the oldest recordings were deleted early', `About ${Math.round((rc.trimmedBytes || 0) / 1048576)} MB of the oldest recordings were removed to make room, so older footage than expected is gone.`)
      else clear('recording.trimmed')
    } else {
      for (const k of [...active.keys()]) if (k === 'recorder.down' || k === 'recording.disk' || k === 'recording.trimmed' || k.startsWith('recording.stalled:')) clear(k)
    }

    if (s.directoryOk) {
      // Streams
      const seen = new Set()
      for (const e of s.encoders || []) {
        seen.add(e.id)
        // Still announcing in the first seconds after a stop is the old stream finishing, not a new start.
        if (data.stopped[e.name] && t - data.stopped[e.name] > 20000) delete data.stopped[e.name]
        const rec = data.streams[e.id] || (data.streams[e.id] = { id: e.id, name: e.name, firstSeen: t, history: [] })
        rec.name = e.name; rec.lastSeen = t; rec.kbps = e.kbps; rec.measuredKbps = e.measuredKbps ?? null; rec.paths = e.paths || null
        addPoint(rec, t, true, e.measuredKbps ?? e.kbps)
        clear('stream.offline:' + e.id)
        const low = e.measuredKbps != null && e.kbps > 0 && e.measuredKbps < e.kbps * o.lowRatePct / 100
        if (sustained('low:' + e.id, low, o.lowRateSec)) raise('stream.lowrate:' + e.id, 'warning', `${e.name}: video rate is low`, `Receiving about ${Math.round(e.measuredKbps)} kbps of the ${e.kbps} kbps it announces. The link from this site may be struggling.`)
        else if (!low) clear('stream.lowrate:' + e.id)

        // Relays: the encoder reports each relay it publishes to. With two, losing one is not an outage but it is no longer
        // protected; with none reachable, remote viewers and decoders cannot get the stream at all.
        const pa = e.paths
        const down = pa && Array.isArray(pa.relays) ? pa.relays.filter(r => !r.up).map(r => `${r.host}:${r.port}`) : []
        const none = !!pa && pa.total >= 1 && pa.up === 0
        const part = !!pa && pa.total >= 2 && pa.up >= 1 && pa.up < pa.total
        if (sustained('relnone:' + e.id, none, o.pathSec)) raise('stream.relays:' + e.id, 'critical', `${e.name}: not reaching any relay`, `${down.join(', ') || 'The relay'} not connected. Remote decoders and web links cannot see this stream; a decoder on the same network still can.`)
        else if (!none) clear('stream.relays:' + e.id)
        if (sustained('relpart:' + e.id, part, o.pathSec)) raise('stream.redundancy:' + e.id, 'warning', `${e.name}: running without a backup relay`, `Not connected: ${down.join(', ')}. Playback is fine, but a failure of the other relay would now take the stream down.`)
        else if (!part) clear('stream.redundancy:' + e.id)
        const lossy = !!pa && typeof pa.lossPct === 'number' && pa.lossPct >= o.lossyPct
        if (sustained('lossy:' + e.id, lossy, o.lossySec)) raise('stream.lossy:' + e.id, 'warning', `${e.name}: the link to the relay is losing packets`, `${pa.lossPct.toFixed(1)}% had to be re-sent.${pa.fec && pa.fec !== 'off' ? ' Packet loss protection is on (' + pa.fec + ').' : ' Turning on packet loss protection for this stream (Light or Standard) should help.'}`)
        else if (!lossy || pa.lossPct < o.lossyPct / 2) clear('stream.lossy:' + e.id)
      }
      for (const rec of Object.values(data.streams)) {
        if (seen.has(rec.id)) continue
        addPoint(rec, t, false, 0)
        since.delete('low:' + rec.id); clear('stream.lowrate:' + rec.id)
        const gone = (t - (rec.lastSeen || 0)) / 1000
        if (data.stopped[rec.name]) { clear('stream.offline:' + rec.id); continue }
        if (t - rec.lastSeen > o.forgetStreamHours * 3600 * 1000) { delete data.streams[rec.id]; clear('stream.offline:' + rec.id); continue }
        if (gone >= o.offlineSec) raise('stream.offline:' + rec.id, 'critical', `${rec.name} went off air`, `Last seen ${Math.round(gone)} s ago.`)
      }
      // Decoders
      const dseen = new Set()
      for (const d of s.decoders || []) {
        dseen.add(d.id); data.decoders[d.id] = { id: d.id, name: d.name, lastSeen: t, paths: d.paths || null }; clear('decoder.offline:' + d.id)
        const lost = !!d.paths && d.paths.paths === 2 && d.paths.up < 2
        if (sustained('decpath:' + d.id, lost, o.pathSec)) raise('decoder.path:' + d.id, 'warning', `Decoder ${d.name}: running on one relay path`, `It is set to use two relays and ${d.paths.up === 0 ? 'has none connected' : 'has lost one'}. It keeps playing, but without protection.`)
        else if (!lost) clear('decoder.path:' + d.id)
      }
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
        id: r.id, name: r.name, paths: r.lastSeen === lastTick ? r.paths || null : null, live: r.lastSeen === lastTick, stopped: !!data.stopped[r.name] && r.lastSeen !== lastTick, lastSeen: r.lastSeen, kbps: r.kbps, measuredKbps: r.measuredKbps, uptimePct: uptimePct(r),
        series: r.history.slice(-180).map(p => ({ t: p.t, kbps: p.up ? Math.round(p.kbps / p.up) : 0, up: p.n ? p.up / p.n : 0 })),
      })).sort((a, b) => a.name.localeCompare(b.name)),
      decoders: Object.values(data.decoders).map(d => ({ ...d, paths: d.lastSeen === lastTick ? d.paths : null, live: d.lastSeen === lastTick })),
      events: data.events.slice(-100).reverse(),
      snapshot: lastSnap && { system: lastSnap.system, disks: lastSnap.disks },
      standby: lastSnap && lastSnap.standby ? { ok: lastSnap.standby.ok, error: lastSnap.standby.error || '', count: (lastSnap.standby.ids || []).length } : null,
    }
  }
  return { tick, state, expectOff, external, flush: () => save(true), _active: active }
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
