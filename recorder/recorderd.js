'use strict'
// Arena recorder: records the streams someone chose, keeps them for a set number of days, and cuts clips. Runs as its own service
// (so restarting the portal never interrupts a recording) and is driven by the portal over a localhost-only HTTP API.
// Standard library only (Node 18+); needs ffmpeg with SRT.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { createRecorder } = require('./lib/recorder')
const { createClips } = require('./lib/clips')
const S = require('./lib/segments')

const DAY = 86400000
const clean = (v, def, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def }

function loadConfig(env = process.env) {
  return {
    port: parseInt(env.REC_PORT || '8920', 10),
    dir: env.REC_DIR || '/var/recordings/arena',
    data: env.REC_DATA || '/var/lib/arena-recorder',
    directoryUrl: env.DIRECTORY_URL || 'http://127.0.0.1:8002',          // may be "main,backup"
    key: env.LINK_KEY || '',
    relaySrt: env.RELAY_SRT || '127.0.0.1:8895',
    token: env.REC_TOKEN || '',
    ffmpeg: env.REC_FFMPEG || 'ffmpeg',
  }
}

// total / free bytes of the volume the recordings are on.
function diskInfo(dir) {
  return new Promise(resolve => {
    try { if (fs.statfsSync) { const s = fs.statfsSync(dir); return resolve({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }) } } catch { /* fall through to df */ }
    execFile('df', ['-P', '-B1', dir], { timeout: 3000 }, (err, out) => {
      const f = !err && String(out).trim().split('\n')[1]?.split(/\s+/)
      resolve(f ? { total: Number(f[1]), free: Number(f[3]) } : { total: 0, free: 0 })
    })
  })
}

