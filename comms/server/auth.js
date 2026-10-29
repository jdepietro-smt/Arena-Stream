// Password login with brute-force throttling, plus short-lived admin API tokens.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hashPasswordSync, verifyPassword } from './directory.js'

const DUMMY_HASH = hashPasswordSync('arena-comms-dummy')
const MAX_FAILS = 5
const LOCK_MS = 60_000
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

export class AuthError extends Error {
  constructor(code, message, status = 401) { super(message); this.code = code; this.status = status }
}

export function createAuth(dir, { secret = randomBytes(32) } = {}) {
  const fails = new Map() // key -> { n, until }
  const tokens = new Map() // token -> { userId, exp }

  // Client sessions are stateless signed tokens, so they survive a page reload and a server restart
  // (given a persisted secret). Changing the password invalidates them: the token carries a tag of it.
  const pwTag = user => createHash('sha256').update(user.passwordHash ?? '').digest('base64url').slice(0, 10)
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url')

  async function authenticate(username, password, key) {
    const f = fails.get(key)
    if (f && f.until > Date.now()) throw new AuthError('throttled', 'Too many attempts — wait a minute and try again', 429)
    const user = dir.userByName(username)
    // Always run a hash so response time doesn't reveal whether the username exists.
    const ok = await verifyPassword(password ?? '', user?.passwordHash ?? DUMMY_HASH)
    if (!user || !ok || user.disabled) {
      const n = (f && f.until <= Date.now() && f.n < MAX_FAILS ? f.n : 0) + 1
      fails.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 })
      throw new AuthError('bad-login', 'Wrong username or password')
    }
    fails.delete(key)
    return user
  }

  return {
    authenticate,
    /** A token a browser can keep to rejoin without the password. Valid 14 days, renewed at each use. */
    issueSession(user) {
      const payload = Buffer.from(JSON.stringify({ u: user.id, e: Date.now() + SESSION_TTL_MS, p: pwTag(user) })).toString('base64url')
      return `${payload}.${sign(payload)}`
    },
    /** The user a session token belongs to, or null: bad signature, expired, password changed, disabled or removed. */
    userForSession(token) {
      const [payload, sig] = String(token ?? '').split('.')
      if (!payload || !sig) return null
      const want = Buffer.from(sign(payload))
      const got = Buffer.from(sig)
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null
      let d
      try { d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return null }
      if (!d || typeof d.e !== 'number' || d.e < Date.now()) return null
      const u = dir.user(d.u)
      return u && !u.disabled && d.p === pwTag(u) ? u : null
    },
    issueToken(user) {
      const token = randomBytes(24).toString('base64url')
      tokens.set(token, { userId: user.id, exp: Date.now() + TOKEN_TTL_MS })
      return token
    },
    /** The admin user behind a Bearer token, or null. Re-checked against the directory on every call. */
    adminForToken(token) {
      const t = tokens.get(token)
      if (!t || t.exp < Date.now()) { tokens.delete(token); return null }
      const u = dir.user(t.userId)
      return u && u.admin && !u.disabled ? u : null
    },
    revoke(token) { tokens.delete(token) },
  }
}
