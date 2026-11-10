'use strict'
// Arena Portal: web links to watch live Arena Link streams in a browser, stream status, and remote
// control of decoders. Runs on 127.0.0.1 behind nginx. Standard library only (Node 18+).
//
//   /portal/            admin page (password login)
//   /portal/api/...     admin API (cookie)
//   /w/<link id>        public viewer page for a share link (optional link password)
//
// Browser playback: the portal makes mediamtx pull the stream from the SRT relay on demand and hands
// the browser WebRTC (WHEP) through this server, so a link can be revoked or expire at any moment and
// the media path name is never exposed.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const auth = require('./lib/auth')
const { openStore } = require('./lib/store')

function loadConfig(env = process.env) {
  return {
    port: parseInt(env.PORTAL_PORT || '8910', 10),
    adminPassword: env.PORTAL_ADMIN_PASSWORD || '',
    secret: env.PORTAL_SECRET || '',
    directoryUrl: (env.DIRECTORY_URL || 'http://127.0.0.1:8002').replace(/\/$/, ''),
    directoryKey: env.LINK_KEY || '',
    mediamtxApi: (env.MEDIAMTX_API || 'http://127.0.0.1:9997').replace(/\/$/, ''),
    mediamtxWebrtc: (env.MEDIAMTX_WEBRTC || 'http://127.0.0.1:8889').replace(/\/$/, ''),
    relaySrt: env.RELAY_SRT || '127.0.0.1:8895',
    relayLatencyMs: parseInt(env.PORTAL_RELAY_LATENCY_MS || '150', 10),
    dataDir: env.PORTAL_DATA_DIR || '/var/lib/arena-portal',
    publicBase: (env.PORTAL_PUBLIC_BASE || '').replace(/\/$/, ''),   // what share links start with, e.g. http://5.78.236.254
  }
}

const PUBLIC_DIR = path.join(__dirname, 'public')
const readPublic = f => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8')

const SESSION_SEC = 12 * 3600
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

