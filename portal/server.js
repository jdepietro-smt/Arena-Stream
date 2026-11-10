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
const os = require('node:os')
const { execFile } = require('node:child_process')
const { openStore } = require('./lib/store')
const { openAdmin, SETTINGS, USERNAME, ROLES } = require('./lib/admin')
const { createThumbs } = require('./lib/thumbs')

// Services the owner can look at and restart from the Admin page. Restarts go through a root helper
// (portal/deploy/ctl.sh) that accepts only these names; the portal itself runs unprivileged.
const SERVICES = [
  ['mediamtx', 'Stream server (mediamtx)'], ['arena-lowlat', 'Low-latency relay'], ['arena-link-directory', 'Arena Link directory'],
  ['arena-linkd', 'Share-link check'], ['arena-portal', 'Portal'], ['arena-comms', 'Comms'], ['arena-livekit', 'Comms media (LiveKit)'], ['nginx', 'Web server (nginx)'],
]
const OWNER_SEC = 15 * 60

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
    ffmpeg: env.PORTAL_FFMPEG || 'ffmpeg',
    thumbDir: env.PORTAL_THUMB_DIR || '/tmp/arena-portal-thumbs',
    relayLatencyMs: parseInt(env.PORTAL_RELAY_LATENCY_MS || '150', 10),
    dataDir: env.PORTAL_DATA_DIR || '/var/lib/arena-portal',
    publicBase: (env.PORTAL_PUBLIC_BASE || '').replace(/\/$/, ''),   // what share links start with, e.g. http://5.78.236.254
    ownerInit: env.PORTAL_OWNER_PASSWORD_INIT || '',                // first owner password; stored hashed, then removed from the env file
    ctlDir: env.PORTAL_CTL_DIR || '',                               // where restart requests are left for the root helper
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
  const admin = openAdmin(cfg.dataDir)
  const S = () => admin.settings()
  const relayLatency = () => S().relayLatencyMs || cfg.relayLatencyMs
  const publicBase = () => S().publicBase || cfg.publicBase
  const ctlDir = cfg.ctlDir || path.join(cfg.dataDir, 'ctl')
  const run = cfg.execFile || execFile
  if (!admin.ownerPwHash && cfg.ownerInit) { admin.ownerPwHash = auth.hashPassword(cfg.ownerInit); admin.audit('system', 'owner.init', 'owner password set from the installer') }
  const thumbs = createThumbs({ ffmpeg: cfg.ffmpeg, dir: cfg.thumbDir, relaySrt: cfg.relaySrt, latencyMs: relayLatency, everySec: () => S().thumbEverySec, spawn: cfg.spawn, log: m => console.log(m) })
  const DUMMY_HASH = auth.hashPassword('not-a-real-account-' + crypto.randomBytes(8).toString('hex'))
  const loginOk = auth.throttle(8, 60000)
  const ownerLoginOk = auth.throttle(5, 60000)
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

  // Session cookies carry the epoch: "sign out everywhere" bumps it and every cookie stops working.
  const isAdmin = req => {
    const c = auth.parseCookies(req.headers.cookie).arena_portal
    const v = auth.unsign(c, cfg.secret)
    if (!v) return false
    const [kind, exp, epoch, user, ver] = v.split('|')
    if (kind !== 'admin' || !(Number(exp) > Date.now()) || Number(epoch) !== admin.epoch) return false
    if (user) { const u = admin.user(user); return !!u && String(u.ver) === ver }   // a removed account, or one whose password changed, is signed out
    return true
  }
  const sessionUser = req => {
    const v = auth.unsign(auth.parseCookies(req.headers.cookie).arena_portal, cfg.secret)
    return v ? (v.split('|')[3] || '') : ''
  }
  // An account with the admin role gets the Admin area with no second password. Anyone else (a plain
  // user, or the shared password) has to unlock it with the owner password.
  const roleOf = u => (u ? u.role || 'admin' : '')
  const accountAdmin = req => { const n = sessionUser(req); return !!n && roleOf(admin.user(n)) === 'admin' }
  const ownerCookieValid = req => {
    const v = auth.unsign(auth.parseCookies(req.headers.cookie).arena_owner, cfg.secret)
    if (!v) return 0
    const [kind, exp, epoch] = v.split('|')
    return kind === 'owner' && Number(exp) > Date.now() && Number(epoch) === admin.epoch ? Number(exp) : 0
  }
  const ownerCookie = req => auth.cookie('arena_owner', auth.sign(`owner|${Date.now() + OWNER_SEC * 1000}|${admin.epoch}`, cfg.secret), { maxAgeSec: OWNER_SEC, secure: secure(req) })
  const adminPasswordOk = pw => (admin.adminPwHash ? auth.checkPassword(pw, admin.adminPwHash) : auth.safeEqual(pw, cfg.adminPassword))
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
  const pathLatency = new Map()   // path -> the relay latency its source was configured with
  async function ensurePath(relayName) {
    const name = pathName(relayName)
    const lat = relayLatency()
    const body = {
      source: `srt://${cfg.relaySrt}?streamid=read:${relayName}&mode=caller&latency=${lat}`,
      sourceOnDemand: true, sourceOnDemandStartTimeout: '10s', sourceOnDemandCloseAfter: '15s',
    }
    const hdr = { 'Content-Type': 'application/json' }
    const r = await mtx(`/v3/config/paths/add/${encodeURIComponent(name)}`, { method: 'POST', headers: hdr, body: JSON.stringify(body) })
    if (r.ok) pathLatency.set(name, lat)
    else if (r.status === 400) {   // already configured: follow a changed relay latency setting
      if (pathLatency.get(name) !== lat) {
        const pr = await mtx(`/v3/config/paths/patch/${encodeURIComponent(name)}`, { method: 'PATCH', headers: hdr, body: JSON.stringify({ source: body.source }) })
        if (pr.ok) pathLatency.set(name, lat)
      }
    } else throw new Error(`mediamtx ${r.status}`)
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
      const name = b ? String(b.username || '').trim() : ''
      const pw = b ? String(b.password || '') : ''
      let who = ''   // '' = the shared portal password
      let ok
      if (name) {
        const u = admin.user(name)
        ok = auth.checkPassword(pw, u ? u.pwHash : DUMMY_HASH) && !!u   // checks a dummy hash for unknown names, so timing does not reveal them
        who = u ? u.username : ''
      } else ok = S().sharedLogin && adminPasswordOk(pw)
      if (!b || !ok) { admin.audit(name || 'admin', 'login.fail', name ? 'account sign-in' : 'shared password', clientIp(req)); return send(res, 401, { error: name ? 'wrong username or password' : 'wrong password' }) }
      admin.audit(who || 'admin', 'login', who ? 'account' : 'shared password', clientIp(req))
      const u2 = who ? admin.user(who) : null
      const sess = auth.sign(`admin|${Date.now() + SESSION_SEC * 1000}|${admin.epoch}|${who}|${u2 ? u2.ver : ''}`, cfg.secret)
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('arena_portal', sess, { maxAgeSec: SESSION_SEC, secure: secure(req) }) })
    }
    if (p === '/portal/api/logout' && m === 'POST') {
      res.setHeader('Set-Cookie', [auth.cookie('arena_portal', '', { maxAgeSec: 0, secure: secure(req) }), auth.cookie('arena_owner', '', { maxAgeSec: 0, secure: secure(req) })])
      return send(res, 200, { ok: true })
    }
    if (p.startsWith('/portal/api/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'sign in' })
      if (m !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'bad origin' })
      return adminApi(req, res, p, m)
    }
    send(res, 404, { error: 'not found' })
  }

  async function adminApi(req, res, p, m) {
    if (p === '/portal/api/me') {
      const s = S()
      return send(res, 200, { ok: true, user: sessionUser(req), role: roleOf(admin.user(sessionUser(req))), publicBase: publicBase(), defaultExpiryMin: s.defaultLinkExpiryMin, requireLinkPassword: s.requireLinkPassword })
    }
    if (p.startsWith('/portal/api/owner/')) return ownerApi(req, res, p, m)

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

    // Thumbnail: asking for it starts the picture worker for that stream; it stops when nobody asks.
    let tm
    if ((tm = p.match(/^\/portal\/api\/thumb\/([^/]+)$/)) && m === 'GET') {
      const e = (await encoders()).find(x => x.id === decodeURIComponent(tm[1]))
      if (!e || !e.relay || !e.relay.name || !browserOk(e) || !S().thumbnailsEnabled) { res.writeHead(204); return res.end() }
      thumbs.want(e.relay.name)
      const img = thumbs.read(e.relay.name)
      if (!img) { res.writeHead(204); return res.end() }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': img.length })
      return res.end(img)
    }
    // Live preview in the admin page: same browser playback as a share link, without making a link.
    let pm
    if ((pm = p.match(/^\/portal\/api\/whep\/([^/]+)$/)) && m === 'POST') {
      const e = (await encoders()).find(x => x.id === decodeURIComponent(pm[1]))
      if (!e) return send(res, 404, { error: 'stream is offline' })
      if (!e.relay || !e.relay.name) return send(res, 409, { error: 'this stream is not sent to the relay' })
      if (!browserOk(e)) return send(res, 415, { error: 'this stream is H.265, which browsers cannot play' })
      if (livePreviews() >= S().maxPreviews) return send(res, 429, { error: 'close another preview first' })
      return whepStart(req, res, e, sid => { previews.set(sid, Date.now()); return `/portal/api/whep/${pm[1]}/${encodeURIComponent(sid)}` })
    }
    if ((pm = p.match(/^\/portal\/api\/whep\/([^/]+)\/([^/]+)$/)) && (m === 'DELETE' || m === 'PATCH')) {
      const e = (await encoders()).find(x => x.id === decodeURIComponent(pm[1]))
      const sid = decodeURIComponent(pm[2])
      if (m === 'DELETE') previews.delete(sid)
      if (!e || !e.relay) { res.writeHead(204); return res.end() }
      const body = m === 'PATCH' ? await readBody(req, 65536) : undefined
      try {
        await fetch(`${cfg.mediamtxWebrtc}/${pathName(e.relay.name)}/whep/${encodeURIComponent(sid)}`, { method: m, headers: m === 'PATCH' ? { 'Content-Type': req.headers['content-type'] || 'application/trickle-ice-sdpfrag' } : {}, body, signal: AbortSignal.timeout(5000) })
      } catch { /* the session ends by itself when the browser goes away */ }
      res.writeHead(204); return res.end()
    }

    if (p === '/portal/api/links' && m === 'GET') {
      return send(res, 200, { links: store.links().sort((a, b) => b.createdAt - a.createdAt).map(publicLink) })
    }
    if (p === '/portal/api/links' && m === 'POST') {
      const b = await readJson(req)
      if (!b || typeof b.stream !== 'string' || !b.stream.trim()) return send(res, 400, { error: 'choose a stream' })
      const mins = b.expiresInMin === undefined ? S().defaultLinkExpiryMin : (Number(b.expiresInMin) || 0)
      if (mins < 0 || mins > 60 * 24 * 365) return send(res, 400, { error: 'bad expiry' })
      if (S().requireLinkPassword && !b.password) return send(res, 400, { error: 'links need a password (Admin settings)' })
      const l = {
        id: auth.newId(12), stream: b.stream.trim().slice(0, 128), label: String(b.label || '').trim().slice(0, 80),
        createdAt: Date.now(), expiresAt: mins ? Date.now() + mins * 60000 : 0, revoked: false,
        pwHash: b.password ? auth.hashPassword(String(b.password).slice(0, 128)) : '',
      }
      store.putLink(l)
      admin.audit('admin', 'link.create', `${l.id} ${l.stream}${l.expiresAt ? '' : ' (no expiry)'}${l.pwHash ? ' (password)' : ''}`, clientIp(req))
      return send(res, 200, { link: publicLink(l) })
    }
    let mm
    if ((mm = p.match(/^\/portal\/api\/links\/([a-z0-9]+)$/))) {
      const l = store.link(mm[1])
      if (!l) return send(res, 404, { error: 'no such link' })
      if (m === 'DELETE') { l.revoked = true; store.putLink(l); admin.audit('admin', 'link.revoke', `${l.id} ${l.stream}`, clientIp(req)); return send(res, 200, { link: publicLink(l) }) }
      if (m === 'GET') return send(res, 200, { link: publicLink(l), recent: store.views(l.id).slice(-50).reverse() })
    }

    if (p === '/portal/api/decoders' && m === 'GET') {
      try { return send(res, 200, await dir('/v1/decoders')) } catch (e) { return send(res, 502, { error: String(e.message) }) }
    }
    if ((mm = p.match(/^\/portal\/api\/decoders\/([^/]+)\/want$/)) && m === 'POST') {
      const b = await readJson(req)
      if (!b || typeof b.stream !== 'string') return send(res, 400, { error: 'stream required ("" disconnects)' })
      admin.audit('admin', 'decoder.want', `${decodeURIComponent(mm[1])} -> ${b.stream || '(disconnect)'}`, clientIp(req))
      try { return send(res, 200, await dir('/v1/decoder/want', { id: decodeURIComponent(mm[1]), stream: b.stream })) } catch (e) { return send(res, 502, { error: String(e.message) }) }
    }
    send(res, 404, { error: 'not found' })
  }

  // ── owner section ──────────────────────────────────────────────────────────
  // Needs the normal admin login plus the owner password, re-asked after 15 idle minutes.
  const exec = (cmd, args) => new Promise(resolve => {
    try { run(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? '' : String(stdout))) } catch { resolve('') }
  })
  const parseShow = text => { const o = {}; for (const l of text.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1) } return o }

  async function health() {
    const services = await Promise.all(SERVICES.map(async ([name, label]) => {
      const o = parseShow(await exec('systemctl', ['show', name + '.service', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'ActiveEnterTimestamp', '--no-pager']))
      const installed = o.LoadState && o.LoadState !== 'not-found'
      return { name, label, installed: !!installed, state: installed ? `${o.ActiveState}${o.SubState && o.SubState !== o.ActiveState ? ' (' + o.SubState + ')' : ''}` : 'not installed', active: o.ActiveState === 'active', since: o.ActiveEnterTimestamp || '' }
    }))
    const df = async mount => {
      const l = (await exec('df', ['-P', '-B1', mount])).trim().split('\n')[1]
      if (!l) return null
      const f = l.split(/\s+/)
      return { mount, total: Number(f[1]), used: Number(f[2]), free: Number(f[3]) }
    }
    const disks = (await Promise.all([df('/'), df('/var/recordings')])).filter(Boolean)
    const [list, readers] = await Promise.all([encoders(), readerCounts()])
    let mediamtx = false
    try { mediamtx = (await mtx('/v3/paths/list?itemsPerPage=1')).ok } catch { /* down */ }
    let directory = false
    try { await dir('/v1/encoders'); directory = true } catch { /* down */ }
    return {
      services, disks,
      system: { load: os.loadavg(), cpus: os.cpus().length, memTotal: os.totalmem(), memFree: os.freemem(), uptimeSec: Math.round(os.uptime()) },
      app: { directory, mediamtx, encoders: list.length, webViewers: Object.entries(readers).filter(([k]) => k.startsWith('portal_')).reduce((a, [, n]) => a + n, 0),
             thumbWorkers: thumbs.active(), previews: livePreviews() },
    }
  }

  const MIN_PW = 10
  async function ownerApi(req, res, p, m) {
    const ip = clientIp(req)
    const sub = p.slice('/portal/api/owner/'.length)

    if (sub === 'status' && m === 'GET') {
      if (accountAdmin(req)) return send(res, 200, { configured: !!admin.ownerPwHash, unlocked: true, viaAccount: true, remainingSec: 0, reauth: 'account' })
      const exp = ownerCookieValid(req)
      return send(res, 200, { configured: !!admin.ownerPwHash, unlocked: !!exp, viaAccount: false, remainingSec: exp ? Math.max(0, Math.round((exp - Date.now()) / 1000)) : 0, reauth: 'owner' })
    }
    if (sub === 'login' && m === 'POST') {
      if (!admin.ownerPwHash) return send(res, 503, { error: 'no owner password is set; see the portal README' })
      if (!ownerLoginOk(ip)) return send(res, 429, { error: 'too many attempts, wait a minute' })
      const b = await readJson(req)
      if (!b || !auth.checkPassword(String(b.password || ''), admin.ownerPwHash)) { admin.audit('owner', 'owner.login.fail', '', ip); return send(res, 401, { error: 'wrong owner password' }) }
      admin.audit('owner', 'owner.login', '', ip)
      res.setHeader('Set-Cookie', ownerCookie(req))
      return send(res, 200, { ok: true, remainingSec: OWNER_SEC })
    }
    if (sub === 'logout' && m === 'POST') {
      res.setHeader('Set-Cookie', auth.cookie('arena_owner', '', { maxAgeSec: 0, secure: secure(req) }))
      return send(res, 200, { ok: true })
    }

    // Everything below needs the owner unlock; each call keeps it alive for another 15 minutes.
    const viaAccount = accountAdmin(req)
    if (!viaAccount && !ownerCookieValid(req)) return send(res, 403, { error: 'owner password needed', locked: true })
    if (!viaAccount) res.setHeader('Set-Cookie', ownerCookie(req))   // the owner-password unlock slides; an admin account stays signed in

    if (sub === 'settings' && m === 'GET') return send(res, 200, { settings: S(), defs: SETTINGS, installed: { relayLatencyMs: cfg.relayLatencyMs, publicBase: cfg.publicBase } })
    if (sub === 'settings' && m === 'POST') {
      const b = await readJson(req)
      if (!b || typeof b.settings !== 'object') return send(res, 400, { error: 'settings required' })
      if ('sharedLogin' in b.settings && !(b.settings.sharedLogin === true || b.settings.sharedLogin === 'true') && !admin.users().length) return send(res, 400, { error: 'create an account first, or nobody could sign in' })
      let changed
      try { changed = admin.patchSettings(b.settings) } catch (e) { return send(res, 400, { error: e.message }) }
      for (const [k, v] of Object.entries(changed)) admin.audit('owner', 'settings.change', `${k}: ${JSON.stringify(v.from)} -> ${JSON.stringify(v.to)}`, ip)
      return send(res, 200, { settings: S(), changed })
    }

    if (sub === 'password' && m === 'POST') {
      const b = await readJson(req)
      if (!b || !['admin', 'owner'].includes(b.which)) return send(res, 400, { error: 'say which password' })
      const me = viaAccount ? admin.user(sessionUser(req)) : null
      if (!auth.checkPassword(String(b.current || ''), me ? me.pwHash : admin.ownerPwHash)) { admin.audit(me ? me.username : 'owner', 'account.password.fail', b.which, ip); return send(res, 401, { error: me ? 'your current password is wrong' : 'the current owner password is wrong' }) }
      const next = String(b.next || '')
      if (next.length < MIN_PW) return send(res, 400, { error: `use at least ${MIN_PW} characters` })
      if (b.which === 'owner') admin.ownerPwHash = auth.hashPassword(next); else admin.adminPwHash = auth.hashPassword(next)
      admin.bumpEpoch()   // everyone signs in again, this browser included
      admin.audit('owner', `account.password.${b.which}`, 'changed; all sessions signed out', ip)
      return send(res, 200, { ok: true, signedOut: true })
    }
    if (sub === 'users' && m === 'GET') return send(res, 200, { users: admin.users().sort((a, b) => a.username.localeCompare(b.username)), sharedLogin: S().sharedLogin })
    if (sub === 'users' && m === 'POST') {
      const b = await readJson(req)
      const name = b ? String(b.username || '').trim() : ''
      if (!USERNAME.test(name)) return send(res, 400, { error: 'username: 2 to 40 letters, digits, dot, dash, underscore or @' })
      if (admin.user(name)) return send(res, 409, { error: 'that username already exists' })
      const pw = String(b.password || '')
      if (pw.length < MIN_PW) return send(res, 400, { error: `use at least ${MIN_PW} characters` })
      const role = b.role === undefined ? 'user' : b.role
      if (!ROLES.includes(role)) return send(res, 400, { error: 'role must be admin or user' })
      admin.setUser(name, auth.hashPassword(pw), role)
      admin.audit('owner', 'account.user.create', `${name} (${role})`, ip)
      return send(res, 200, { ok: true, users: admin.users() })
    }
    let um
    if ((um = sub.match(/^users\/([^/]+)$/)) && m === 'DELETE') {
      const name = decodeURIComponent(um[1])
      if (!S().sharedLogin && admin.users().length <= 1 && admin.user(name)) return send(res, 400, { error: 'this is the last account and shared sign-in is off; turn shared sign-in on first' })
      if (!admin.deleteUser(name)) return send(res, 404, { error: 'no such user' })
      admin.audit('owner', 'account.user.delete', name, ip)
      return send(res, 200, { ok: true, users: admin.users() })
    }
    if ((um = sub.match(/^users\/([^/]+)\/role$/)) && m === 'POST') {
      const name = decodeURIComponent(um[1])
      const b = await readJson(req)
      if (!b || !ROLES.includes(b.role)) return send(res, 400, { error: 'role must be admin or user' })
      if (!admin.user(name)) return send(res, 404, { error: 'no such user' })
      admin.setRole(name, b.role)
      admin.audit('owner', 'account.user.role', `${name} -> ${b.role}`, ip)
      return send(res, 200, { ok: true, users: admin.users() })
    }
    if ((um = sub.match(/^users\/([^/]+)\/password$/)) && m === 'POST') {
      const name = decodeURIComponent(um[1])
      const u = admin.user(name)
      if (!u) return send(res, 404, { error: 'no such user' })
      const b = await readJson(req)
      const pw = String((b && b.password) || '')
      if (pw.length < MIN_PW) return send(res, 400, { error: `use at least ${MIN_PW} characters` })
      admin.setUser(u.username, auth.hashPassword(pw))
      admin.audit('owner', 'account.user.password', u.username, ip)
      return send(res, 200, { ok: true })
    }
    if (sub === 'signout-all' && m === 'POST') {
      admin.bumpEpoch(); admin.audit('owner', 'account.signout-all', '', ip)
      return send(res, 200, { ok: true, signedOut: true })
    }

    if (sub === 'health' && m === 'GET') return send(res, 200, await health())
    let sm
    if ((sm = sub.match(/^services\/([a-z0-9-]+)\/restart$/)) && m === 'POST') {
      const svc = SERVICES.find(s => s[0] === sm[1])
      if (!svc) return send(res, 404, { error: 'unknown service' })
      try {
        fs.mkdirSync(ctlDir, { recursive: true })
        fs.writeFileSync(path.join(ctlDir, 'request'), svc[0] + '\n')
      } catch (e) { return send(res, 500, { error: 'could not leave the restart request: ' + e.message }) }
      admin.audit('owner', 'service.restart', svc[0], ip)
      return send(res, 200, { ok: true, requested: svc[0] })
    }

    if (sub === 'activity' && m === 'GET') {
      const u = new URL(req.url, 'http://x')
      return send(res, 200, { entries: admin.auditList({ limit: Math.min(1000, Number(u.searchParams.get('limit')) || 200), action: u.searchParams.get('action') || '' }) })
    }
    if (sub === 'links' && m === 'GET') {
      return send(res, 200, { links: store.links().sort((a, b) => b.createdAt - a.createdAt).map(l => {
        const v = store.views(l.id)
        return { ...publicLink(l), lastView: v.length ? v[v.length - 1].at : 0, uniqueViewers: new Set(v.map(x => x.ip)).size, recent: v.slice(-10).reverse() }
      }) })
    }
    send(res, 404, { error: 'not found' })
  }

  // Browser playback of one encoder: make sure mediamtx pulls it from the relay, pass the browser's
  // WHEP offer through, and hand back the answer. `locate(sid)` records the view and builds the
  // Location the browser will use to close the session.
  async function whepStart(req, res, e, locate) {
    let name
    try { name = await ensurePath(e.relay.name) } catch { return send(res, 502, { error: 'media server unavailable' }) }
    const offer = (await readBody(req, 65536)).toString()
    let r
    try {
      r = await fetch(`${cfg.mediamtxWebrtc}/${name}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer, signal: AbortSignal.timeout(15000) })
    } catch { return send(res, 502, { error: 'media server unavailable' }) }
    const text = await r.text()
    if (r.status !== 201) return send(res, r.status === 404 ? 404 : 502, { error: 'stream is not ready yet' })
    const sid = (r.headers.get('location') || '').split('/').pop()
    res.writeHead(201, { 'Content-Type': 'application/sdp', Location: locate(sid), 'Cache-Control': 'no-store' })
    return res.end(text)
  }

  // Admin previews: a few at a time, because each one sends the full stream to the browser.
  const previews = new Map()   // session id -> started
  const livePreviews = () => { const now = Date.now(); for (const [k, t] of previews) if (now - t > 15 * 60000) previews.delete(k); return previews.size }

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
      return whepStart(req, res, e, sid => {
        store.addView({ id, at: Date.now(), ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 160) })
        admin.audit('viewer', 'link.view', `${id} ${l.stream}`, clientIp(req))
        return `/w/${id}/whep/${encodeURIComponent(sid)}`
      })
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
  server.on('close', () => { thumbs.stopAll(); admin.flush() })
  return { server, store, pathName, thumbs, admin }
}

module.exports = { createPortal, loadConfig }

if (require.main === module) {
  const cfg = loadConfig()
  const { server, store } = createPortal(cfg)
  server.listen(cfg.port, '127.0.0.1', () => console.log(`arena portal on 127.0.0.1:${cfg.port}`))
  const bye = () => { store.flush(); process.exit(0) }
  process.on('SIGTERM', bye); process.on('SIGINT', bye)
}
