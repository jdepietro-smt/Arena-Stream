'use strict'
// Thumbnails for the admin page: one ffmpeg per stream reads the SRT relay and writes a small JPEG
// every few seconds. It decodes key frames only, so it costs very little CPU, and it runs only while
// someone has asked for the picture in the last `idleMs`.
const fs = require('node:fs')
const path = require('node:path')
const { spawn: realSpawn } = require('node:child_process')

function createThumbs({ ffmpeg = 'ffmpeg', dir, relaySrt, latencyMs = 150, everySec = 3, idleMs = 25000, maxWorkers = 4, spawn = realSpawn, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true })
  const val = v => (typeof v === 'function' ? v() : v)   // latency and interval may follow a setting
  const workers = new Map()   // relay name -> { proc, file, wantedAt, restart }

  const fileFor = name => path.join(dir, String(name).replace(/[^A-Za-z0-9_.-]/g, '_') + '.jpg')

  function args(name, file) {
    return ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-probesize', '1000000', '-analyzeduration', '500000', '-skip_frame', 'nokey',
      '-i', `srt://${relaySrt}?streamid=read:${name}&mode=caller&latency=${val(latencyMs)}`,
      '-an', '-vf', `scale=480:-2:flags=area,fps=1/${val(everySec)}`, '-q:v', '6',
      '-f', 'image2', '-update', '1', '-atomic_writing', '1', '-y', file]
  }

  function launch(w, name) {
    if (w.proc || !workers.has(name)) return
    const proc = spawn(ffmpeg, args(name, w.file), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    w.proc = proc
    let err = ''
    proc.stderr?.on('data', d => { err = (err + d).slice(-300) })
    proc.on('error', e => { log(`thumbnail ffmpeg failed to start: ${e.message}`); w.proc = null })
    proc.on('close', () => {
      if (w.proc !== proc) return
      w.proc = null
      if (workers.get(name) === w && Date.now() - w.wantedAt < idleMs) {
        w.restart = setTimeout(() => { w.restart = null; launch(w, name) }, 3000)   // stream not up yet, or it dropped: try again
        w.restart.unref?.()
      } else if (err) log(`thumbnail ${name}: ${err.trim()}`)
    })
  }

  function stop(name) {
    const w = workers.get(name)
    if (!w) return
    workers.delete(name)
    if (w.restart) clearTimeout(w.restart)
    const p = w.proc; w.proc = null
    if (p) try { p.kill() } catch { /* already gone */ }
    try { fs.unlinkSync(w.file) } catch { /* none written */ }
  }

  const sweep = setInterval(() => {
    for (const [name, w] of [...workers]) if (Date.now() - w.wantedAt > idleMs) stop(name)
  }, 5000)
  sweep.unref?.()

  return {
    // The admin page asked for this stream's picture: make sure it is being produced.
    want(name) {
      let w = workers.get(name)
      if (!w) {
        if (workers.size >= maxWorkers) return null
        w = { proc: null, file: fileFor(name), wantedAt: 0, restart: null }
        workers.set(name, w)
      }
      w.wantedAt = Date.now()
      launch(w, name)
      return w.file
    },
    // The newest picture, or null if there is none yet (or it is stale).
    read(name, maxAgeMs = 30000) {
      const w = workers.get(name)
      if (!w) return null
      try {
        const st = fs.statSync(w.file)
        if (Date.now() - st.mtimeMs > maxAgeMs) return null
        return fs.readFileSync(w.file)
      } catch { return null }
    },
    active: () => workers.size,
    stopAll() { clearInterval(sweep); for (const n of [...workers.keys()]) stop(n) },
  }
}

module.exports = { createThumbs }
