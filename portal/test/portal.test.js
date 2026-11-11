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
    assert.ok(a.includes('-threads') && a[a.indexOf('-threads') + 1] === '1', 'one decoder thread')
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

// ── add-user.js / reset-owner.js (run on the server) ──────────────────────────
test('add-user.js: creates an account with a generated password, leaves an existing one alone, resets on request', async () => {
  const { execFileSync, spawnSync } = require('node:child_process')
  const { openAdmin } = require('../lib/admin')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adduser-'))
  const script = path.join(__dirname, '..', 'add-user.js')
  const run = (...a) => execFileSync(process.execPath, [script, ...a, dir], { encoding: 'utf8' })

  const out = run('demo.one')
  const pw = out.split('Password: ')[1].trim()
  assert.match(pw, /^[a-z2-9]{14}$/)                       // lowercase letters and digits only: typable on any console
  assert.ok(out.includes('Username: demo.one'))
  const raw = fs.readFileSync(path.join(dir, 'admin.json'), 'utf8')
  assert.ok(!raw.includes(pw), 'only a hash is stored')

  // The account works at the real sign-in.
  const { server, store, admin } = createPortal({ port: 0, adminPassword: 'x'.repeat(8), secret: 'b'.repeat(32), dataDir: dir, thumbDir: path.join(dir, 'th'), directoryUrl: 'http://127.0.0.1:1', directoryKey: 'k', mediamtxApi: 'http://127.0.0.1:1', mediamtxWebrtc: 'http://127.0.0.1:1', relaySrt: '127.0.0.1:1', relayLatencyMs: 100 })
  const port = await listen(server)
  const login = (u, p) => fetch(`http://127.0.0.1:${port}/portal/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })
  try {
    assert.equal((await login('demo.one', pw)).status, 200)
    assert.equal((await login('demo.one', 'wrong')).status, 401)
  } finally { await new Promise(r => { store.flush(); admin.flush(); server.close(r) }) }

  const again = run('demo.one')
  assert.ok(again.includes('already exists') && !again.includes('Password:'), 'no second password for an existing account')
  assert.ok(openAdmin(dir).user('demo.one'))
  const hash1 = openAdmin(dir).user('demo.one').pwHash
  const reset = run('demo.one', '--reset')
  const pw2 = reset.split('Password: ')[1].trim()
  assert.notEqual(pw2, pw)
  assert.notEqual(openAdmin(dir).user('demo.one').pwHash, hash1)
  assert.equal(openAdmin(dir).user('demo.one').ver, 2, 'a reset signs the old sessions out')

  const bad = spawnSync(process.execPath, [script, 'x', dir], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
})

test('reset-owner.js: the new owner password works and shared sign-in comes back', async () => {
  const { execFileSync } = require('node:child_process')
  const { openAdmin } = require('../lib/admin')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resetowner-'))
  const a = openAdmin(dir); a.setUser('someone', auth.hashPassword('some-password-1')); a.patchSettings({ sharedLogin: false }); a.flush()
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'reset-owner.js'), dir], { encoding: 'utf8' })
  const pw = out.split('New owner password: ')[1].trim()
  const b = openAdmin(dir)
  assert.ok(auth.checkPassword(pw, b.ownerPwHash))
  assert.equal(b.settings().sharedLogin, true)
  assert.ok(b.epoch >= 2)
})

// ── roles: an admin account needs no second password ──────────────────────────
test('roles: an admin account opens the Admin area straight away; users and the shared password still need the owner password', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'boss.one', password: 'boss-password-1', role: 'admin' })).status, 200)
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'plain.one', password: 'plain-password-1' })).status, 200)   // default role: user
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'odd.one', password: 'odd-password-123', role: 'root' })).status, 400)

    t.resetCookie()
    await signIn(t, 'boss.one', 'boss-password-1')
    const st = (await t.call('/portal/api/owner/status')).body
    assert.deepEqual([st.unlocked, st.viaAccount, st.reauth], [true, true, 'account'])
    assert.equal((await t.call('/portal/api/owner/settings')).status, 200)                       // no owner password asked
    assert.equal((await t.call('/portal/api/owner/health')).status, 200)
    assert.equal((await t.call('/portal/api/me')).body.role, 'admin')

    t.resetCookie()
    await signIn(t, 'plain.one', 'plain-password-1')
    assert.equal((await t.call('/portal/api/owner/status')).body.unlocked, false)
    assert.equal((await t.call('/portal/api/owner/settings')).status, 403)
    assert.equal((await ownerLogin(t)).status, 200)                                              // the owner password still opens it
    assert.equal((await t.call('/portal/api/owner/settings')).status, 200)

    t.resetCookie()
    await adminLogin(t)                                                                          // shared password
    assert.equal((await t.call('/portal/api/owner/settings')).status, 403)
  } finally { await t.close() }
})

test('roles: changing a role takes effect at once; legacy accounts without a role count as admin', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    await post(t, '/portal/api/owner/users', { username: 'swap.me', password: 'swap-password-1', role: 'admin' })
    const ownerJar = { ...t.jar() }
    t.resetCookie()
    await signIn(t, 'swap.me', 'swap-password-1')
    assert.equal((await t.call('/portal/api/owner/settings')).status, 200)
    const cookieOf = jar => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ')
    const asOwner = (p, body) => fetch(t.base + p, { method: 'POST', headers: { Cookie: cookieOf(ownerJar), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await asOwner('/portal/api/owner/users/swap.me/role', { role: 'nope' })).status, 400)
    assert.equal((await asOwner('/portal/api/owner/users/ghost/role', { role: 'user' })).status, 404)
    assert.equal((await asOwner('/portal/api/owner/users/swap.me/role', { role: 'user' })).status, 200)
    assert.equal((await t.call('/portal/api/owner/settings')).status, 403, 'demoted: the same session loses the Admin area')

  } finally { await t.close() }
})

test('roles: an admin account changes passwords with its own password, not the owner password', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    await post(t, '/portal/api/owner/users', { username: 'self.admin', password: 'self-password-1', role: 'admin' })
    t.resetCookie()
    await signIn(t, 'self.admin', 'self-password-1')
    assert.equal((await post(t, '/portal/api/owner/password', { which: 'admin', current: 'ownerpass1234', next: 'brand-new-password' })).status, 401)   // the owner password is not what is asked
    assert.equal((await post(t, '/portal/api/owner/password', { which: 'admin', current: 'self-password-1', next: 'brand-new-password' })).status, 200)
  } finally { await t.close() }
})

test('add-user.js: an account made from the server is an admin unless told otherwise', async () => {
  const { execFileSync } = require('node:child_process')
  const { openAdmin } = require('../lib/admin')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addrole-'))
  const script = path.join(__dirname, '..', 'add-user.js')
  assert.ok(execFileSync(process.execPath, [script, 'srv.admin', dir], { encoding: 'utf8' }).includes('(admin)'))
  assert.ok(execFileSync(process.execPath, [script, 'srv.user', '--role', 'user', dir], { encoding: 'utf8' }).includes('(user)'))
  const a = openAdmin(dir)
  assert.equal(a.users().find(u => u.username === 'srv.admin').role, 'admin')
  assert.equal(a.users().find(u => u.username === 'srv.user').role, 'user')
})

test('roles: an account saved before roles existed counts as admin', async () => {
  const { openAdmin } = require('../lib/admin')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'))
  const a = openAdmin(dir)
  a.setUser('old.acct', auth.hashPassword('old-password-123'), 'user'); a.flush()
  const file = path.join(dir, 'admin.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete raw.users['old.acct'].role                      // the shape written before roles existed
  fs.writeFileSync(file, JSON.stringify(raw))
  assert.equal(openAdmin(dir).users()[0].role, 'admin')
  const { server, store, admin } = createPortal({ port: 0, adminPassword: 'x'.repeat(8), secret: 'c'.repeat(32), dataDir: dir, thumbDir: path.join(dir, 'th'), directoryUrl: 'http://127.0.0.1:1', directoryKey: 'k', mediamtxApi: 'http://127.0.0.1:1', mediamtxWebrtc: 'http://127.0.0.1:1', relaySrt: '127.0.0.1:1', relayLatencyMs: 100 })
  const port = await listen(server)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/portal/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'old.acct', password: 'old-password-123' }) })
    assert.equal(r.status, 200)
    const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    const st = await (await fetch(`http://127.0.0.1:${port}/portal/api/owner/status`, { headers: { Cookie: cookie } })).json()
    assert.deepEqual([st.unlocked, st.viaAccount], [true, true])
  } finally { await new Promise(r => { store.flush(); admin.flush(); server.close(r) }) }
})