function createPortal(cfg) {
  if (!cfg.adminPassword) throw new Error('PORTAL_ADMIN_PASSWORD is not set')
  if (!cfg.secret || cfg.secret.length < 16) throw new Error('PORTAL_SECRET must be at least 16 characters')
  const store = openStore(cfg.dataDir)
  const loginOk = auth.throttle(8, 60000)
  const pwOk = auth.throttle(10, 60000)

  // ── helpers ────────────────────────────────────────────────────────────────
  const send = (res, code, body, headers = {}) => {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body)
    const buf = isStr ? body : JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(buf)
  }
  const readBody = (req, max = 65536) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
  const readJson = async req => { try { return JSON.parse((await readBody(req)).toString() || '{}') } catch { return null } }
  const clientIp = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  const secure = req => req.headers['x-forwarded-proto'] === 'https'   // nginx sets it; plain http (tests, local) gets a non-Secure cookie

  const isAdmin = req => {
    const c = auth.parseCookies(req.headers.cookie).arena_portal
    const v = auth.unsign(c, cfg.secret)
    if (!v) return false
    const [kind, exp] = v.split('|')
    return kind === 'admin' && Number(exp) > Date.now()
  }
  // State-changing admin calls must come from this site (cookie is SameSite=Lax as well).
  const sameOrigin = req => {
    const o = req.headers.origin
    if (!o) return true
    try { return new URL(o).host === req.headers.host } catch { return false }
  }

  // ── directory + mediamtx ───────────────────────────────────────────────────
  async function dir(pathname, body) {
    const r = await fetch(cfg.directoryUrl + pathname, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Arena-Key': cfg.directoryKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) throw new Error(`directory ${r.status}`)
    return r.json()
  }
  let encCache = { at: 0, list: [] }
  async function encoders() {
    if (Date.now() - encCache.at < 1000) return encCache.list
    try { encCache = { at: Date.now(), list: (await dir('/v1/encoders')).encoders || [] } } catch { encCache = { at: Date.now(), list: [] } }
    return encCache.list
  }
  const findEncoder = async name => (await encoders()).find(e => e.name === name && e.relay && e.relay.name) || null
  const browserOk = e => !/hevc|h265|265/i.test(e.codec || '')

  const mtx = (p, opts = {}) => fetch(cfg.mediamtxApi + p, { signal: AbortSignal.timeout(3000), ...opts })
  // The mediamtx path for a relay stream: unguessable, so nobody can play it around the portal.
  const pathName = relayName => {
    const tag = crypto.createHmac('sha256', cfg.secret).update('path:' + relayName).digest('hex').slice(0, 10)
    return `portal_${String(relayName).replace(/[^A-Za-z0-9_.-]/g, '-')}_${tag}`
  }
  async function ensurePath(relayName) {
    const name = pathName(relayName)
    const body = {
      source: `srt://${cfg.relaySrt}?streamid=read:${relayName}&mode=caller&latency=${cfg.relayLatencyMs}`,
      sourceOnDemand: true, sourceOnDemandStartTimeout: '10s', sourceOnDemandCloseAfter: '15s',
    }
    const r = await mtx(`/v3/config/paths/add/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok && r.status !== 400) throw new Error(`mediamtx ${r.status}`)   // 400 = already configured
    return name
  }
  async function readerCounts() {
    try {
      const r = await mtx('/v3/paths/list?itemsPerPage=500')
      const j = await r.json()
      const m = {}
      for (const it of j.items || []) m[it.name] = (it.readers || []).length
      return m
    } catch { return {} }
  }

  // ── links ──────────────────────────────────────────────────────────────────
  const linkState = l => (l.revoked ? 'revoked' : l.expiresAt && l.expiresAt < Date.now() ? 'expired' : 'active')
  const publicLink = l => ({
    id: l.id, stream: l.stream, label: l.label, createdAt: l.createdAt, expiresAt: l.expiresAt,
    state: linkState(l), hasPassword: !!l.pwHash, views: store.viewCount(l.id),
  })

  function viewerAuthorized(req, l) {
    if (!l.pwHash) return true
    const v = auth.unsign(auth.parseCookies(req.headers.cookie)['pw_' + l.id], cfg.secret)
    return v === 'pw:' + l.id
  }

  // ── routes ─────────────────────────────────────────────────────────────────
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    const m = req.method

    // Public viewer
    let mm
    if ((mm = p.match(/^\/w\/([a-z0-9]{6,32})(\/.*)?$/))) return viewer(req, res, mm[1], mm[2] || '', m)

    // The admin side only works over https (its password and cookie must not cross the network in the clear).
    if (p.startsWith('/portal') && req.headers['x-forwarded-proto'] === 'http') {
      res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` }); return res.end()
    }
    if (p === '/portal') { res.writeHead(301, { Location: '/portal/' }); return res.end() }
    if (p === '/portal/' && m === 'GET') return send(res, 200, readPublic('admin.html'))

    // Admin API
    if (p === '/portal/api/login' && m === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'bad origin' })
      if (!loginOk(clientIp(req))) return send(res, 429, { error: 'too many attempts, wait a minute' })
      const b = await readJson(req)
      if (!b || !auth.safeEqual(b.password || '', cfg.adminPassword)) return send(res, 401, { error: 'wrong password' })
      const sess = auth.sign(`admin|${Date.now() + SESSION_SEC * 1000}`, cfg.secret)
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('arena_portal', sess, { maxAgeSec: SESSION_SEC, secure: secure(req) }) })
    }
    if (p === '/portal/api/logout' && m === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('arena_portal', '', { maxAgeSec: 0, secure: secure(req) }) })
    }
    if (p.startsWith('/portal/api/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'sign in' })
      if (m !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'bad origin' })
      return adminApi(req, res, p, m)
    }
    send(res, 404, { error: 'not found' })
  }

  async function adminApi(req, res, p, m) {
    if (p === '/portal/api/me') return send(res, 200, { ok: true, publicBase: cfg.publicBase })

    if (p === '/portal/api/streams' && m === 'GET') {
      const [list, readers] = await Promise.all([encoders(), readerCounts()])
      const links = store.links().filter(l => linkState(l) === 'active')
      return send(res, 200, {
        streams: list.map(e => {
          const rn = e.relay && e.relay.name
          return {
            id: e.id, name: e.name, format: e.format, source: e.source, codec: e.codec, kbps: e.kbps, ageMs: e.ageMs,
            canShare: !!rn, browserOk: browserOk(e),
            webViewers: rn ? (readers[pathName(rn)] || 0) : 0,
            links: links.filter(l => l.stream === e.name).length,
          }
        }),
      })
    }

    if (p === '/portal/api/links' && m === 'GET') {
      return send(res, 200, { links: store.links().sort((a, b) => b.createdAt - a.createdAt).map(publicLink) })
    }
    if (p === '/portal/api/links' && m === 'POST') {
      const b = await readJson(req)
      if (!b || typeof b.stream !== 'string' || !b.stream.trim()) return send(res, 400, { error: 'choose a stream' })
      const mins = Number(b.expiresInMin) || 0
      if (mins < 0 || mins > 60 * 24 * 365) return send(res, 400, { error: 'bad expiry' })
      const l = {
        id: auth.newId(12), stream: b.stream.trim().slice(0, 128), label: String(b.label || '').trim().slice(0, 80),
        createdAt: Date.now(), expiresAt: mins ? Date.now() + mins * 60000 : 0, revoked: false,
        pwHash: b.password ? auth.hashPassword(String(b.password).slice(0, 128)) : '',
      }
      store.putLink(l)
      return send(res, 200, { link: publicLink(l) })
    }
    let mm
    if ((mm = p.match(/^\/portal\/api\/links\/([a-z0-9]+)$/))) {
      const l = store.link(mm[1])
      if (!l) return send(res, 404, { error: 'no such link' })
      if (m === 'DELETE') { l.revoked = true; store.putLink(l); return send(res, 200, { link: publicLink(l) }) }
      if (m === 'GET') return send(res, 200, { link: publicLink(l), recent: store.views(l.id).slice(-50).reverse() })
    }

    if (p === '/portal/api/decoders' && m === 'GET') {
      try { return send(res, 200, await dir('/v1/decoders')) } catch (e) { return send(res, 502, { error: String(e.message) }) }
    }
    if ((mm = p.match(/^\/portal\/api\/decoders\/([^/]+)\/want$/)) && m === 'POST') {
      const b = await readJson(req)
      if (!b || typeof b.stream !== 'string') return send(res, 400, { error: 'stream required ("" disconnects)' })
      try { return send(res, 200, await dir('/v1/decoder/want', { id: decodeURIComponent(mm[1]), stream: b.stream })) } catch (e) { return send(res, 502, { error: String(e.message) }) }
    }
    send(res, 404, { error: 'not found' })
  }

  async function viewer(req, res, id, rest, m) {
    const l = store.link(id)
    const st = l ? linkState(l) : 'missing'
    if (st !== 'active') {
      const msg = st === 'expired' ? 'This link has expired.' : 'This link is no longer available.'
      return send(res, 410, readPublic('closed.html').replace('{{MESSAGE}}', msg))
    }
    if (rest === '' && m === 'GET') {
      if (!viewerAuthorized(req, l)) return send(res, 200, readPublic('password.html').replace(/{{ID}}/g, id).replace('{{LABEL}}', esc(l.label || l.stream)))
      return send(res, 200, readPublic('viewer.html').replace(/{{ID}}/g, id).replace('{{TITLE}}', esc(l.label || l.stream)).replace('{{ICE}}', esc(JSON.stringify(ICE_SERVERS))))
    }
    if (rest === '/auth' && m === 'POST') {
      if (!pwOk(clientIp(req) + id)) return send(res, 429, { error: 'too many attempts, wait a minute' })
      const b = await readJson(req)
      if (!b || !l.pwHash || !auth.checkPassword(b.password || '', l.pwHash)) return send(res, 401, { error: 'wrong password' })
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('pw_' + id, auth.sign('pw:' + id, cfg.secret), { maxAgeSec: 86400, secure: secure(req) }) })
    }
    if (!viewerAuthorized(req, l)) return send(res, 401, { error: 'password required' })

    if (rest === '/state' && m === 'GET') {
      const e = await findEncoder(l.stream)
      return send(res, 200, { state: e ? (browserOk(e) ? 'live' : 'unsupported') : 'offline', title: l.label || l.stream })
    }
    if (rest === '/whep' && m === 'POST') {
      const e = await findEncoder(l.stream)
      if (!e) return send(res, 404, { error: 'stream is offline' })
      if (!browserOk(e)) return send(res, 415, { error: 'this stream is H.265, which browsers cannot play' })
      let name
      try { name = await ensurePath(e.relay.name) } catch (err) { return send(res, 502, { error: 'media server unavailable' }) }
      const offer = (await readBody(req, 65536)).toString()
      let r
      try {
        r = await fetch(`${cfg.mediamtxWebrtc}/${name}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer, signal: AbortSignal.timeout(15000) })
      } catch { return send(res, 502, { error: 'media server unavailable' }) }
      const text = await r.text()
      if (r.status !== 201) return send(res, r.status === 404 ? 404 : 502, { error: 'stream is not ready yet' })
      const sid = (r.headers.get('location') || '').split('/').pop()
      store.addView({ id, at: Date.now(), ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 160) })
      res.writeHead(201, { 'Content-Type': 'application/sdp', Location: `/w/${id}/whep/${encodeURIComponent(sid)}`, 'Cache-Control': 'no-store' })
      return res.end(text)
    }
    let mm
    if ((mm = rest.match(/^\/whep\/([^/]+)$/)) && (m === 'PATCH' || m === 'DELETE')) {
      const e = await findEncoder(l.stream)
      if (!e) return send(res, 404, { error: 'stream is offline' })
      const name = pathName(e.relay.name)
      const body = m === 'PATCH' ? (await readBody(req, 65536)) : undefined
      try {
        const r = await fetch(`${cfg.mediamtxWebrtc}/${name}/whep/${mm[1]}`, { method: m, headers: m === 'PATCH' ? { 'Content-Type': req.headers['content-type'] || 'application/trickle-ice-sdpfrag' } : {}, body, signal: AbortSignal.timeout(5000) })
        res.writeHead(r.status === 204 || r.status === 200 ? 204 : r.status); return res.end()
      } catch { return send(res, 502, { error: 'media server unavailable' }) }
    }
    send(res, 404, { error: 'not found' })
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('error', req.method, req.url, err && err.message)
      if (!res.headersSent) send(res, 500, { error: 'server error' })
      else res.end()
    })
  })
  return { server, store, pathName }
}

module.exports = { createPortal, loadConfig }

if (require.main === module) {
  const cfg = loadConfig()
  const { server, store } = createPortal(cfg)
  server.listen(cfg.port, '127.0.0.1', () => console.log(`arena portal on 127.0.0.1:${cfg.port}`))
  const bye = () => { store.flush(); process.exit(0) }
  process.on('SIGTERM', bye); process.on('SIGINT', bye)
}
