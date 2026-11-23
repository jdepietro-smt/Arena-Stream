'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawnSync } = require('node:child_process')
const { createDaemon } = require('../recorderd')
const S = require('../lib/segments')

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0
const T0 = Date.UTC(2026, 10, 22, 15, 40, 0)

async function rig({ now = () => Date.now(), disk = async () => ({ total: 1000e9, free: 800e9 }), encoders = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recd-'))
  const procs = []
  const spawn = (bin, args) => { const p = new EventEmitter(); p.stderr = new EventEmitter(); p.args = args; p.kill = () => setImmediate(() => p.emit('close')); procs.push(p); return p }
  const cfg = { port: 0, dir: path.join(root, 'rec'), data: path.join(root, 'data'), directoryUrl: '', key: 'k', relaySrt: '127.0.0.1:8895', token: 'tok', ffmpeg: 'ffmpeg' }
  const d = createDaemon(cfg, { now, diskInfo: disk, spawn, encoders: async () => encoders, log: () => {} })
  await new Promise(r => d.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${d.server.address().port}`
  const call = async (p, { method = 'GET', body, token = 'tok', headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(token ? { 'X-Rec-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
    const ct = r.headers.get('content-type') || ''
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }
  }
  const put = (name, ms, size = 1000) => { const dir = path.join(cfg.dir, S.dirNameFor(name)); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name })); fs.writeFileSync(path.join(dir, S.segName(ms)), Buffer.alloc(size, 1)) }
  return { d, cfg, procs, call, put, close: () => { d.stop(); d.server.close() } }
}
const ENC = (name, kbps = 8000) => ({ id: name, name, kbps, relay: { host: 'h', port: 8895, name: name.replace(/[^A-Za-z0-9]+/g, '-') } })

test('every request needs the token', async () => {
  const r = await rig()
  try {
    assert.equal((await r.call('/status', { token: null })).status, 401)
    assert.equal((await r.call('/status', { token: 'wrong' })).status, 401)
    assert.equal((await r.call('/status')).status, 200)
  } finally { r.close() }
})

test('choosing streams starts recording the ones on air, is remembered, and is checked', async () => {
  const r = await rig({ encoders: [ENC('Rangers - MSG'), ENC('Devils')] })
  try {
    assert.equal((await r.call('/config', { method: 'PUT', body: { streams: 'x' } })).status, 400)
    assert.equal((await r.call('/config', { method: 'PUT', body: { streams: [''] } })).status, 400)
    const a = (await r.call('/config', { method: 'PUT', body: { streams: ['Rangers - MSG', 'Bruins'], keepDays: 7 } })).body
    assert.equal(r.procs.length, 1)                                                                      // Bruins is chosen but not on air; Devils is not chosen
    const by = Object.fromEntries(a.streams.map(s => [s.name, s]))
    assert.deepEqual([by['Rangers - MSG'].selected, by['Rangers - MSG'].live], [true, true])
    assert.equal(by['Bruins'].state, 'waiting')
    assert.deepEqual([by['Devils'].selected, by['Devils'].live, by['Devils'].state], [false, true, 'not recording'])   // on air but not chosen: listed, so it can be ticked
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.cfg.data, 'config.json'), 'utf8')).streams.length, 2)
    assert.equal((await r.call('/config', { method: 'PUT', body: { keepDays: 999 } })).body.keepDays, 30)  // limited
    assert.equal((await r.call('/config', { method: 'PUT', body: { keepDays: 0 } })).body.keepDays, 1)
    await r.call('/config', { method: 'PUT', body: { streams: [] } })
    assert.equal(r.procs[0].args.length > 0, true)
  } finally { r.close() }
})

test('status lists recorded streams that are no longer chosen, with their size and span, and what the chosen ones need', async () => {
  const r = await rig({ encoders: [ENC('A', 10000)] })
  try {
    r.put('Old game', T0, 5000); r.put('Old game', T0 + 10000, 5000)
    await r.d.janitor()
    const s = (await r.call('/config', { method: 'PUT', body: { streams: ['A'] } })).body
    const old = s.streams.find(x => x.name === 'Old game')
    assert.deepEqual([old.selected, old.state, old.pieces, old.bytes, old.first, old.last], [false, 'not recording', 2, 10000, T0, T0 + 20000])
    assert.ok(s.estimate.bytesPerHour > 4.4e9 && s.estimate.bytesPerHour < 4.6e9)                         // 10 Mbps is about 4.5 GB an hour
    assert.ok(s.estimate.hoursFit > 100)
  } finally { r.close() }
})

test('coverage shows what was recorded and refuses huge windows', async () => {
  const r = await rig()
  try {
    for (const ms of [T0, T0 + 10000, T0 + 20000, T0 + 200000]) r.put('A', ms)
    const c = (await r.call(`/coverage?stream=${encodeURIComponent('A')}&from=${T0 - 1000}&to=${T0 + 300000}`)).body
    assert.deepEqual(c.ranges, [{ start: T0, end: T0 + 30000 }, { start: T0 + 200000, end: T0 + 210000 }])
    assert.deepEqual((await r.call(`/coverage?stream=Nope&from=0&to=1000`)).body.ranges, [])
    assert.equal((await r.call(`/coverage?stream=A&from=0&to=${10 * 86400000}`)).status, 400)
    assert.equal((await r.call(`/coverage?stream=${encodeURIComponent('../..')}&from=0&to=1000`)).body.ranges.length, 0)   // cannot point outside the folder
  } finally { r.close() }
})

test('retention: pieces older than the keep time go, recent ones stay; an unused folder goes too', async () => {
  const now = T0 + 9 * 86400000
  const r = await rig({ now: () => now })
  try {
    r.put('A', T0); r.put('A', T0 + 86400000); r.put('A', now - 3600000); r.put('A', now - 5000)
    await r.call('/config', { method: 'PUT', body: { keepDays: 7 } })
    await r.d.janitor()
    const left = S.listSegments(path.join(r.cfg.dir, 'A')).map(s => s.ms)
    assert.deepEqual(left, [now - 3600000, now - 5000])
    await r.call('/config', { method: 'PUT', body: { keepDays: 1 } })
    await r.d.janitor()
    assert.deepEqual(S.listSegments(path.join(r.cfg.dir, 'A')).map(s => s.ms), [now - 3600000, now - 5000])  // within a day: kept
  } finally { r.close() }
})

test('disk guard: when the volume is nearly full, only as many of the oldest pieces (across all streams) as needed are deleted, and it is reported', async () => {
  const now = T0 + 86400000
  // A 100,000 byte volume with 9,000 free is 9% free: under the 10% line. The guard wants 15% free, so it needs 6,000 more bytes: two pieces.
  const r = await rig({ now: () => now, disk: async () => ({ total: 100000, free: 9000 }) })
  try {
    r.put('A', now - 7200000, 3000); r.put('B', now - 7000000, 3000); r.put('A', now - 100000, 3000); r.put('B', now - 50000, 3000)
    await r.d.janitor()
    const st = await r.d.status()
    assert.deepEqual([st.trimmed.pieces, st.trimmed.bytes], [2, 6000])
    assert.deepEqual(S.listSegments(path.join(r.cfg.dir, 'A')).map(s => s.ms), [now - 100000])           // the oldest of A and of B went; the newest stayed
    assert.deepEqual(S.listSegments(path.join(r.cfg.dir, 'B')).map(s => s.ms), [now - 50000])
  } finally { r.close() }
})

test('nothing is deleted while the disk has room', async () => {
  const now = T0 + 86400000
  const r = await rig({ now: () => now })
  try {
    r.put('A', now - 7200000); r.put('B', now - 100000)
    await r.d.janitor()
    assert.equal((await r.d.status()).trimmed, null)
    assert.equal(S.listSegments(path.join(r.cfg.dir, 'A')).length, 1)
  } finally { r.close() }
})

test('a stream that is being recorded cannot have its recordings deleted; one that is not, can', async () => {
  const r = await rig({ encoders: [ENC('A')] })
  try {
    r.put('A', T0); r.put('Gone', T0)
    await r.call('/config', { method: 'PUT', body: { streams: ['A'] } })
    assert.equal((await r.call('/recording?stream=A', { method: 'DELETE' })).status, 409)
    assert.equal((await r.call('/recording?stream=Gone', { method: 'DELETE' })).status, 200)
    assert.equal(fs.existsSync(path.join(r.cfg.dir, 'Gone')), false)
    assert.equal((await r.call('/recording?stream=Gone', { method: 'DELETE' })).status, 404)
  } finally { r.close() }
})

function makeRecording(root, name) {
  const dir = path.join(root, S.dirNameFor(name))
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name }))
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '35',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', 'aac', '-f', 'segment', '-segment_time', '10', '-segment_format', 'mpegts', '-reset_timestamps', '1', path.join(dir, 'p%03d.ts')])
  assert.equal(r.status, 0, String(r.stderr))
  fs.readdirSync(dir).filter(f => /^p\d+\.ts$/.test(f)).sort().forEach((f, i) => fs.renameSync(path.join(dir, f), path.join(dir, S.segName(T0 + i * 10000))))
}

test('clips: play (preview), save, download, range requests, and delete, over the API', { skip: !HAVE_FFMPEG && 'ffmpeg is not installed' }, async () => {
  const r = await rig()
  try {
    makeRecording(r.cfg.dir, 'Rangers - MSG')
    assert.equal((await r.call('/clip', { method: 'POST', body: { stream: 'Nobody', in: T0, out: T0 + 5000 } })).status, 404)
    assert.match((await r.call('/clip', { method: 'POST', body: { stream: 'Rangers - MSG', in: T0 + 5000, out: T0 + 5000 } })).body.error, /end must be after/)
    assert.match((await r.call('/clip', { method: 'POST', body: { stream: 'Rangers - MSG', in: T0 + 900000, out: T0 + 910000 } })).body.error, /nothing was recorded/)
    const pv = (await r.call('/clip', { method: 'POST', body: { stream: 'Rangers - MSG', in: T0 + 3000, out: T0 + 23000 } })).body.clip
    assert.equal(pv.kind, 'preview')
    const whole = await r.call(`/clip/${pv.id}`)
    assert.equal(whole.status, 200); assert.equal(whole.headers.get('content-type'), 'video/mp4'); assert.equal(whole.body.length, pv.size)
    assert.equal(whole.headers.get('content-disposition'), null)                                       // playing inline, not a download
    const part = await r.call(`/clip/${pv.id}`, { headers: { Range: 'bytes=100-299' } })
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 100-299/${pv.size}`)
    assert.ok(whole.body.subarray(100, 300).equals(part.body))
    assert.equal((await r.call(`/clip/${pv.id}`, { headers: { Range: 'bytes=99999999-' } })).status, 416)

    const kept = (await r.call(`/clip/${pv.id}/keep`, { method: 'POST', body: { name: 'Goal 1' } })).body.clip
    assert.deepEqual([kept.kind, kept.name], ['saved', 'Goal 1'])
    const dl = await r.call(`/clip/${pv.id}?download=1`)
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="Goal-1_20261122-154003Z\.mp4"/)
    assert.equal((await r.call('/clips')).body.clips.length, 1)
    assert.equal((await r.call(`/clip/${pv.id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await r.call(`/clip/${pv.id}`)).status, 404)
    assert.equal((await r.call('/clip/../../etc/passwd')).status, 404)
  } finally { r.close() }
})