// ── profiles: name and email per account ──────────────────────────────────────
test('profiles: an admin sets name and email for any account; bad values are refused', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    const mk = await post(t, '/portal/api/owner/users', { username: 'pat.one', password: 'pat-password-123', name: '  Pat One ', email: 'pat@example.com' })
    assert.equal(mk.status, 200)
    let u = (await t.call('/portal/api/owner/users')).body.users.find(x => x.username === 'pat.one')
    assert.equal(u.name, 'Pat One'); assert.equal(u.email, 'pat@example.com')

    assert.equal((await post(t, '/portal/api/owner/users', { username: 'bad.mail', password: 'bad-password-123', email: 'not-an-email' })).status, 400)
    assert.equal((await post(t, '/portal/api/owner/users', { username: 'long.name', password: 'long-password-123', name: 'x'.repeat(81) })).status, 400)
    assert.equal((await t.call('/portal/api/owner/users')).body.users.some(x => x.username === 'bad.mail'), false, 'a refused account is not created')

    assert.equal((await post(t, '/portal/api/owner/users/pat.one/profile', { name: 'Patricia One', email: 'patricia@example.org' })).status, 200)
    assert.equal((await post(t, '/portal/api/owner/users/pat.one/profile', { name: 'Patricia One', email: 'oops' })).status, 400)
    assert.equal((await post(t, '/portal/api/owner/users/ghost/profile', { name: 'No One' })).status, 404)
    u = (await t.call('/portal/api/owner/users')).body.users.find(x => x.username === 'pat.one')
    assert.equal(u.name, 'Patricia One'); assert.equal(u.email, 'patricia@example.org')
    assert.equal((await post(t, '/portal/api/owner/users/pat.one/profile', { name: '', email: '' })).status, 200)   // both optional
    assert.equal((await t.call('/portal/api/owner/users')).body.users.find(x => x.username === 'pat.one').email, '')
    assert.ok(t.admin.auditList().some(e => e.action === 'account.user.profile'))
  } finally { await t.close() }
})

