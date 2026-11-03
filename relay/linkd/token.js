'use strict'
// Signed, expiring share-link tokens for SRT read access.
//
// A token is  v1.<payload>.<signature>  where payload is base64url JSON
// {s: stream name or "*", e: expiry (unix seconds, 0 = never)} and signature is
// an Ed25519 signature over "v1.<payload>".  The encoder app holds the private
// key and mints tokens; the server only ever holds the public key, which is safe
// to commit.  Nothing here needs a database, and a token can be checked offline.
const crypto = require('node:crypto')

const b64u = b => Buffer.from(b).toString('base64url')

function mint(privateKeyPem, stream, expiresAtSec) {
  const payload = b64u(JSON.stringify({ s: stream, e: expiresAtSec }))
  const sig = crypto.sign(null, Buffer.from('v1.' + payload), privateKeyPem)
  return `v1.${payload}.${b64u(sig)}`
}

// Returns {ok:true, stream, expires} or {ok:false, reason}.
function verify(publicKeyPem, token, stream, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return { ok: false, reason: 'missing' }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' }
  let sigOk = false
  try {
    sigOk = crypto.verify(null, Buffer.from(`v1.${parts[1]}`), publicKeyPem, Buffer.from(parts[2], 'base64url'))
  } catch { return { ok: false, reason: 'malformed' } }
  if (!sigOk) return { ok: false, reason: 'bad-signature' }
  let p
  try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) } catch { return { ok: false, reason: 'malformed' } }
  if (p.e && p.e < nowSec) return { ok: false, reason: 'expired' }
  if (p.s !== '*' && p.s !== stream) return { ok: false, reason: 'wrong-stream' }
  return { ok: true, stream: p.s, expires: p.e }
}

module.exports = { mint, verify }
