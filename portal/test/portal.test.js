'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createPortal } = require('../server')
const { createThumbs } = require('../lib/thumbs')
const auth = require('../lib/auth')

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

async function setup() {
  const calls = { want: [], mtx: [], whep: [], ffmpeg: [], killed: 0 }
  let ffmpegWrites = true
  const addedPaths = new Set()
  let encoders = [
    { id: 'e1', name: 'ESPN 1', format: '1920x1080i@59.94', codec: 'h264_nvenc', kbps: 10000, ageMs: 100, relay: { host: 'h', port: 8895, name: 'ESPN-1' } },
    { id: 'e2', name: 'Cam HEVC', codec: 'hevc_nvenc', kbps: 8000, ageMs: 50, relay: { host: 'h', port: 8895, name: 'Cam-HEVC' } },
    { id: 'e3', name: 'LAN only', codec: 'h264_nvenc', kbps: 5000, ageMs: 50, relay: null },
  ]
  const dirSrv = http.createServer((req, res) => {
    if (req.headers['x-arena-key'] !== 'k') { res.writeHead(401); return res.end('{}') }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/v1/encoders') return res.end(JSON.stringify({ encoders }))
      if (req.url === '/v1/decoders') return res.end(JSON.stringify({ decoders: [{ id: 'pc-1', name: 'Truck', state: 'live', stream: 'ESPN 1', want: null }] }))
      if (req.url === '/v1/decoder/want') { calls.want.push(JSON.parse(b)); return res.end(JSON.stringify({ ok: true })) }
      res.writeHead(404); res.end('{}')
    })
  })
  const mtxSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      calls.mtx.push({ m: req.method, u: req.url, b })
      if (req.url.startsWith('/v3/paths/list')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ items: [{ name: 'x', readers: [1, 2] }] })) }
      if (req.url.startsWith('/v3/config/paths/add/')) {
        res.setHeader('Content-Type', 'application/json')
        if (addedPaths.has(req.url)) { res.writeHead(400); return res.end('{"error":"path already exists"}') }
        addedPaths.add(req.url); return res.end('{}')
      }
      if (req.url.startsWith('/v3/config/paths/patch/')) { res.setHeader('Content-Type', 'application/json'); return res.end('{}') }
      res.writeHead(404); res.end()
    })
  })
  const whepSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      calls.whep.push({ m: req.method, u: req.url, b })
      if (req.method === 'POST' && req.url.endsWith('/whep')) { res.writeHead(201, { 'Content-Type': 'application/sdp', Location: req.url + '/' + (b.startsWith('OFFER:') ? b.slice(6) : 'sess-123') }); return res.end('ANSWER-SDP') }
      res.writeHead(204); res.end()
    })
  })
  const [dp, mp, wp] = await Promise.all([listen(dirSrv), listen(mtxSrv), listen(whepSrv)])
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'))
  // A stand-in for ffmpeg: records how it was started and writes a picture where it was told to.
  const fakeSpawn = (bin, args) => {
    const p = new EventEmitter(); p.stderr = new EventEmitter()
    p.kill = () => { calls.killed++; p.emit('close') }
    calls.ffmpeg.push({ bin, args })
    if (ffmpegWrites) setTimeout(() => fs.writeFileSync(args[args.length - 1], Buffer.from('JPEGDATA')), 20)
    return p
  }
  // Stand-ins for systemctl and df.
  const fakeExec = (cmd, args, opts, cb) => {
    if (cmd === 'systemctl') {
      const n = args[1].replace('.service', '')
      if (n === 'arena-comms') return cb(null, 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\n')
      return cb(null, 'LoadState=loaded\nActiveState=' + (n === 'mediamtx' ? 'failed' : 'active') + '\nSubState=running\nActiveEnterTimestamp=Mon 2026-11-09 10:00:00 UTC\n')
    }
    if (cmd === 'df') return cb(null, 'Filesystem 1-blocks Used Available Capacity Mounted\n/dev/sda1 1000 400 600 40% ' + args[2] + '\n')
    cb(new Error('unexpected'))
  }
  const ctlDir = path.join(dataDir, 'ctl')
  const { server, store, pathName, thumbs, admin } = createPortal({
    ownerInit: 'ownerpass1234', execFile: fakeExec, ctlDir,
    spawn: fakeSpawn, ffmpeg: 'ffmpeg-test', thumbDir: path.join(dataDir, 'thumbs'),
    port: 0, adminPassword: 'adminpw', secret: 'a'.repeat(32), directoryUrl: `http://127.0.0.1:${dp}`, directoryKey: 'k',
    mediamtxApi: `http://127.0.0.1:${mp}`, mediamtxWebrtc: `http://127.0.0.1:${wp}`, relaySrt: '127.0.0.1:8895', relayLatencyMs: 150, dataDir,
  })
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  let jar = {}   // cookie name -> value, like a browser
  const call = async (p, { method = 'GET', body, headers = {}, raw = false, useCookie = true } = {}) => {
    const cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ')
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(useCookie && cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    })
    if (useCookie) for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=')
      if (c.includes('Max-Age=0')) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1)
    }
    const ct = r.headers.get('content-type') || ''
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() }
  }
  const close = async () => { store.flush(); for (const s of [server, dirSrv, mtxSrv, whepSrv]) s.close() }
  return { call, calls, close, thumbs, admin, ctlDir, secret: 'a'.repeat(32), setEncoders: e => { encoders = e }, pathName, store, resetCookie: () => { jar = {} }, jar: () => jar, base, dataDir }
}

