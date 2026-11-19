// Standby mode: this server keeps a copy of a primary Comms server's accounts, groups and channels, so that clients
// and gateways can fall over to it (a second cloud server, or a small server inside the arena) when the primary is
// unreachable. The primary stays the one place settings are changed; a standby is read-only for admins.
//
//   cfg.standby = { primaryUrl: 'https://5.161.235.143/comms', username, password, intervalSec: 30, ca: '/path/to/server.crt' }
//
// Each pass signs in to the primary's admin API, downloads a snapshot, and adopts it. The snapshot includes the secret
// that signs session tokens, so a person who is signed in on the primary stays signed in here.

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'

/** One small HTTP(S) call that can trust a self-signed certificate (`ca`). Resolves { status, json }. */
export function request(url, { method = 'GET', headers = {}, body, ca, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = lib.request(u, {
      method, timeout: timeoutMs,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
      ...(u.protocol === 'https:' && ca ? { ca } : {}),
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export function createStandby({ cfg, dir, setSecret, log = console, onSynced = () => {} }) {
  const s = cfg.standby
  if (!s?.primaryUrl) return null
  const base = String(s.primaryUrl).replace(/\/+$/, '')
  const ca = s.ca ? (() => { try { return fs.readFileSync(s.ca) } catch (e) { log.warn?.(`[arena-comms] standby: cannot read certificate ${s.ca}: ${e.message}`); return undefined } })() : undefined
  const status = { primary: base, lastSync: 0, lastTry: 0, error: '', syncs: 0 }
  let timer = null
  let running = false

  async function syncOnce() {
    if (running) return
    running = true
    status.lastTry = Date.now()
    try {
      const login = await request(`${base}/admin/api/login`, { method: 'POST', body: { username: s.username, password: s.password }, ca })
      if (login.status !== 200 || !login.json?.token) throw new Error(login.json?.error ?? login.json?.message ?? `sign-in refused (${login.status})`)
      const snap = await request(`${base}/admin/api/export`, { headers: { authorization: `Bearer ${login.json.token}` }, ca })
      if (snap.status !== 200 || !snap.json?.data) throw new Error(`export refused (${snap.status})`)
      if (typeof snap.json.sessionSecret === 'string' && snap.json.sessionSecret) setSecret(Buffer.from(snap.json.sessionSecret, 'base64url'))
      dir.replaceFrom(snap.json.data)
      status.lastSync = Date.now()
      status.syncs++
      status.error = ''
      onSynced()
    } catch (e) {
      status.error = e.message
    } finally {
      running = false
    }
  }

  return {
    status: () => ({ ...status }),
    syncOnce,
    start() {
      void syncOnce()
      timer = setInterval(() => void syncOnce(), Math.max(5, Number(s.intervalSec) || 30) * 1000)
      timer.unref?.()
    },
    stop() { if (timer) clearInterval(timer); timer = null },
  }
}