function createDaemon(cfg, deps = {}) {
  fs.mkdirSync(cfg.dir, { recursive: true }); fs.mkdirSync(cfg.data, { recursive: true })
  const now = deps.now || Date.now
  const log = deps.log || (m => console.log(m))
  const disk = deps.diskInfo || diskInfo
  const recorder = createRecorder({ ffmpeg: cfg.ffmpeg, relaySrt: cfg.relaySrt, root: cfg.dir, spawn: deps.spawn, now, log, ...(deps.recorderOpts || {}) })
  const clips = createClips({ ffmpeg: cfg.ffmpeg, dir: path.join(cfg.data, 'clips'), spawn: deps.clipSpawn, now, log, ...(deps.clipOpts || {}) })

  const confFile = path.join(cfg.data, 'config.json')
  let conf = { streams: [], keepDays: 7, minFreePct: 10 }
  try { conf = { ...conf, ...JSON.parse(fs.readFileSync(confFile, 'utf8')) } } catch { /* first run */ }
  const saveConf = () => { const t = confFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(conf)); fs.renameSync(t, confFile) }

  let live = []                       // [{ name, relayName, kbps }] on air right now
  let dirOk = false, lastTick = 0
  let trimmed = null                  // { at, bytes, pieces }: the disk guard had to delete recordings early
  let summary = new Map()             // stream folder -> { name, count, bytes, first, last }

  async function fetchEncoders() {
    const urls = String(cfg.directoryUrl).split(',').map(s => s.trim()).filter(Boolean)
    for (const u of urls) {
      try {
        const r = await fetch(u.replace(/\/$/, '') + '/v1/encoders', { headers: { 'X-Arena-Key': cfg.key }, signal: AbortSignal.timeout(3000) })
        if (r.ok) return (await r.json()).encoders || []
      } catch { /* try the next address */ }
    }
    return null
  }

  async function tick() {
    const enc = deps.encoders ? await deps.encoders() : await fetchEncoders()
    dirOk = !!enc
    if (enc) live = enc.map(e => ({ name: e.name, relayName: e.relay && e.relay.name, kbps: e.kbps || 0 }))
    lastTick = now()
    // With the directory unreachable, keep recording what is already being recorded rather than stopping everything.
    if (enc) recorder.reconcile(new Set(conf.streams), live)
    recorder.watchdog()
  }

  const folders = () => { try { return fs.readdirSync(cfg.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return [] } }
  const metaName = f => { try { return JSON.parse(fs.readFileSync(path.join(cfg.dir, f, 'meta.json'), 'utf8')).name } catch { return f } }

  // Deletes what is past the keep time, then (if the volume is nearly full) the oldest of everything, and refreshes the sizes.
  async function janitor() {
    const t = now(), keepMs = conf.keepDays * DAY
    const by = {}
    for (const f of folders()) {
      const dir = path.join(cfg.dir, f)
      const segs = S.listSegments(dir)
      for (const s of S.expired(segs, t, keepMs)) { try { fs.rmSync(path.join(dir, s.file), { force: true }) } catch { /* in use */ } }
      by[f] = S.listSegments(dir)
      await new Promise(r => setImmediate(r))                              // do not hog the loop with a big folder
    }
    const d = await disk(cfg.dir)
    if (d.total && d.free / d.total * 100 < conf.minFreePct) {
      const want = (conf.minFreePct + 5) / 100 * d.total - d.free        // free enough to get back above the limit with some room
      const sized = {}
      for (const [f, segs] of Object.entries(by)) sized[f] = segs.map(s => { try { return { ...s, size: fs.statSync(path.join(cfg.dir, f, s.file)).size } } catch { return { ...s, size: 0 } } })
      const { pieces, freed } = S.oldestFirst(sized, want)
      for (const p of pieces) { try { fs.rmSync(path.join(cfg.dir, p.stream, p.file), { force: true }) } catch { /* gone */ } }
      for (const p of pieces) by[p.stream] = by[p.stream].filter(s => s.file !== p.file)
      if (pieces.length) { trimmed = { at: t, bytes: freed, pieces: pieces.length }; log(`disk almost full: deleted ${pieces.length} of the oldest pieces (${Math.round(freed / 1048576)} MB)`) }
    }
    for (const [f, segs] of Object.entries(by)) {
      if (!segs.length && !recorder.has(metaName(f))) { try { const st = fs.statSync(path.join(cfg.dir, f)); if (t - st.mtimeMs > keepMs) fs.rmSync(path.join(cfg.dir, f), { recursive: true, force: true }) } catch { /* not empty or gone */ } }
    }
    await refreshSummary()
    clips.sweep()
  }

  // Sizes and spans per stream. Counting every piece costs a little, so the page's asking for it is limited to once every 20 seconds.
  let summaryAt = 0
  async function refreshSummary() {
    const next = new Map()
    for (const f of folders()) {
      const segs = S.listSegments(path.join(cfg.dir, f))
      let bytes = 0
      for (const s of segs) { try { bytes += fs.statSync(path.join(cfg.dir, f, s.file)).size } catch { /* gone */ } }
      next.set(f, { name: metaName(f), count: segs.length, bytes, first: segs.length ? segs[0].ms : null, last: segs.length ? segs[segs.length - 1].ms + S.SEG_MS : null })
      await new Promise(r => setImmediate(r))
    }
    summary = next; summaryAt = now()
  }

  async function status() {
    if (now() - summaryAt > 20000) await refreshSummary()
    // Everything on air (so it can be chosen), everything chosen, and everything that has recordings on disk.
    const names = new Set(conf.streams)
    for (const v of summary.values()) names.add(v.name)
    for (const l of live) names.add(l.name)
    const all = [...names].sort((a, b) => a.localeCompare(b))
    const st = new Map(recorder.status(all).map(s => [s.name, s]))
    const liveBy = new Map(live.map(l => [l.name, l]))
    const d = await disk(cfg.dir)
    const streams = all.map(name => {
      const sm = summary.get(S.dirNameFor(name)) || {}
      const w = st.get(name) || { state: 'waiting' }
      const selected = conf.streams.includes(name)
      return { name, selected, live: liveBy.has(name), state: selected ? w.state : 'not recording', since: w.since || null, lastPieceAgeMs: w.lastPieceAgeMs ?? null, restarts: w.restarts || 0, stalls: w.stalls || 0, pieces: sm.count || 0, bytes: sm.bytes || 0, first: sm.first || null, last: sm.last || null, kbps: liveBy.get(name)?.kbps || null }
    })
    // How much a day of the chosen streams needs, so the page can say whether seven days will fit.
    const kbps = streams.filter(s => s.selected).reduce((n, s) => n + (s.kbps || 0), 0)
    const bytesPerHour = kbps * 1000 / 8 * 3600 + streams.filter(s => s.selected).length * 16000 * 3600
    const used = streams.reduce((n, s) => n + s.bytes, 0)
    return {
      ok: true, now: now(), dirOk, lastTickAgeMs: lastTick ? now() - lastTick : null,
      keepDays: conf.keepDays, minFreePct: conf.minFreePct, disk: d, recordingsBytes: used, streams, trimmed,
      estimate: { bytesPerHour, hoursFit: bytesPerHour ? Math.floor(Math.max(0, d.free + used - d.total * conf.minFreePct / 100) / bytesPerHour) : null },
    }
  }

  const resolveDir = name => { const f = S.dirNameFor(name); return fs.existsSync(path.join(cfg.dir, f)) ? path.join(cfg.dir, f) : null }

  // ── HTTP ──────────────────────────────────────────────────────────────────────────────
  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b) }
  const readJson = req => new Promise(resolve => { let b = ''; req.on('data', c => { b += c; if (b.length > 16384) req.destroy() }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve(null) } }); req.on('error', () => resolve(null)) })
  const safeName = (s, d) => String(s || d).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || d

  function serveClip(req, res, c, download) {
    const file = clips.path(c)
    let size
    try { size = fs.statSync(file).size } catch { return send(res, 404, { error: 'that clip has gone' }) }
    let start = 0, end = size - 1, code = 200
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 } else start = Math.max(0, size - Number(m[2]))
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end() }
      code = 206
    }
    const when = new Date(c.inMs).toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
    res.writeHead(code, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store',
      ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      ...(download ? { 'Content-Disposition': `attachment; filename="${safeName(c.name, safeName(c.stream, 'clip'))}_${when}Z.mp4"` } : {}) })
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (cfg.token && req.headers['x-rec-token'] !== cfg.token) return send(res, 401, { error: 'bad token' })
      const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method
      if (p === '/status' && m === 'GET') return send(res, 200, await status())
      if (p === '/config' && m === 'PUT') {
        const b = await readJson(req)
        if (!b) return send(res, 400, { error: 'bad body' })
        if (b.streams !== undefined) {
          if (!Array.isArray(b.streams) || b.streams.length > 64 || b.streams.some(s => typeof s !== 'string' || !s.trim() || s.length > 80)) return send(res, 400, { error: 'streams must be a list of names' })
          conf.streams = [...new Set(b.streams.map(s => s.trim()))]
        }
        if (b.keepDays !== undefined) conf.keepDays = clean(b.keepDays, conf.keepDays, 1, 30)
        if (b.minFreePct !== undefined) conf.minFreePct = clean(b.minFreePct, conf.minFreePct, 5, 40)
        saveConf()
        await tick().catch(() => {})
        return send(res, 200, await status())
      }
      if (p === '/coverage' && m === 'GET') {
        const dir = resolveDir(u.searchParams.get('stream') || '')
        const from = Number(u.searchParams.get('from')), to = Number(u.searchParams.get('to'))
        if (!(to > from) || to - from > 8 * DAY) return send(res, 400, { error: 'ask for at most 8 days at a time' })
        return send(res, 200, { ranges: dir ? S.coverage(S.listSegments(dir), from, to) : [] })
      }
      if (p === '/clips' && m === 'GET') return send(res, 200, { clips: clips.list() })
      if (p === '/clip' && m === 'POST') {
        const b = await readJson(req)
        if (!b || typeof b.stream !== 'string') return send(res, 400, { error: 'bad body' })
        const dir = resolveDir(b.stream)
        if (!dir) return send(res, 404, { error: 'nothing is recorded for that stream' })
        const kind = b.kind === 'saved' ? 'saved' : 'preview'
        try { return send(res, 200, { clip: await clips.create({ stream: b.stream, segs: S.listSegments(dir), segDir: dir, inMs: Number(b.in), outMs: Number(b.out), name: b.name, kind }) }) }
        catch (e) { return send(res, 400, { error: e.message }) }
      }
      let mm
      if ((mm = p.match(/^\/clip\/([0-9a-f]{16})$/))) {
        const c = clips.get(mm[1])
        if (!c) return send(res, 404, { error: 'no such clip' })
        if (m === 'GET') return serveClip(req, res, c, u.searchParams.get('download') === '1')
        if (m === 'DELETE') { clips.remove(c.id); return send(res, 200, { ok: true }) }
      }
      if ((mm = p.match(/^\/clip\/([0-9a-f]{16})\/keep$/)) && m === 'POST') {
        const b = await readJson(req) || {}
        const c = clips.keep(mm[1], b.name)
        return c ? send(res, 200, { clip: c }) : send(res, 404, { error: 'no such clip' })
      }
      if (p === '/recording' && m === 'DELETE') {
        const name = u.searchParams.get('stream') || ''
        if (conf.streams.includes(name) && live.some(l => l.name === name)) return send(res, 409, { error: 'this stream is being recorded right now: stop recording it first' })
        const dir = resolveDir(name)
        if (!dir) return send(res, 404, { error: 'nothing is recorded for that stream' })
        fs.rmSync(dir, { recursive: true, force: true }); summary.delete(S.dirNameFor(name))
        return send(res, 200, { ok: true })
      }
      send(res, 404, { error: 'not found' })
    } catch (e) { log('error ' + req.method + ' ' + req.url + ' ' + (e && e.message)); if (!res.headersSent) send(res, 500, { error: 'server error' }); else res.end() }
  })

  return { server, tick, janitor, status, recorder, clips, get conf() { return conf }, get live() { return live }, stop() { recorder.stopAll() } }
}

module.exports = { createDaemon, loadConfig, diskInfo }

if (require.main === module) {
  const cfg = loadConfig()
  if (!cfg.token) { console.error('REC_TOKEN is not set'); process.exit(1) }
  const d = createDaemon(cfg)
  d.server.listen(cfg.port, '127.0.0.1', () => console.log(`arena recorder on 127.0.0.1:${cfg.port}, recordings in ${cfg.dir}`))
  setInterval(() => { d.tick().catch(e => console.log('tick failed: ' + e.message)) }, 5000)
  setInterval(() => { d.janitor().catch(e => console.log('janitor failed: ' + e.message)) }, 5 * 60 * 1000)
  setTimeout(() => { d.tick().catch(() => {}); d.janitor().catch(() => {}) }, 500)
  const bye = () => { d.stop(); setTimeout(() => process.exit(0), 1500) }
  process.on('SIGTERM', bye); process.on('SIGINT', bye)
}