test('admin api needs a login; wrong password is refused', async () => {
  const t = await setup()
  try {
    assert.equal((await t.call('/portal/api/streams')).status, 401)
    assert.equal((await t.call('/portal/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401)
    assert.equal((await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })).status, 200)
    assert.equal((await t.call('/portal/api/me')).status, 200)
    const plain = await t.call('/portal/', { headers: { 'X-Forwarded-Proto': 'http' }, useCookie: false })
    assert.equal(plain.status, 301); assert.match(plain.headers.get('location'), /^https:\/\/127\.0\.0\.1:\d+\/portal\/$/)   // admin never over plain http
    assert.equal((await t.call('/w/zzzzzzzzzz', { headers: { 'X-Forwarded-Proto': 'http' }, useCookie: false })).status, 410)   // viewer links work over http
    assert.equal((await t.call('/portal/api/logout', { method: 'POST' })).status, 200)
  } finally { await t.close() }
})

test('login is throttled after repeated failures', async () => {
  const t = await setup()
  try {
    let last
    for (let i = 0; i < 10; i++) last = await t.call('/portal/api/login', { method: 'POST', body: { password: 'bad' + i }, useCookie: false })
    assert.equal(last.status, 429)
  } finally { await t.close() }
})

test('streams list shows relay and browser capability and web viewers', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    const { body } = await t.call('/portal/api/streams')
    const by = n => body.streams.find(s => s.name === n)
    assert.equal(by('ESPN 1').canShare, true); assert.equal(by('ESPN 1').browserOk, true)
    assert.equal(by('Cam HEVC').browserOk, false)
    assert.equal(by('LAN only').canShare, false)
  } finally { await t.close() }
})

test('link lifecycle: create, view page, whep, revoke', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    const c = await t.call('/portal/api/links', { method: 'POST', body: { stream: 'ESPN 1', label: 'Client', expiresInMin: 60 } })
    assert.equal(c.status, 200)
    const id = c.body.link.id
    t.resetCookie()   // a viewer has no admin cookie
    const page = await t.call(`/w/${id}`, { useCookie: false })
    assert.equal(page.status, 200); assert.match(page.body, /RTCPeerConnection/); assert.match(page.body, new RegExp(`'${id}'`))
    assert.deepEqual((await t.call(`/w/${id}/state`, { useCookie: false })).body.state, 'live')

    const w = await t.call(`/w/${id}/whep`, { method: 'POST', raw: true, body: 'OFFER-SDP', headers: { 'Content-Type': 'application/sdp' }, useCookie: false })
    assert.equal(w.status, 201); assert.equal(w.body, 'ANSWER-SDP'); assert.equal(w.headers.get('location'), `/w/${id}/whep/sess-123`)
    const add = t.calls.mtx.find(x => x.u.startsWith('/v3/config/paths/add/'))
    assert.ok(add, 'path created in mediamtx')
    assert.match(add.u, /portal_ESPN-1_[0-9a-f]{10}$/)
    assert.match(JSON.parse(add.b).source, /^srt:\/\/127\.0\.0\.1:8895\?streamid=read:ESPN-1&mode=caller&latency=150$/)
    assert.equal(t.calls.whep[0].b, 'OFFER-SDP')
    assert.equal((await t.call(`/w/${id}/whep/sess-123`, { method: 'DELETE', useCookie: false })).status, 204)

    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    const list = await t.call('/portal/api/links')
    assert.equal(list.body.links[0].views, 1)
    assert.equal((await t.call(`/portal/api/links/${id}`, { method: 'DELETE' })).body.link.state, 'revoked')
    t.resetCookie()
    assert.equal((await t.call(`/w/${id}`, { useCookie: false })).status, 410)
    assert.equal((await t.call(`/w/${id}/whep`, { method: 'POST', raw: true, body: 'x', useCookie: false })).status, 410)
  } finally { await t.close() }
})