test('profiles: an account edits its own; the shared password has no profile; /me carries it', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    await post(t, '/portal/api/owner/users', { username: 'self.edit', password: 'self-password-123' })
    assert.equal((await post(t, '/portal/api/profile', { name: 'Shared', email: 'a@b.co' })).status, 400, 'a shared-password session has no account')
    t.resetCookie()
    await signIn(t, 'self.edit', 'self-password-123')
    assert.equal((await post(t, '/portal/api/profile', { name: 'Self Edit', email: 'self@example.com' })).status, 200)
    assert.equal((await post(t, '/portal/api/profile', { name: 'Self Edit', email: 'bad' })).status, 400)
    const me = (await t.call('/portal/api/me')).body
    assert.deepEqual([me.user, me.name, me.email], ['self.edit', 'Self Edit', 'self@example.com'])
    assert.equal((await t.call('/portal/api/owner/users/self.edit/profile', { method: 'POST', body: { name: 'X' } })).status, 403, 'a plain user cannot edit profiles through the owner area')
  } finally { await t.close() }
})

test('add-user.js: --name and --email set the profile', async () => {
  const { execFileSync } = require('node:child_process')
  const { openAdmin } = require('../lib/admin')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addprofile-'))
  const script = path.join(__dirname, '..', 'add-user.js')
  execFileSync(process.execPath, [script, 'with.profile', '--name', 'With Profile', '--email', 'with@example.com', dir], { encoding: 'utf8' })
  const u = openAdmin(dir).users()[0]
  assert.deepEqual([u.name, u.email], ['With Profile', 'with@example.com'])
  assert.throws(() => execFileSync(process.execPath, [script, 'bad.profile', '--email', 'nope', dir], { encoding: 'utf8', stdio: 'pipe' }))
})

