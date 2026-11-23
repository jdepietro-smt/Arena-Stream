'use strict'
// Recording workers. For every stream that someone chose to record and that is on air, one ffmpeg reads it from the relay (the
// way a decoder does) and writes 10-second pieces to disk. The video is copied exactly as it was sent (no re-encoding, so almost no
// CPU); the audio is turned into AAC, because browsers cannot play the Opus the Link apps send.
const fs = require('node:fs')
const path = require('node:path')
const { spawn: realSpawn } = require('node:child_process')
const { SEG_SECONDS, SEG_MS, dirNameFor } = require('./segments')

const RELAY_NAME_OK = /^[A-Za-z0-9_.-]{1,128}$/

function createRecorder({ ffmpeg = 'ffmpeg', relaySrt = '127.0.0.1:8895', root, latencyMs = 300, stallMs = 45000, backoffMs = [2000, 5000, 10000, 30000], spawn = realSpawn, now = Date.now, log = () => {} }) {
  fs.mkdirSync(root, { recursive: true })
  const workers = new Map()          // stream name -> { name, relayName, dir, proc, startedAt, restarts, stalls, timer, wanted, fails }

  const dirOf = name => path.join(root, dirNameFor(name))

  function args(relayName, dir) {
    return ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-fflags', '+genpts+discardcorrupt',
      '-i', `srt://${relaySrt}?streamid=read:${relayName}&mode=caller&latency=${latencyMs * 1000}`,
      '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-f', 'segment', '-segment_time', String(SEG_SECONDS), '-segment_atclocktime', '1', '-segment_format', 'mpegts',
      '-reset_timestamps', '1', '-strftime', '1', path.join(dir, '%Y%m%dT%H%M%S.ts')]
  }

  function newestAgeMs(w) {
    try { return now() - fs.statSync(w.dir).mtimeMs } catch { return Infinity }       // a new piece changes the folder's time
  }

  function launch(w) {
    if (w.proc || !w.wanted) return
    fs.mkdirSync(w.dir, { recursive: true })
    try { fs.writeFileSync(path.join(w.dir, 'meta.json'), JSON.stringify({ name: w.name, relayName: w.relayName })) } catch { /* the pieces matter more */ }
    let proc
    try { proc = spawn(ffmpeg, args(w.relayName, w.dir), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, TZ: 'UTC' } }) } catch (e) { log(`record ${w.name}: could not start ffmpeg: ${e.message}`); w.fails++; schedule(w); return }
    w.proc = proc; w.startedAt = now()
    let err = ''
    proc.stderr?.on('data', d => { err = (err + d).slice(-400) })
    proc.on('error', e => { log(`record ${w.name}: ffmpeg failed to start: ${e.message}`); if (w.proc === proc) { w.proc = null; w.fails++; schedule(w) } })
    proc.on('close', () => {
      if (w.proc !== proc) return
      w.proc = null
      const ranFor = now() - w.startedAt
      w.fails = ranFor > 60000 ? 0 : w.fails + 1                     // a long run that ended is not a failure to start
      if (err.trim() && ranFor < 20000) log(`record ${w.name}: ${err.trim().split('\n').pop()}`)
      schedule(w)
    })
    log(`record ${w.name}: started`)
  }

  function schedule(w) {
    if (!w.wanted || w.timer) return
    const wait = backoffMs[Math.min(w.fails, backoffMs.length - 1)]
    w.restarts++
    w.timer = setTimeout(() => { w.timer = null; launch(w) }, w.fails ? wait : Math.min(backoffMs[0], 1000))
    w.timer.unref?.()
  }

  function stop(name) {
    const w = workers.get(name)
    if (!w) return
    w.wanted = false
    workers.delete(name)
    if (w.timer) clearTimeout(w.timer)
    const p = w.proc; w.proc = null
    if (p) { try { p.kill('SIGINT') } catch { /* gone */ } setTimeout(() => { try { p.kill() } catch { /* gone */ } }, 3000).unref?.() }   // SIGINT lets ffmpeg finish the last piece
    log(`record ${name}: stopped`)
  }

  return {
    dirOf, args,
    // selected: Set of stream names to record. live: [{ name, relayName }] streams on air with a relay.
    reconcile(selected, live) {
      const liveBy = new Map(live.filter(e => e.relayName && RELAY_NAME_OK.test(e.relayName)).map(e => [e.name, e]))
      for (const name of [...workers.keys()]) if (!selected.has(name) || !liveBy.has(name)) stop(name)
      for (const name of selected) {
        const e = liveBy.get(name)
        if (!e) continue
        let w = workers.get(name)
        if (!w) { w = { name, relayName: e.relayName, dir: dirOf(name), proc: null, startedAt: 0, restarts: 0, stalls: 0, timer: null, wanted: true, fails: 0 }; workers.set(name, w) }
        else if (w.relayName !== e.relayName) { w.relayName = e.relayName; if (w.proc) try { w.proc.kill() } catch { /* gone */ } }   // renamed on the relay: reconnect
        if (!w.proc && !w.timer) launch(w)
      }
    },
    // Called every few seconds: an ffmpeg that is running but has written nothing for a while is stuck, so it is restarted.
    watchdog() {
      for (const w of workers.values()) {
        if (!w.proc) continue
        const since = now() - w.startedAt
        if (since > stallMs && newestAgeMs(w) > stallMs) { w.stalls++; log(`record ${w.name}: nothing written for ${Math.round(newestAgeMs(w) / 1000)} s, restarting`); try { w.proc.kill() } catch { /* gone */ } }
      }
    },
    // One entry per name asked about.
    status(names) {
      return names.map(name => {
        const w = workers.get(name)
        if (!w) return { name, state: 'waiting' }
        const age = newestAgeMs(w)
        const state = !w.proc ? 'starting' : (now() - w.startedAt < SEG_MS * 2.5 && age > SEG_MS * 2.5) ? 'starting' : age > Math.min(stallMs, SEG_MS * 3.5) ? 'stalled' : 'recording'
        return { name, state, since: w.startedAt, lastPieceAgeMs: Number.isFinite(age) ? age : null, restarts: w.restarts, stalls: w.stalls }
      })
    },
    stopAll() { for (const n of [...workers.keys()]) stop(n) },
    has: name => workers.has(name),
  }
}

module.exports = { createRecorder }