test('expired links are closed; unknown ids are closed', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    const id = (await t.call('/portal/api/links', { method: 'POST', body: { stream: 'ESPN 1', expiresInMin: 5 } })).body.link.id
    const l = t.store.link(id); l.expiresAt = Date.now() - 1000; t.store.putLink(l)
    t.resetCookie()
    const r = await t.call(`/w/${id}`, { useCookie: false })
    assert.equal(r.status, 410); assert.match(r.body, /expired/)
    assert.equal((await t.call('/w/zzzzzzzzzz', { useCookie: false })).status, 410)
  } finally { await t.close() }
})

test('password-protected link needs the password before anything plays', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    const id = (await t.call('/portal/api/links', { method: 'POST', body: { stream: 'ESPN 1', password: 'sesame' } })).body.link.id
    t.resetCookie()
    const gate = await t.call(`/w/${id}`, { useCookie: false })
    assert.match(gate.body, /Enter the password/)
    assert.equal((await t.call(`/w/${id}/whep`, { method: 'POST', raw: true, body: 'x', useCookie: false })).status, 401)
    assert.equal((await t.call(`/w/${id}/auth`, { method: 'POST', body: { password: 'wrong' }, useCookie: false })).status, 401)
    const ok = await t.call(`/w/${id}/auth`, { method: 'POST', body: { password: 'sesame' } })   // keeps the cookie
    assert.equal(ok.status, 200)
    assert.match((await t.call(`/w/${id}`)).body, /RTCPeerConnection/)
    assert.equal((await t.call(`/w/${id}/whep`, { method: 'POST', raw: true, body: 'OFFER', headers: { 'Content-Type': 'application/sdp' } })).status, 201)
  } finally { await t.close() }
})

test('H.265 and offline streams cannot be opened in a browser', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    const hevc = (await t.call('/portal/api/links', { method: 'POST', body: { stream: 'Cam HEVC' } })).body.link.id
    const gone = (await t.call('/portal/api/links', { method: 'POST', body: { stream: 'Not on air' } })).body.link.id
    t.resetCookie()
    assert.equal((await t.call(`/w/${hevc}/state`, { useCookie: false })).body.state, 'unsupported')
    assert.equal((await t.call(`/w/${hevc}/whep`, { method: 'POST', raw: true, body: 'x', useCookie: false })).status, 415)
    assert.equal((await t.call(`/w/${gone}/state`, { useCookie: false })).body.state, 'offline')
    assert.equal((await t.call(`/w/${gone}/whep`, { method: 'POST', raw: true, body: 'x', useCookie: false })).status, 404)
  } finally { await t.close() }
})

test('decoder control passes through to the directory', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    assert.equal((await t.call('/portal/api/decoders')).body.decoders[0].name, 'Truck')
    assert.equal((await t.call('/portal/api/decoders/pc-1/want', { method: 'POST', body: { stream: 'ESPN 1' } })).status, 200)
    assert.deepEqual(t.calls.want[0], { id: 'pc-1', stream: 'ESPN 1' })
    assert.equal((await t.call('/portal/api/decoders/pc-1/want', { method: 'POST', body: {} })).status, 400)
  } finally { await t.close() }
})

test('state-changing admin calls from another origin are refused', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    const r = await t.call('/portal/api/links', { method: 'POST', body: { stream: 'ESPN 1' }, headers: { Origin: 'https://evil.example' } })
    assert.equal(r.status, 403)
  } finally { await t.close() }
})

