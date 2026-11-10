'use strict'
// Passwords, signed cookies and a tiny login throttle. Standard library only.
const crypto = require('node:crypto')

const b64u = b => Buffer.from(b).toString('base64url')

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest()
  const y = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(x, y)
}

// "s1$salt$hash" - scrypt, for link passwords kept in the data file.
function hashPassword(pw) {
  const salt = crypto.randomBytes(12).toString('base64url')
  const h = crypto.scryptSync(String(pw), salt, 32).toString('base64url')
  return `s1$${salt}$${h}`
}
function checkPassword(pw, stored) {
  const p = String(stored || '').split('$')
  if (p.length !== 3 || p[0] !== 's1') return false
  const h = crypto.scryptSync(String(pw), p[1], 32).toString('base64url')
  return safeEqual(h, p[2])
}

// value.signature - HMAC-SHA256 over the value.
function sign(value, secret) {
  return `${value}.${crypto.createHmac('sha256', secret).update(value).digest('base64url')}`
}
function unsign(signed, secret) {
  const s = String(signed || '')
  const i = s.lastIndexOf('.')
  if (i < 0) return null
  const v = s.slice(0, i)
  return safeEqual(sign(v, secret), s) ? v : null
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function cookie(name, value, { maxAgeSec, secure } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`
  if (maxAgeSec !== undefined) c += `; Max-Age=${maxAgeSec}`
  if (secure) c += '; Secure'
  return c
}

// Allows `max` attempts per `windowMs` per key; then refuses until the window passes.
function throttle(max = 8, windowMs = 60000) {
  const hits = new Map()
  return key => {
    const now = Date.now()
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs)
    if (arr.length >= max) { hits.set(key, arr); return false }
    arr.push(now); hits.set(key, arr)
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k)
    return true
  }
}

function newId(n = 12) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'   // no look-alikes
  const bytes = crypto.randomBytes(n)
  let s = ''
  for (const b of bytes) s += abc[b % abc.length]
  return s
}

module.exports = { safeEqual, hashPassword, checkPassword, sign, unsign, parseCookies, cookie, throttle, newId, b64u }
