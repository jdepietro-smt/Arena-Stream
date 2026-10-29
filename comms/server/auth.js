// Password login with brute-force throttling, plus short-lived admin API tokens.

import { randomBytes } from 'node:crypto'
import { hashPasswordSync, verifyPassword } from './directory.js'

const DUMMY_HASH = hashPasswordSync('arena-comms-dummy')
const MAX_FAILS = 5
const LOCK_MS = 60_000
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000

export class AuthError extends Error {
  constructor(code, message, status = 401) { super(message); this.code = code; this.status = status }
}

export function createAuth(dir) {
  const fails = new Map() // key -> { n, until }
  const tokens = new Map() // token -> { userId, exp }

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