test('thumbnails: the picture worker starts on request, serves the picture, and only for streams a browser can show', async () => {
  const t = await setup()
  try {
    assert.equal((await t.call('/portal/api/thumb/e1')).status, 401)
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    assert.equal((await t.call('/portal/api/thumb/e1')).status, 204)            // starts the worker, no picture yet
    assert.equal(t.calls.ffmpeg.length, 1)
    const a = t.calls.ffmpeg[0].args
    assert.equal(t.calls.ffmpeg[0].bin, 'ffmpeg-test')
    assert.ok(a.includes('nokey'), 'decodes key frames only')
    assert.ok(a.some(x => /^srt:\/\/127\.0\.0\.1:8895\?streamid=read:ESPN-1&mode=caller/.test(x)))
    await new Promise(r => setTimeout(r, 80))
    const got = await t.call('/portal/api/thumb/e1')
    assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/jpeg'); assert.equal(got.body, 'JPEGDATA')
    assert.equal(t.calls.ffmpeg.length, 1, 'one worker per stream, not one per request')
    assert.equal((await t.call('/portal/api/thumb/e2')).status, 204)            // H.265
    assert.equal((await t.call('/portal/api/thumb/e3')).status, 204)            // not on the relay
    assert.equal((await t.call('/portal/api/thumb/nope')).status, 204)
    assert.equal(t.calls.ffmpeg.length, 1)
  } finally { await t.close() }
})

test('thumbnail workers stop when nobody asks and when the portal closes', async () => {
  const spawned = []; let killed = 0
  const fake = (bin, args) => { const p = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => { killed++; p.emit('close') }; spawned.push(args); return p }
  const th = createThumbs({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'th-')), relaySrt: 'h:1', idleMs: 40, spawn: fake })
  th.want('A'); th.want('B')
  assert.equal(th.active(), 2)
  await new Promise(r => setTimeout(r, 5200))        // the sweep runs every 5 s
  assert.equal(th.active(), 0); assert.equal(killed, 2)
  th.want('C'); th.stopAll()
  assert.equal(killed, 3)
})

test('admin live preview: sessions are limited and freed', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
    const offer = { method: 'POST', raw: true, body: 'OFFER', headers: { 'Content-Type': 'application/sdp' } }
    const first = await t.call('/portal/api/whep/e1', offer)
    assert.equal(first.status, 201); assert.equal(first.body, 'ANSWER-SDP'); assert.equal(first.headers.get('location'), '/portal/api/whep/e1/sess-123')
    assert.match(t.calls.mtx.find(x => x.u.startsWith('/v3/config/paths/add/')).u, /portal_ESPN-1_/)
    assert.equal((await t.call('/portal/api/whep/e1', offer)).status, 201)   // same fake session id, still counted once
    assert.equal((await t.call('/portal/api/whep/e2', offer)).status, 415)   // H.265
    assert.equal((await t.call('/portal/api/whep/e3', offer)).status, 409)   // not on the relay
    assert.equal((await t.call('/portal/api/whep/zzz', offer)).status, 404)
    assert.equal((await t.call('/portal/api/whep/e1/sess-123', { method: 'DELETE' })).status, 204)
    const mk = id => ({ method: 'POST', raw: true, body: 'OFFER:' + id, headers: { 'Content-Type': 'application/sdp' } })
    assert.equal((await t.call('/portal/api/whep/e1', mk('a'))).status, 201)
    assert.equal((await t.call('/portal/api/whep/e1', mk('b'))).status, 201)
    assert.equal((await t.call('/portal/api/whep/e1', mk('c'))).status, 201)
    assert.equal((await t.call('/portal/api/whep/e1', mk('d'))).status, 429)   // three at a time
    assert.equal((await t.call('/portal/api/whep/e1/a', { method: 'DELETE' })).status, 204)
    assert.equal((await t.call('/portal/api/whep/e1', mk('d'))).status, 201)   // a slot is free again
    t.resetCookie()
    assert.equal((await t.call('/portal/api/whep/e1', offer)).status, 401)   // admin only
  } finally { await t.close() }
})

// ── owner (Admin) section ─────────────────────────────────────────────────────
const adminLogin = t => t.call('/portal/api/login', { method: 'POST', body: { password: 'adminpw' } })
const ownerLogin = (t, pw = 'ownerpass1234') => t.call('/portal/api/owner/login', { method: 'POST', body: { password: pw } })
const post = (t, p, body) => t.call(p, { method: 'POST', body })

