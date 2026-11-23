'use strict'
// Clips: the part of a recording between an in point and an out point, as one MP4 that plays in any browser and can be downloaded.
// The pieces that cover the time are joined and the video is copied (no re-encoding), so a clip is made in seconds and is not
// degraded; the cost is that the picture starts at the nearest keyframe, which for these streams is within a second or two.
//
// Two kinds: "preview" (what the Play button shows; thrown away after an hour) and "saved" (an export someone asked for; kept 30 days).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn: realSpawn } = require('node:child_process')
const { pieceFor } = require('./segments')

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

function createClips({ ffmpeg = 'ffmpeg', dir, spawn = realSpawn, now = Date.now, maxPreviewSec = 600, maxSavedSec = 7200, previewKeepMs = HOUR, savedKeepMs = 30 * DAY, maxJobs = 2, timeoutMs = 15 * 60 * 1000, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true })
  const metaFile = path.join(dir, 'clips.json')
  let clips = []
  try { clips = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch { /* first run */ }
  const save = () => { const t = metaFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(clips)); fs.renameSync(t, metaFile) }
  const fileOf = c => path.join(dir, c.file)
  let running = 0
  const waiting = []

  const concatLine = f => `file '${String(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
  function args(listFile, offsetSec, durationSec, out) {
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-ss', String(offsetSec), '-t', String(durationSec), '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', out]
  }

  function run(listFile, offsetSec, durationSec, out) {
    return new Promise((resolve, reject) => {
      let err = ''
      const p = spawn(ffmpeg, args(listFile, offsetSec, durationSec, out), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      const timer = setTimeout(() => { try { p.kill() } catch { /* gone */ } reject(new Error('cutting took too long and was stopped')) }, timeoutMs)
      p.stderr?.on('data', d => { err = (err + d).slice(-500) })
      p.on('error', e => { clearTimeout(timer); reject(new Error('could not run ffmpeg: ' + e.message)) })
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg could not cut that: ' + (err.trim().split('\n').pop() || 'exit ' + code))) })
    })
  }
  const slot = () => new Promise(res => { if (running < maxJobs) { running++; res() } else waiting.push(res) })
  const release = () => { const next = waiting.shift(); if (next) next(); else running-- }

  return {
    args, concatLine,
    list: () => clips.slice().sort((a, b) => b.createdAt - a.createdAt),
    get: id => clips.find(c => c.id === id) || null,
    path: c => fileOf(c),

    // segs: the stream's pieces ([{ ms, file }]); segDir: where they are. Resolves the clip entry.
    async create({ stream, segs, segDir, inMs, outMs, name, kind = 'preview' }) {
      if (!(outMs > inMs)) throw new Error('the end must be after the start')
      const limit = kind === 'saved' ? maxSavedSec : maxPreviewSec
      if ((outMs - inMs) / 1000 > limit) throw new Error(`a ${kind === 'saved' ? 'saved clip' : 'preview'} can be at most ${Math.round(limit / 60)} minutes`)
      if (kind === 'preview') {          // the same preview asked for again is already made
        const hit = clips.find(c => c.kind === 'preview' && c.stream === stream && c.inMs === inMs && c.outMs === outMs && fs.existsSync(fileOf(c)))
        if (hit) return hit
      }
      const plan = pieceFor(segs, inMs, outMs)
      if (!plan) throw new Error('nothing was recorded in that time')
      const id = crypto.randomBytes(8).toString('hex')
      const file = id + '.mp4', list = path.join(dir, id + '.txt')
      fs.writeFileSync(list, plan.files.map(f => concatLine(path.join(segDir, f.file))).join('\n') + '\n')
      await slot()
      try { await run(list, plan.offsetSec, plan.durationSec, path.join(dir, file)) }
      catch (e) { try { fs.rmSync(path.join(dir, file), { force: true }) } catch { /* none */ } throw e }
      finally { release(); try { fs.rmSync(list, { force: true }) } catch { /* gone */ } }
      const size = fs.existsSync(path.join(dir, file)) ? fs.statSync(path.join(dir, file)).size : 0
      if (size < 1000) { try { fs.rmSync(path.join(dir, file), { force: true }) } catch { /* none */ } throw new Error('the cut came out empty') }
      const entry = { id, stream, name: String(name || '').slice(0, 80), kind, inMs, outMs, durationSec: Math.round((outMs - inMs) / 1000), size, createdAt: now(), file }
      clips.push(entry); save()
      return entry
    },
    remove(id) {
      const c = clips.find(x => x.id === id)
      if (!c) return false
      try { fs.rmSync(fileOf(c), { force: true }) } catch { /* gone */ }
      clips = clips.filter(x => x.id !== id); save()
      return true
    },
    // A preview can be turned into a saved clip without cutting it again.
    keep(id, name) {
      const c = clips.find(x => x.id === id)
      if (!c) return null
      c.kind = 'saved'; c.name = String(name || c.name || '').slice(0, 80); c.createdAt = now(); save()
      return c
    },
    sweep() {
      const t = now()
      const old = clips.filter(c => t - c.createdAt > (c.kind === 'saved' ? savedKeepMs : previewKeepMs))
      for (const c of old) { try { fs.rmSync(fileOf(c), { force: true }) } catch { /* gone */ } }
      if (old.length) { clips = clips.filter(c => !old.includes(c)); save() }
      // files with no record (a crash mid-cut)
      try { for (const f of fs.readdirSync(dir)) if (f !== 'clips.json' && !clips.some(c => c.file === f)) fs.rmSync(path.join(dir, f), { force: true }) } catch { /* nothing */ }
      return old.length
    },
  }
}

module.exports = { createClips }
