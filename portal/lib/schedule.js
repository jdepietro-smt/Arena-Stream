'use strict'
// Schedules: start (and optionally stop) a stream on an encoder PC at set times, once or on chosen weekdays.
// All times are wall-clock times in one named time zone (a setting), so "7:00 pm" stays 7:00 pm across daylight saving.
// Pure logic and a small file store; the portal's tick turns what is due into commands.
const fs = require('node:fs')
const path = require('node:path')

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const GRACE_MS = 10 * 60 * 1000     // a start missed by more than this (portal was down) is skipped, not run late

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

function parts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const o = {}
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute }
}
// How far this zone is ahead of UTC at `ts`, in ms.
function offsetAt(ts, tz) {
  const p = parts(ts, tz)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ts / 60000) * 60000
}
// The moment (UTC ms) at which the wall clock in `tz` reads y-m-d h:mi.
function zonedToTs(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  const first = guess - offsetAt(guess, tz)
  return guess - offsetAt(first, tz)
}
const dayKey = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()   // 0 = Sunday

// Every start/stop moment of this entry on the days around `now` (yesterday matters: a window that crosses midnight).
function occurrences(e, now, tz) {
  const t = parts(now, tz)
  const out = []
  for (const back of [1, 0]) {
    const D = addDays(t.y, t.m, t.d, -back)
    const key = dayKey(D.y, D.m, D.d)
    const applies = e.mode === 'once' ? e.date === key : (e.days || []).includes(dow(D.y, D.m, D.d))
    if (!applies) continue
    const [sh, sm] = e.start.split(':').map(Number)
    out.push({ key: key + ':start', action: 'start', at: zonedToTs(D.y, D.m, D.d, sh, sm, tz) })
    if (e.stop) {
      const [eh, em] = e.stop.split(':').map(Number)
      const next = e.stop <= e.start ? addDays(D.y, D.m, D.d, 1) : D
      out.push({ key: key + ':stop', action: 'stop', at: zonedToTs(next.y, next.m, next.d, eh, em, tz) })
    }
  }
  return out
}
// What should be sent right now: moments that have arrived, are not too old, and have not been sent.
function due(e, now, tz, graceMs = GRACE_MS) {
  if (!e.enabled) return []
  return occurrences(e, now, tz).filter(o => o.at <= now && now < o.at + graceMs && !(e.fired && e.fired[o.key]))
}
// The next moment this entry will act, for display.
function nextRun(e, now, tz) {
  if (!e.enabled) return null
  let best = null
  for (let n = 0; n <= 8; n++) {
    const t = parts(now + n * 86400000, tz)
    for (const o of occurrences(e, zonedToTs(t.y, t.m, t.d, 12, 0, tz), tz)) {
      if (o.at > now && !(e.fired && e.fired[o.key]) && (!best || o.at < best.at)) best = o
    }
    if (best) break
  }
  return best
}

function clean(input, tz) {
  const e = {}
  e.label = String(input.label || '').trim().slice(0, 80)
  e.host = String(input.host || '').trim().slice(0, 64)
  e.sid = String(input.sid || '').trim().slice(0, 64)
  e.hostName = String(input.hostName || e.host).trim().slice(0, 80)
  e.streamName = String(input.streamName || '').trim().slice(0, 80)
  if (!e.host || !e.sid) throw new Error('choose an encoder PC and a stream')
  e.mode = input.mode === 'once' ? 'once' : 'weekly'
  e.start = String(input.start || '')
  if (!HHMM.test(e.start)) throw new Error('start time must look like 19:00')
  e.stop = input.stop ? String(input.stop) : ''
  if (e.stop && !HHMM.test(e.stop)) throw new Error('stop time must look like 22:30')
  if (e.stop === e.start) throw new Error('stop time must differ from the start time')
  if (e.mode === 'once') {
    if (!DATE.test(String(input.date || ''))) throw new Error('choose the date')
    e.date = String(input.date)
    e.days = []
  } else {
    const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    if (!days.length) throw new Error('choose at least one day')
    e.days = days
  }
  e.enabled = input.enabled !== false
  if (!e.label) e.label = `${e.streamName || e.sid} ${e.start}${e.stop ? '-' + e.stop : ''}`
  void tz
  return e
}

function openSchedules(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'schedules.json')
  let data = { seq: 0, items: {} }
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { /* first run */ }
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(data)); fs.renameSync(t, file) }
  return {
    list: () => Object.values(data.items).sort((a, b) => a.id - b.id),
    get: id => data.items[id] || null,
    add(e) { const id = ++data.seq; data.items[id] = { ...e, id, fired: {}, createdAt: Date.now() }; save(); return data.items[id] },
    update(id, e) {
      const old = data.items[id]; if (!old) return null
      // Changing when it runs forgets what was already sent, otherwise an edited time could never fire today.
      const moved = ['start', 'stop', 'mode', 'date', 'host', 'sid'].some(k => old[k] !== e[k]) || JSON.stringify(old.days) !== JSON.stringify(e.days)
      data.items[id] = { ...old, ...e, id, fired: moved ? {} : old.fired }
      save(); return data.items[id]
    },
    remove(id) { const had = !!data.items[id]; delete data.items[id]; if (had) save(); return had },
    markFired(id, key, at) {
      const e = data.items[id]; if (!e) return
      e.fired = e.fired || {}; e.fired[key] = at
      const cut = at - 4 * 86400000
      for (const k of Object.keys(e.fired)) if (e.fired[k] < cut) delete e.fired[k]
      save()
    },
  }
}

module.exports = { openSchedules, due, nextRun, occurrences, clean, validTz, zonedToTs, parts, GRACE_MS }