test('owner section is locked until the owner password is given', async () => {
  const t = await setup()
  try {
    assert.equal((await t.call('/portal/api/owner/status')).status, 401)          // not even signed in
    await adminLogin(t)
    const st = (await t.call('/portal/api/owner/status')).body
    assert.deepEqual([st.configured, st.unlocked], [true, false])
    assert.equal((await t.call('/portal/api/owner/settings')).status, 403)
    assert.equal((await t.call('/portal/api/owner/health')).status, 403)
    assert.equal((await ownerLogin(t, 'adminpw')).status, 401)                     // the day-to-day password is not the owner password
    assert.equal((await ownerLogin(t)).status, 200)
    assert.equal((await t.call('/portal/api/owner/status')).body.unlocked, true)
    assert.equal((await t.call('/portal/api/owner/settings')).status, 200)
    await post(t, '/portal/api/owner/logout')
    assert.equal((await t.call('/portal/api/owner/settings')).status, 403)
    assert.ok(t.admin.ownerPwHash.startsWith('s1$'), 'stored hashed, never as plain text')
  } finally { await t.close() }
})

test('owner unlock expires after 15 minutes and does not survive a sign-out-everywhere', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    const old = auth.sign('owner|' + (Date.now() - 1000) + '|' + t.admin.epoch, t.secret)
    t.jar().arena_owner = encodeURIComponent(old)
    assert.equal((await t.call('/portal/api/owner/settings')).status, 403)         // expired cookie
    await ownerLogin(t)
    assert.equal((await post(t, '/portal/api/owner/signout-all')).status, 200)
    assert.equal((await t.call('/portal/api/owner/settings')).status, 401)         // the admin session is gone too
    await adminLogin(t)
    assert.equal((await t.call('/portal/api/owner/settings')).status, 403)         // and the owner unlock did not come back
  } finally { await t.close() }
})

test('owner login is throttled', async () => {
  const t = await setup()
  try {
    await adminLogin(t)
    let last
    for (let i = 0; i < 7; i++) last = await ownerLogin(t, 'wrong' + i)
    assert.equal(last.status, 429)
  } finally { await t.close() }
})

test('settings: bad values change nothing; good ones take effect', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    assert.equal((await post(t, '/portal/api/owner/settings', { settings: { maxPreviews: 99 } })).status, 400)
    assert.equal((await post(t, '/portal/api/owner/settings', { settings: { publicBase: 'javascript:x', maxPreviews: 2 } })).status, 400)
    assert.equal((await post(t, '/portal/api/owner/settings', { settings: { nope: 1 } })).status, 400)
    assert.equal((await t.call('/portal/api/owner/settings')).body.settings.maxPreviews, 3, 'a rejected request changes nothing')

    const r = await post(t, '/portal/api/owner/settings', { settings: { publicBase: 'https://stream.example.com/', maxPreviews: 1, defaultLinkExpiryMin: 120, requireLinkPassword: true } })
    assert.equal(r.status, 200)
    const me = (await t.call('/portal/api/me')).body
    assert.equal(me.publicBase, 'https://stream.example.com'); assert.equal(me.defaultExpiryMin, 120); assert.equal(me.requireLinkPassword, true)

    assert.equal((await post(t, '/portal/api/links', { stream: 'ESPN 1' })).status, 400)            // password now required
    const mk = await post(t, '/portal/api/links', { stream: 'ESPN 1', password: 'pw1' })             // no expiry given: the default applies
    assert.equal(mk.status, 200)
    const mins = (mk.body.link.expiresAt - Date.now()) / 60000
    assert.ok(mins > 118 && mins <= 120, 'default expiry of 120 minutes, got ' + mins)

    const offer = id => ({ method: 'POST', raw: true, body: 'OFFER:' + id, headers: { 'Content-Type': 'application/sdp' } })
    assert.equal((await t.call('/portal/api/whep/e1', offer('x1'))).status, 201)
    assert.equal((await t.call('/portal/api/whep/e1', offer('x2'))).status, 429)                     // limit is 1 now
  } finally { await t.close() }
})

