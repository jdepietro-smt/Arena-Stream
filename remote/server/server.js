// Arena Remote server: login, host enrollment and WebRTC signaling relay.
// It never sees video, audio or input: media flows peer-to-peer (or via TURN, still end-to-end DTLS-SRTP).
// Hosts authenticate with an Ed25519 challenge; viewers with a signed session token.

import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'
import { createServer as createHttp } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createStore, hostIdForKey, verifyPassword } from './store.js'

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000
const MAX_FAILS = 5
const LOCK_MS = 60_000
// DER prefix that wraps a raw 32-byte Ed25519 public key into SPKI.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export const hostAuthMessage = nonce => Buffer.from(`arena-remote-host-auth|${nonce}`)
export const publicKeyFromRaw = b64 => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' })

export function createRemoteServer({ store, secret = randomBytes(32), ice = {}, tls, log = console.log } = {}) {
  const sign = p => createHmac('sha256', secret).update(p).digest('base64url')
  const fails = new Map()
  const hosts = new Map() // hostId -> { ws, name }
  const sessions = new Map() // sessionId -> { hostId, user, viewer: ws, host: ws }

  const issueToken = user => {
    const p = Buffer.from(JSON.stringify({ u: user, e: Date.now() + TOKEN_TTL_MS })).toString('base64url')
    return `${p}.${sign(p)}`
  }
  const userForToken = token => {
    const [p, s] = String(token ?? '').split('.')
    if (!p || !s) return null
    const a = Buffer.from(sign(p)), b = Buffer.from(s)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    try {
      const d = JSON.parse(Buffer.from(p, 'base64url').toString())
      const u = store.user(d.u)
      return d.e > Date.now() && u && !u.disabled ? u : null
    } catch { return null }
  }

  async function login(name, password, key) {
    const f = fails.get(key)
    if (f && f.until > Date.now()) return { status: 429, error: 'Too many attempts — wait a minute' }
    const u = store.user(name)
    const ok = u ? await verifyPassword(String(password ?? ''), u.hash) : (await verifyPassword('x', 'scrypt$AAAA$AAAA'), false)
    if (!u || !ok || u.disabled) {
      const n = (f && f.until <= Date.now() && f.n < MAX_FAILS ? f.n : 0) + 1
      fails.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 })
      return { status: 401, error: 'Wrong username or password' }
    }
    fails.delete(key)
    return { status: 200, token: issueToken(u.name), user: u.name }
  }

  /** STUN plus, when a coturn shared secret is configured, short-lived TURN credentials. */
  function iceServers(user) {
    const out = (ice.stun ?? ['stun:stun.l.google.com:19302']).map(urls => ({ urls }))
    if (ice.turn?.urls && ice.turn.secret) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${user}`
      const credential = createHmac('sha1', ice.turn.secret).update(username).digest('base64')
      out.push({ urls: ice.turn.urls, username, credential })
    }
    return out
  }

  const readBody = req => new Promise((res, rej) => {
    let n = 0; const chunks = []
    req.on('data', c => { n += c.length; if (n > 8192) { rej(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { res(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch (e) { rej(e) } })
  })
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }

  const handler = async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/login') {
        const b = await readBody(req)
        const r = await login(b.username, b.password, req.socket.remoteAddress)
        return json(res, r.status, r.error ? { error: r.error } : { token: r.token, user: r.user })
      }
      if (req.method === 'POST' && req.url === '/api/enroll-code') {
        const u = userForToken((req.headers.authorization ?? '').replace(/^Bearer /, ''))
        if (!u) return json(res, 401, { error: 'Not signed in' })
        return json(res, 200, { code: store.newEnrollCode(u.name) })
      }
      json(res, 404, { error: 'not found' })
    } catch { json(res, 400, { error: 'bad request' }) }
  }

  const httpServer = tls ? createHttps(tls, handler) : createHttp(handler)
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 })
  const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m))

  function endSession(id, reason) {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    send(s.viewer, { t: 'ended', sessionId: id, reason })
    send(s.host, { t: 'ended', sessionId: id, reason })
    log(`session ${id} ended (${reason})`)
  }

  wss.on('connection', (ws, req) => {
    ws.alive = true
    ws.on('pong', () => { ws.alive = true })
    const role = req.url === '/host' ? 'host' : req.url === '/viewer' ? 'viewer' : null
    if (!role) return ws.close()
    const nonce = randomBytes(24).toString('base64url')
    let me = null // { user } for viewers, { hostId, owner } for hosts
    const authTimer = setTimeout(() => ws.close(), 10_000)
    if (role === 'host') send(ws, { t: 'challenge', nonce })

    ws.on('message', raw => {
      let m
      try { m = JSON.parse(raw) } catch { return ws.close() }

      if (!me) {
        if (role === 'viewer' && m.t === 'auth') {
          const u = userForToken(m.token)
          if (!u) return send(ws, { t: 'error', error: 'auth' }), ws.close()
          me = { user: u.name }
          clearTimeout(authTimer)
          return send(ws, { t: 'ready', user: u.name, ice: iceServers(u.name) })
        }
        if (role === 'host' && m.t === 'enroll') {
          const id = store.enrollHost(m.code, m.name, m.pubKey)
          if (!id) return send(ws, { t: 'error', error: 'enroll' }), ws.close()
          return send(ws, { t: 'enrolled', hostId: id })
        }
        if (role === 'host' && m.t === 'hello') {
          const h = store.host(m.hostId)
          let ok = false
          try { ok = !!h && hostIdForKey(h.pubKey) === m.hostId && verify(null, hostAuthMessage(nonce), publicKeyFromRaw(h.pubKey), Buffer.from(m.sig, 'base64')) } catch {}
          if (!ok) return send(ws, { t: 'error', error: 'auth' }), ws.close()
          me = { hostId: m.hostId, owner: h.owner }
          clearTimeout(authTimer)
          hosts.get(m.hostId)?.ws.close() // one live connection per host
          hosts.set(m.hostId, { ws, name: h.name })
          return send(ws, { t: 'ready', ice: iceServers(h.owner) })
        }
        return ws.close()
      }

      if (role === 'viewer') {
        if (m.t === 'list') {
          return send(ws, { t: 'hosts', hosts: store.hostsOf(me.user).map(h => ({ id: h.id, name: h.name, pubKey: h.pubKey, online: hosts.has(h.id) })) })
        }
        if (m.t === 'connect') {
          const h = store.host(m.hostId)
          const live = hosts.get(m.hostId)
          if (!h || h.owner !== me.user || !live) return send(ws, { t: 'error', error: 'unavailable' })
          const sessionId = randomBytes(12).toString('base64url')
          sessions.set(sessionId, { hostId: m.hostId, user: me.user, viewer: ws, host: live.ws })
          log(`session ${sessionId}: ${me.user} -> ${h.name}`)
          send(live.ws, { t: 'request', sessionId, user: me.user })
          return send(ws, { t: 'session', sessionId })
        }
      }

      if (m.t === 'signal' || m.t === 'end') {
        const s = sessions.get(m.sessionId)
        if (!s || (ws !== s.viewer && ws !== s.host)) return
        if (m.t === 'end') return endSession(m.sessionId, 'closed')
        // Opaque relay of SDP/ICE; bounded so it cannot be used as a data pipe.
        if (JSON.stringify(m.data ?? '').length > 32_000) return
        return send(ws === s.viewer ? s.host : s.viewer, { t: 'signal', sessionId: m.sessionId, data: m.data })
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      if (me?.hostId && hosts.get(me.hostId)?.ws === ws) hosts.delete(me.hostId)
      for (const [id, s] of sessions) if (s.viewer === ws || s.host === ws) endSession(id, 'peer-left')
    })
  })

  const heartbeat = setInterval(() => {
    for (const c of wss.clients) { if (!c.alive) c.terminate(); else { c.alive = false; c.ping() } }
  }, 15_000)
  heartbeat.unref()

  return {
    store,
    listen: (port, host) => new Promise(res => httpServer.listen(port, host, () => res(httpServer.address().port))),
    close: () => new Promise(res => { clearInterval(heartbeat); for (const c of wss.clients) c.terminate(); wss.close(() => httpServer.close(res)) }),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataFile = process.env.REMOTE_DATA ?? new URL('./data/remote.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const store = createStore(dataFile)
  const [cmd, name, pw] = process.argv.slice(2)
  if (cmd === 'add-user') {
    if (!name || !pw || pw.length < 10) { console.error('usage: node server.js add-user <name> <password (10+ chars)>'); process.exit(1) }
    await store.addUser(name, pw)
    console.log(`user ${name} saved`)
  } else {
    const tls = process.env.REMOTE_TLS_CERT ? { cert: readFileSync(process.env.REMOTE_TLS_CERT), key: readFileSync(process.env.REMOTE_TLS_KEY) } : undefined
    const turn = process.env.REMOTE_TURN_URLS ? { urls: process.env.REMOTE_TURN_URLS.split(','), secret: process.env.REMOTE_TURN_SECRET } : undefined
    const secret = process.env.REMOTE_SECRET ? Buffer.from(process.env.REMOTE_SECRET) : undefined
    const srv = createRemoteServer({ store, tls, secret, ice: { turn } })
    const port = await srv.listen(Number(process.env.REMOTE_PORT ?? 8950), process.env.REMOTE_HOST ?? '0.0.0.0')
    console.log(`Arena Remote server on ${tls ? 'wss/https' : 'ws/http (put TLS in front for anything beyond a trusted LAN)'} :${port}`)
  }
}