// ── capacity test API ─────────────────────────────────────────────────────────
test('capacity test: needs confirmation, refuses while live streams are on air, then leaves a request for the helper', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    assert.equal((await t.call('/portal/api/owner/captest/start', { method: 'POST', body: { streamsMax: 10 } })).status, 400)          // no confirmation
    const live = await post(t, '/portal/api/owner/captest/start', { streamsMax: 10, ack: true })
    assert.equal(live.status, 409); assert.match(live.body.error, /live streams are on air/); assert.ok(live.body.live.includes('ESPN 1'))
    assert.equal(fs.existsSync(path.join(t.ctlDir, 'request')), false)

    const ok = await post(t, '/portal/api/owner/captest/start', { streamsMax: 9999, step: 0, stepSec: 5, allowLive: true, ack: true })
    assert.equal(ok.status, 200)
    assert.equal(fs.readFileSync(path.join(t.ctlDir, 'request'), 'utf8'), 'captest-start\n')
    const cfg = JSON.parse(fs.readFileSync(path.join(t.ctlDir, 'captest.json'), 'utf8'))
    assert.deepEqual([cfg.streamsMax, cfg.step, cfg.stepSec, cfg.allowLive], [60, 1, 15, true], 'settings are clamped before they reach the runner')
    assert.equal((await t.call('/portal/api/owner/captest')).body.starting, true)
    assert.ok(t.admin.auditList().some(e => e.action === 'captest.start'))

    assert.equal((await post(t, '/portal/api/owner/captest/stop')).status, 200)
    assert.equal(fs.readFileSync(path.join(t.ctlDir, 'request'), 'utf8'), 'captest-stop\n')
  } finally { await t.close() }
})

test('capacity test: shows what the runner writes, and only counts a fresh status as running', async () => {
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    const dir = path.join(t.dataDir, 'captest'); fs.mkdirSync(dir, { recursive: true })
    assert.deepEqual((await t.call('/portal/api/owner/captest')).body, { running: false, stalled: false, starting: false, status: null, history: [] })

    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ phase: 'ramping', step: 4, steps: [], now: { streams: 4, cpu: 20 }, cfg: {} }))
    let s = (await t.call('/portal/api/owner/captest')).body
    assert.equal(s.running, true); assert.equal(s.status.now.streams, 4)
    assert.equal((await post(t, '/portal/api/owner/captest/start', { ack: true, allowLive: true })).status, 409, 'one test at a time')

    const old = new Date(Date.now() - 60000)
    fs.utimesSync(path.join(dir, 'status.json'), old, old)
    s = (await t.call('/portal/api/owner/captest')).body
    assert.equal(s.running, false, 'a status nobody has updated for a minute is not running'); assert.equal(s.stalled, true, 'and it is reported as stopped without finishing')

    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ phase: 'done', conclusion: 'Clean through 8 streams', steps: [] }))
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([{ at: 1, conclusion: 'older' }]))
    s = (await t.call('/portal/api/owner/captest')).body
    assert.equal(s.running, false); assert.equal(s.status.conclusion, 'Clean through 8 streams'); assert.equal(s.history[0].conclusion, 'older')
  } finally { await t.close() }
})

test('capacity test: a plain user cannot reach it', async () => {
  const t = await setup()
  try {
    await adminLogin(t)                                                  // shared password, owner area still locked
    assert.equal((await t.call('/portal/api/owner/captest')).status, 403)
    assert.equal((await post(t, '/portal/api/owner/captest/start', { ack: true, allowLive: true })).status, 403)
  } finally { await t.close() }
})