test('settings: thumbnails can be switched off, and a new relay latency reaches mediamtx', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    await post(t, '/portal/api/owner/settings', { settings: { thumbnailsEnabled: false } })
    assert.equal((await t.call('/portal/api/thumb/e1')).status, 204)
    assert.equal(t.calls.ffmpeg.length, 0, 'no picture worker while thumbnails are off')

    const offer = { method: 'POST', raw: true, body: 'OFFER', headers: { 'Content-Type': 'application/sdp' } }
    assert.equal((await t.call('/portal/api/whep/e1', offer)).status, 201)
    const add = t.calls.mtx.find(x => x.u.startsWith('/v3/config/paths/add/'))
    assert.ok(JSON.parse(add.b).source.endsWith('latency=150'))
    await post(t, '/portal/api/owner/settings', { settings: { relayLatencyMs: 300 } })
    assert.equal((await t.call('/portal/api/whep/e1/sess-123', { method: 'DELETE' })).status, 204)
    assert.equal((await t.call('/portal/api/whep/e1', offer)).status, 201)
    const patch = t.calls.mtx.find(x => x.m === 'PATCH' && x.u.startsWith('/v3/config/paths/patch/'))
    assert.ok(patch, 'the existing path was updated'); assert.ok(JSON.parse(patch.b).source.endsWith('latency=300'))
  } finally { await t.close() }
})

test('passwords: changing needs the owner password, and signs everyone out', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    assert.equal((await post(t, '/portal/api/owner/password', { which: 'admin', current: 'nope', next: 'a-new-password' })).status, 401)
    assert.equal((await post(t, '/portal/api/owner/password', { which: 'admin', current: 'ownerpass1234', next: 'short' })).status, 400)
    assert.equal((await post(t, '/portal/api/owner/password', { which: 'other', current: 'ownerpass1234', next: 'a-new-password' })).status, 400)
    assert.equal((await post(t, '/portal/api/owner/password', { which: 'admin', current: 'ownerpass1234', next: 'a-new-password' })).status, 200)
    assert.equal((await t.call('/portal/api/streams')).status, 401, 'this browser is signed out')
    assert.equal((await adminLogin(t)).status, 401, 'the old day-to-day password no longer works')
    assert.equal((await post(t, '/portal/api/login', { password: 'a-new-password' })).status, 200)

    await ownerLogin(t)
    assert.equal((await post(t, '/portal/api/owner/password', { which: 'owner', current: 'ownerpass1234', next: 'another-owner-pass' })).status, 200)
    await post(t, '/portal/api/login', { password: 'a-new-password' })
    assert.equal((await ownerLogin(t)).status, 401)
    assert.equal((await ownerLogin(t, 'another-owner-pass')).status, 200)
  } finally { await t.close() }
})

test('health lists the services and the machine; restarts only go to known services', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    const h = (await t.call('/portal/api/owner/health')).body
    const by = n => h.services.find(s => s.name === n)
    assert.equal(by('arena-portal').active, true)
    assert.equal(by('mediamtx').state.startsWith('failed'), true)
    assert.equal(by('arena-comms').installed, false); assert.equal(by('arena-comms').state, 'not installed')
    assert.equal(h.disks[0].total, 1000); assert.equal(h.disks[0].used, 400)
    assert.equal(h.app.directory, true); assert.equal(h.app.encoders, 3); assert.ok(h.system.cpus >= 1)

    assert.equal((await post(t, '/portal/api/owner/services/sshd/restart')).status, 404)
    assert.equal((await post(t, '/portal/api/owner/services/arena-lowlat;reboot/restart')).status, 404)
    assert.equal(fs.existsSync(path.join(t.ctlDir, 'request')), false)
    assert.equal((await post(t, '/portal/api/owner/services/arena-lowlat/restart')).status, 200)
    assert.equal(fs.readFileSync(path.join(t.ctlDir, 'request'), 'utf8'), 'arena-lowlat\n')
  } finally { await t.close() }
})

test('activity log records who did what, and all links show their views', async () => {
  const t = await setup()
  try {
    await t.call('/portal/api/login', { method: 'POST', body: { password: 'wrong' } })
    await adminLogin(t); await ownerLogin(t)
    const id = (await post(t, '/portal/api/links', { stream: 'ESPN 1', label: 'Client', expiresInMin: 60 })).body.link.id
    const w = { method: 'POST', raw: true, body: 'OFFER', headers: { 'Content-Type': 'application/sdp', 'X-Forwarded-For': '203.0.113.9' }, useCookie: false }
    await t.call('/w/' + id + '/whep', w)
    await t.call('/portal/api/links/' + id, { method: 'DELETE' })
    await post(t, '/portal/api/decoders/pc-1/want', { stream: 'ESPN 1' })
    const all = (await t.call('/portal/api/owner/activity')).body.entries
    const actions = all.map(e => e.action)
    for (const a of ['login.fail', 'login', 'owner.login', 'link.create', 'link.view', 'link.revoke', 'decoder.want']) assert.ok(actions.includes(a), 'missing ' + a + ' in ' + actions)
    assert.equal(all.find(e => e.action === 'link.view').ip, '203.0.113.9')
    assert.equal(all.find(e => e.action === 'link.view').who, 'viewer')
    const only = (await t.call('/portal/api/owner/activity?action=link')).body.entries
    assert.ok(only.length >= 3 && only.every(e => e.action.startsWith('link')))
    const links = (await t.call('/portal/api/owner/links')).body.links
    assert.equal(links[0].views, 1); assert.equal(links[0].uniqueViewers, 1); assert.equal(links[0].state, 'revoked'); assert.equal(links[0].recent[0].ip, '203.0.113.9')
  } finally { await t.close() }
})

