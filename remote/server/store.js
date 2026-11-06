// Persistent state: user accounts (scrypt hashes), enrolled hosts (public keys) and one-shot enrollment codes.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const scryptAsync = (pw, salt) => new Promise((res, rej) => scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))))

export async function hashPassword(pw) {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('base64')}$${(await scryptAsync(pw, salt)).toString('base64')}`
}

export async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$')
  if (alg !== 'scrypt' || !s || !h) return false
  const want = Buffer.from(h, 'base64')
  const got = await scryptAsync(pw, Buffer.from(s, 'base64'))
  return want.length === got.length && timingSafeEqual(want, got)
}

/** A host's id is derived from its public key, so the key and the id cannot be separated. */
export function hostIdForKey(rawPubKeyB64) {
  return createHash('sha256').update(Buffer.from(rawPubKeyB64, 'base64')).digest('base64url').slice(0, 22)
}

export function createStore(file) {
  let db = { users: {}, hosts: {} }
  if (file && existsSync(file)) db = JSON.parse(readFileSync(file, 'utf8'))
  const codes = new Map() // code -> { user, exp }

  const save = () => {
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file + '.tmp', JSON.stringify(db, null, 2), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  }

  return {
    async addUser(name, password) {
      db.users[name.toLowerCase()] = { name, hash: await hashPassword(password), disabled: false }
      save()
    },
    user: name => db.users[String(name).toLowerCase()] ?? null,
    hostsOf: user => Object.entries(db.hosts).filter(([, h]) => h.owner === user).map(([id, h]) => ({ id, ...h })),
    host: id => db.hosts[id] ?? null,
    newEnrollCode(user) {
      const code = randomBytes(5).toString('hex').toUpperCase() // 40 bits, single use, 10 minutes
      codes.set(code, { user, exp: Date.now() + 10 * 60_000 })
      return code
    },
    /** Consumes the code and registers the key. Returns the host id, or null for a bad/expired code. */
    enrollHost(code, name, pubKey) {
      const c = codes.get(String(code).toUpperCase())
      codes.delete(String(code).toUpperCase())
      if (!c || c.exp < Date.now()) return null
      if (Buffer.from(pubKey, 'base64').length !== 32) return null
      const id = hostIdForKey(pubKey)
      db.hosts[id] = { owner: c.user, name: String(name).slice(0, 60), pubKey, createdAt: Date.now() }
      save()
      return id
    },
    removeHost(user, id) {
      if (db.hosts[id]?.owner !== user) return false
      delete db.hosts[id]
      save()
      return true
    },
  }
}