// ── Comms (the intercom server) ───────────────────────────────────────────────
// A stand-in for the Comms admin API: in-memory users and groups, a Bearer token, and a log of what was asked.
function fakeComms(opts = {}) {
  const st = { users: [{ id: 'u_admin', username: 'admin', name: 'Admin', admin: true, groups: [], overrides: {}, disabled: false }], groups: [{ id: 'cam', name: 'Camera', selfJoin: false, grants: { prod: { talk: true, listen: true } } }],
    channels: [{ id: 'prod', name: 'PRODUCTION' }], online: [{ id: 'u_admin', name: 'Admin' }], log: [], kicked: [], seq: 0 }
  const handler = (req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = b ? JSON.parse(b) : {}
      const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
      const m = /^\/comms\/admin\/api\/(.*)$/.exec(req.url)
      if (!m) return send(404, { error: 'nope' })
      const [kind, id] = m[1].split('/')
      st.log.push(req.method + ' ' + m[1] + (kind === 'login' ? '' : ' ' + JSON.stringify(body)))
      if (kind === 'login') return body.username === 'admin' && body.password === 'commspass1' ? send(200, { token: opts.token || 'tok1', name: 'Admin' }) : send(401, { error: 'Wrong username or password' })
      if (req.headers.authorization !== 'Bearer ' + (opts.token || 'tok1')) return send(401, { error: 'Sign in again' })
      if (kind === 'logout') return send(200, { ok: true })
      if (kind === 'state') return send(200, { channels: st.channels, groups: st.groups, users: st.users, online: st.online, gateways: [], serverPlayer: false, players: {} })
      if (kind === 'kick') { st.kicked.push(id); return send(200, { ok: true }) }
      if (kind === 'users' && req.method === 'POST') {
        if (st.users.some(u => u.username === body.username)) return send(409, { error: 'That username is taken' })
        const u = { id: 'u_' + (++st.seq), username: body.username, name: body.name || body.username, admin: false, groups: body.groups || [], overrides: {}, disabled: false, password: body.password }
        st.users.push(u); return send(201, u)
      }
      if (kind === 'users' && req.method === 'PUT') { const u = st.users.find(x => x.id === id); if (!u) return send(404, { error: 'No such user' }); Object.assign(u, body); return send(200, u) }
      if (kind === 'groups' && req.method === 'POST') { const g = { id: String(body.name).toLowerCase(), name: body.name, selfJoin: !!body.selfJoin, grants: body.grants || {} }; st.groups.push(g); return send(201, g) }
      if (kind === 'groups' && req.method === 'PUT') { const g = st.groups.find(x => x.id === id); if (!g) return send(404, { error: 'No such group' }); Object.assign(g, body); return send(200, g) }
      if (kind === 'groups' && req.method === 'DELETE') { st.groups = st.groups.filter(x => x.id !== id); return send(200, { ok: true }) }
      send(404, { error: 'Not found' })
    })
  }
  return { st, handler }
}

async function connectComms(t, url, extra = {}) {
  return post(t, '/portal/api/owner/comms/connect', { url, user: 'admin', password: 'commspass1', ...extra })
}

test('comms: connect checks the sign-in, keeps the password sealed, and never shows it back', async () => {
  const t = await setup(), fc = fakeComms(), srv = http.createServer(fc.handler), port = await listen(srv)
  try {
    await adminLogin(t); await ownerLogin(t)
    assert.deepEqual((await t.call('/portal/api/owner/comms')).body, { configured: false, url: '', user: '', fingerprint: '', linked: 0 })
    assert.equal((await t.call('/portal/api/owner/comms/state')).status, 409)                      // not connected yet

    const bad = await connectComms(t, `http://127.0.0.1:${port}/comms`, { password: 'wrong' })
    assert.equal(bad.status, 400); assert.match(bad.body.error, /Wrong username or password/)
    assert.equal((await t.call('/portal/api/owner/comms')).body.configured, false)

    const ok = await connectComms(t, `http://127.0.0.1:${port}/comms/`)
    assert.equal(ok.status, 200)
    const s = (await t.call('/portal/api/owner/comms')).body
    assert.equal(s.configured, true); assert.equal(s.url, `http://127.0.0.1:${port}/comms`); assert.equal(s.user, 'admin')
    assert.ok(!JSON.stringify(s).includes('commspass1'))
    const file = fs.readFileSync(path.join(t.dataDir, 'admin.json'), 'utf8')
    assert.ok(!file.includes('commspass1'), 'the Comms password is not stored in plain text')
    assert.ok(t.admin.auditList().some(e => e.action === 'comms.connect'))

    const st = (await t.call('/portal/api/owner/comms/state')).body
    assert.equal(st.groups[0].id, 'cam'); assert.equal(st.online[0].name, 'Admin')
    assert.equal((await post(t, '/portal/api/owner/comms/disconnect')).status, 200)
    assert.equal((await t.call('/portal/api/owner/comms/state')).status, 409)
  } finally { await t.close(); srv.close() }
})

