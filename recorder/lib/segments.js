'use strict'
// How recordings are stored. Each recorded stream is a folder of 10-second MPEG-TS pieces named by their start time in UTC
// (20261122T154000.ts). Everything else (coverage for the timeline, cutting a clip, deleting old pieces) works from those names,
// so nothing has to be kept in a database and a crash can never leave an index out of step with the files.
const fs = require('node:fs')

const SEG_SECONDS = 10
const SEG_MS = SEG_SECONDS * 1000
const SEG_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.ts$/

const pad = (n, w = 2) => String(n).padStart(w, '0')
function segName(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.ts`
}
function parseSeg(name) {
  const m = SEG_RE.exec(name)
  if (!m) return null
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  // Date.UTC rolls an impossible date (month 13) over instead of failing, so check it came back the same.
  return Number.isFinite(ms) && segName(ms) === name ? ms : null
}
// A folder name that is safe on any file system, from the stream's real name ("Rangers - MSG" -> "Rangers-MSG").
const dirNameFor = name => String(name).replace(/[^A-Za-z0-9_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'stream'

function listSegments(dir) {
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const f of names) { const ms = parseSeg(f); if (ms !== null) out.push({ ms, file: f }) }
  return out.sort((a, b) => a.ms - b.ms)
}

// Stretches of time that were recorded, as [{ start, end }] in ms, inside [from, to]. Pieces that follow on from each other
// (allowing for one missing piece) run together into one stretch; a stream that went away shows as a gap.
function coverage(segs, from, to, joinMs = SEG_MS * 0.6) {
  const out = []
  for (const s of segs) {
    const start = s.ms, end = s.ms + SEG_MS
    if (end <= from || start >= to) continue
    const last = out[out.length - 1]
    if (last && start - last.end <= joinMs) last.end = end
    else out.push({ start, end })
  }
  if (out.length) { out[0].start = Math.max(out[0].start, from); out[out.length - 1].end = Math.min(out[out.length - 1].end, to) }
  return out
}

// The pieces that make up [inMs, outMs): all that overlap it, plus how far into the first one the cut begins.
function pieceFor(segs, inMs, outMs) {
  const files = segs.filter(s => s.ms + SEG_MS > inMs && s.ms < outMs)
  if (!files.length) return null
  return { files, offsetSec: Math.max(0, (inMs - files[0].ms) / 1000), durationSec: (outMs - inMs) / 1000 }
}

// What to delete: everything older than the keep time.
const expired = (segs, now, keepMs) => segs.filter(s => s.ms + SEG_MS < now - keepMs)

// Disk guard: the oldest pieces across ALL streams, oldest first, until `needBytes` would be freed. Each entry knows its stream.
function oldestFirst(byStream, needBytes) {
  const all = []
  for (const [stream, segs] of Object.entries(byStream)) for (const s of segs) all.push({ ...s, stream })
  all.sort((a, b) => a.ms - b.ms)
  const out = []
  let freed = 0
  for (const s of all) { if (freed >= needBytes) break; out.push(s); freed += s.size || 0 }
  return { pieces: out, freed }
}

module.exports = { SEG_SECONDS, SEG_MS, segName, parseSeg, dirNameFor, listSegments, coverage, pieceFor, expired, oldestFirst }