// ── named accounts ────────────────────────────────────────────────────────────
const signIn = (t, username, password) => t.call('/portal/api/login', { method: 'POST', body: { username, password } })

test('accounts: the owner creates one, and it signs in with its own username and password', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'x', password: 'long-enough-pw' })).status, 400)          // username too short
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'bad name!', password: 'long-enough-pw' })).status, 400)
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'test.user', password: 'short' })).status, 400)           // password too short
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'test.user', password: 'test-Passw0rd!' })).status, 200)
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'TEST.user', password: 'test-Passw0rd!' })).status, 409)  // names are not case sensitive
    const raw = fs.readFileSync(path.join(t.dataDir, 'admin.json'), 'utf8')
    assert.ok(!raw.includes('test-Passw0rd!'), 'the password is never stored in plain text')

    t.resetCookie()
    assert.equal((await signIn(t, 'test.user', 'wrong-password')).status, 401)
    assert.equal((await signIn(t, 'nobody', 'test-Passw0rd!')).status, 401)
    assert.equal((await signIn(t, 'Test.User', 'test-Passw0rd!')).status, 200)                                                    // any letter case
    assert.equal((await t.call('/portal/api/streams')).status, 200)
    assert.equal((await t.call('/portal/api/me')).body.user, 'test.user')
    const act = t.admin.auditList().map(e => e.action + ':' + e.who)
    assert.ok(act.includes('login:test.user') && act.includes('login.fail:nobody'))
  } finally { await t.close() }
})

test('accounts: removing one, or changing its password, signs that user out', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    await post(t, '/portal/api/owner/users', { username: 'person.one', password: 'first-password-1' })
    const ownerJar = { ...t.jar() }
    t.resetCookie()
    await signIn(t, 'person.one', 'first-password-1')
    const userJar = { ...t.jar() }
    const cookieOf = jar => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ')
    const as = async (jar, p, o = {}) => (await fetch(t.base + p, { method: o.method || 'GET', headers: { Cookie: cookieOf(jar), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined })).status
    assert.equal(await as(userJar, '/portal/api/streams'), 200)
    assert.equal(await as(ownerJar, '/portal/api/owner/users/person.one/password', { method: 'POST', body: { password: 'second-password-2' } }), 200)
    assert.equal(await as(userJar, '/portal/api/streams'), 401, 'old session ends when the password changes')
    assert.equal((await signIn(t, 'person.one', 'first-password-1')).status, 401)
    assert.equal((await signIn(t, 'person.one', 'second-password-2')).status, 200)
    assert.equal(await as(ownerJar, '/portal/api/owner/users/person.one', { method: 'DELETE' }), 200)
    assert.equal((await t.call('/portal/api/streams')).status, 401, 'a removed account is signed out')
    assert.equal((await signIn(t, 'person.one', 'second-password-2')).status, 401)
  } finally { await t.close() }
})

test('accounts: shared sign-in can be turned off, but never leaves nobody able to sign in', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    assert.equal((await post(t, '/portal/api/owner/settings', { settings: { sharedLogin: false } })).status, 400)   // no accounts yet
    await post(t, '/portal/api/owner/users', { username: 'only.user', password: 'only-password-1' })
    assert.equal((await post(t, '/portal/api/owner/settings', { settings: { sharedLogin: false } })).status, 200)
    t.resetCookie()
    assert.equal((await adminLogin(t)).status, 401, 'the shared password no longer signs in')
    assert.equal((await signIn(t, 'only.user', 'only-password-1')).status, 200)
    await ownerLogin(t)
    assert.equal((await t.call('/portal/api/owner/users/only.user', { method: 'DELETE' })).status, 400)            // last account, shared sign-in off
  } finally { await t.close() }
})