test('comms: kick, group and permission changes pass through, and only the allowed user fields', async () => {
  const t = await setup(), fc = fakeComms(), srv = http.createServer(fc.handler), port = await listen(srv)
  try {
    await adminLogin(t); await ownerLogin(t); await connectComms(t, `http://127.0.0.1:${port}/comms`)
    assert.equal((await post(t, '/portal/api/owner/comms/kick/u_admin')).status, 200); assert.deepEqual(fc.st.kicked, ['u_admin'])
    const g = (await post(t, '/portal/api/owner/comms/groups', { name: 'Audio', grants: { prod: { talk: true, listen: true, music: true } } })).body
    assert.equal(g.name, 'Audio')
    assert.equal((await t.call('/portal/api/owner/comms/groups/audio', { method: 'PUT', body: { grants: { prod: { listen: true } } } })).body.grants.prod.talk, undefined)
    assert.equal((await t.call('/portal/api/owner/comms/groups/audio', { method: 'DELETE' })).status, 200)
    assert.ok(!fc.st.groups.some(x => x.id === 'audio'))

    // only groups, overrides, disabled and title: a request for the admin flag or a password is dropped
    const u = await t.call('/portal/api/owner/comms/users/u_admin', { method: 'PUT', body: { groups: ['cam'], admin: false, password: 'hackedpass1', title: 'TD' } })
    assert.equal(u.status, 200); assert.deepEqual(fc.st.users[0].groups, ['cam']); assert.equal(fc.st.users[0].admin, true); assert.equal(fc.st.users[0].password, undefined)
    assert.ok(t.admin.auditList().some(e => e.action === 'comms.kick'))
    assert.equal((await t.call('/portal/api/owner/comms/users/nobody', { method: 'PUT', body: { title: 'x' } })).status, 404)
  } finally { await t.close(); srv.close() }
})

test('comms: a portal account is linked, kept in step, and disabled when removed', async () => {
  const t = await setup(), fc = fakeComms(), srv = http.createServer(fc.handler), port = await listen(srv)
  try {
    await adminLogin(t); await ownerLogin(t); await connectComms(t, `http://127.0.0.1:${port}/comms`)
    // created with the link ticked: the Comms login is made with the same username, display name and password
    const made = await post(t, '/portal/api/owner/users', { username: 'mia', password: 'miapassword1', name: 'Mia Cole', comms: { link: true, groups: ['cam'] } })
    assert.equal(made.status, 200); assert.equal(made.body.commsNote, '')
    const cu = fc.st.users.find(u => u.username === 'mia')
    assert.deepEqual([cu.name, cu.groups, cu.password, cu.disabled], ['Mia Cole', ['cam'], 'miapassword1', false])
    assert.equal(made.body.users.find(u => u.username === 'mia').commsLinked, true)
    assert.equal((await t.call('/portal/api/owner/comms/state')).body.links[cu.id], 'mia')

    // a new password and a new name follow to Comms
    await post(t, '/portal/api/owner/users/mia/password', { password: 'newpassword22' }); assert.equal(cu.password, 'newpassword22')
    await post(t, '/portal/api/owner/users/mia/profile', { name: 'Mia C', email: '' }); assert.equal(cu.name, 'Mia C')

    // the profile survives a password change (setUser used to rebuild the record)
    assert.equal(t.admin.users().find(u => u.username === 'mia').name, 'Mia C')

    // an existing account is linked later: a Comms password is needed only if the Comms account does not exist
    await post(t, '/portal/api/owner/users', { username: 'ben', password: 'benpassword12' })
    const noPw = await post(t, '/portal/api/owner/users/ben/comms', { groups: [] })
    assert.equal(noPw.status, 400); assert.match(noPw.body.error, /enter a password/)
    assert.equal((await post(t, '/portal/api/owner/users/ben/comms', { groups: ['cam'], password: 'benpassword12' })).status, 200)
    assert.equal(fc.st.users.find(u => u.username === 'ben').groups[0], 'cam')

    // unlink and delete disable the Comms account, never delete it
    assert.equal((await t.call('/portal/api/owner/users/ben/comms', { method: 'DELETE' })).status, 200)
    assert.equal(fc.st.users.find(u => u.username === 'ben').disabled, true)
    assert.equal(t.admin.users().find(u => u.username === 'ben').commsLinked, false)
    const del = await t.call('/portal/api/owner/users/mia', { method: 'DELETE' })
    assert.equal(del.status, 200); assert.equal(del.body.commsNote, '')
    assert.equal(cu.disabled, true); assert.ok(fc.st.users.includes(cu), 'the Comms account is kept, only disabled')
  } finally { await t.close(); srv.close() }
})

