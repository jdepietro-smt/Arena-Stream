'use strict'
// Client for the Arena Comms admin API (/admin/api/*), which runs on another server. The Portal only sends controls and
// permissions there; audio never touches it.
//
// Trust: the Comms server usually has a self-signed certificate. The connection is pinned to the exact certificate the
// owner confirmed (by its SHA-256 fingerprint): the certificate must be that one, so a different or forged certificate is
// refused. The hostname is not checked, because the certificate belongs to an IP address.
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const net = require('node:net')
const crypto = require('node:crypto')

// ── keeping the Comms admin password at rest ──────────────────────────────────
// AES-256-GCM with a key made from the portal secret. It is only to keep the password out of plain sight in the data
// file; whoever holds the portal secret can read it, as the portal itself must.
const keyFor = secret => crypto.createHash('sha256').update('arena-portal-comms|' + secret).digest()
function seal(secret, text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv)
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()])
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.')
}
function unseal(secret, blob) {
  try {
    const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'))
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), iv); d.setAuthTag(tag)
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
  } catch { return '' }
}

const pemOf = der => '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').replace(/(.{64})/g, '$1\n').trim() + '\n-----END CERTIFICATE-----\n'

function parseUrl(url) {
  let u
  try { u = new URL(String(url).trim()) } catch { throw new Error('that does not look like a web address') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('the address must start with https:// (or http://)')
  return u
}

// Reads the certificate a server presents, without trusting it, so the owner can confirm its fingerprint.
function probeCert(url) {
  return new Promise((resolve, reject) => {
    let u
    try { u = parseUrl(url) } catch (e) { return reject(e) }
    if (u.protocol !== 'https:') return resolve({ https: false })
    const s = tls.connect({ host: u.hostname, port: Number(u.port) || 443, rejectUnauthorized: false, servername: net.isIP(u.hostname) ? undefined : u.hostname, timeout: 8000 }, () => {
      const c = s.getPeerCertificate(true)
      s.end()
      if (!c || !c.raw) return reject(new Error('the server did not present a certificate'))
      resolve({ https: true, fingerprint: c.fingerprint256, subject: (c.subject && (c.subject.CN || c.subject.O)) || '', validTo: c.valid_to, pem: pemOf(c.raw) })
    })
    s.on('timeout', () => { s.destroy(); reject(new Error('no answer from the Comms server')) })
    s.on('error', e => reject(new Error('could not reach the Comms server: ' + (e.code || e.message))))
  })
}

class CommsError extends Error { constructor(message, status = 502) { super(message); this.status = status } }

// conn: { url, user, pass, pem }. `get` returns the current connection or null, so settings changes apply at once.
function createComms(get) {
  let token = '', tokenFor = ''

  function raw(conn, method, route, body, bearer) {
    return new Promise((resolve, reject) => {
      const u = parseUrl(conn.url), isHttps = u.protocol === 'https:'
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const headers = { Accept: 'application/json' }
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length }
      if (bearer) headers.Authorization = 'Bearer ' + bearer
      const opts = { hostname: u.hostname, port: Number(u.port) || (isHttps ? 443 : 80), path: u.pathname.replace(/\/$/, '') + '/admin/api/' + route, method, headers, timeout: 10000, agent: false }
      if (isHttps) Object.assign(opts, { ca: [conn.pem], rejectUnauthorized: true, checkServerIdentity: () => undefined, servername: net.isIP(u.hostname) ? undefined : u.hostname })
      const req = (isHttps ? https : http).request(opts, res => {
        const chunks = []
        res.on('data', c => { chunks.push(c); if (chunks.length > 2000) req.destroy() })
        res.on('end', () => {
          let j = {}
          try { j = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { /* not json */ }
          resolve({ status: res.statusCode, body: j })
        })
      })
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', e => reject(new CommsError(/CERT|self.signed|unable to verify|certificate/i.test(String(e.code) + e.message)
        ? 'the Comms server presented a different certificate than the one you confirmed'
        : 'could not reach the Comms server: ' + (e.code || e.message))))
      if (data) req.write(data)
      req.end()
    })
  }

  async function login(conn) {
    const r = await raw(conn, 'POST', 'login', { username: conn.user, password: conn.pass })
    if (r.status !== 200 || !r.body.token) throw new CommsError(r.status === 401 || r.status === 403 ? (r.body.error || 'the Comms admin sign-in was refused') : `the Comms server answered ${r.status}`, r.status === 429 ? 429 : r.status === 401 || r.status === 403 ? 400 : 502)
    return r.body.token
  }

  const api = {
    configured: () => !!get(),
    // Checks that a connection works before it is saved.
    async test(conn) { const t = await login(conn); await raw(conn, 'POST', 'logout', undefined, t).catch(() => {}); return true },
    async call(method, route, body) {
      const conn = get()
      if (!conn) throw new CommsError('Comms is not connected yet', 409)
      const id = conn.url + '|' + conn.user
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!token || tokenFor !== id) { token = await login(conn); tokenFor = id }
        const r = await raw(conn, method, route, body, token)
        if (r.status === 401) { token = ''; continue }
        if (r.status >= 400) throw new CommsError(r.body.error || `the Comms server answered ${r.status}`, r.status >= 500 ? 502 : r.status)
        return r.body
      }
      throw new CommsError('the Comms server would not accept the admin sign-in', 502)
    },
    forget() { token = ''; tokenFor = '' },
  }
  return api
}

module.exports = { createComms, probeCert, seal, unseal, CommsError, parseUrl }