test('comms: if Comms is unreachable the portal change still happens, with a note', async () => {
  const t = await setup(), fc = fakeComms(), srv = http.createServer(fc.handler), port = await listen(srv)
  try {
    await adminLogin(t); await ownerLogin(t); await connectComms(t, `http://127.0.0.1:${port}/comms`)
    await post(t, '/portal/api/owner/users', { username: 'kim', password: 'kimpassword12', comms: { link: true } })
    await new Promise(r => srv.close(r))                                                            // Comms goes away
    const pw = await post(t, '/portal/api/owner/users/kim/password', { password: 'another-pass-3' })
    assert.equal(pw.status, 200); assert.match(pw.body.commsNote, /Comms side was not updated/)
    assert.equal((await t.call('/portal/api/owner/comms/state')).status, 502)
    const del = await t.call('/portal/api/owner/users/kim', { method: 'DELETE' })
    assert.equal(del.status, 200); assert.match(del.body.commsNote, /not updated/)
  } finally { await t.close(); srv.close() }
})

test('comms: the certificate is pinned to the one the owner confirmed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'))
  const mk = name => {
    const r = require('node:child_process').spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, name + '.key'), '-out', path.join(tmp, name + '.crt'), '-days', '2', '-subj', '/CN=comms-test', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' })
    return r.status === 0 ? { key: fs.readFileSync(path.join(tmp, name + '.key')), cert: fs.readFileSync(path.join(tmp, name + '.crt')) } : null
  }
  const a = mk('a'), b = mk('b')
  if (!a || !b) return                                                                                // openssl is not available here
  const https = require('node:https')
  const fc = fakeComms(), srv = https.createServer(a, fc.handler), port = await listen(srv)
  const t = await setup()
  try {
    await adminLogin(t); await ownerLogin(t)
    const url = `https://127.0.0.1:${port}/comms`
    const probe = await post(t, '/portal/api/owner/comms/probe', { url })
    assert.equal(probe.status, 200); assert.match(probe.body.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)

    assert.equal((await connectComms(t, url)).status, 409)                                          // no fingerprint confirmed
    assert.equal((await connectComms(t, url, { fingerprint: 'AA:BB' })).status, 409)               // not the one it presented
    assert.equal((await connectComms(t, url, { fingerprint: probe.body.fingerprint })).status, 200)
    assert.equal((await t.call('/portal/api/owner/comms/state')).status, 200)

    // the server's certificate is replaced by a different one: refused, not trusted
    await new Promise(r => srv.close(r))
    const srv2 = https.createServer(b, fc.handler); await new Promise(r => srv2.listen(port, '127.0.0.1', r))
    try {
      const r = await t.call('/portal/api/owner/comms/state')
      assert.equal(r.status, 502); assert.match(r.body.error, /different certificate/)
    } finally { srv2.close() }
  } finally { await t.close(); srv.close() }
})
