'use strict'
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const { mint, verify } = require('../token')
process.env.LINKD_PUBKEY = require('node:path').join(__dirname, '..', 'public-key.pem')
const { decide } = require('../linkd')

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const pub = publicKey.export({ type: 'spki', format: 'pem' })
const prv = privateKey.export({ type: 'pkcs8', format: 'pem' })
const NOW = 1_000_000

test('valid token for its stream', () => {
  assert.ok(verify(pub, mint(prv, 'ESPN', NOW + 60), 'ESPN', NOW).ok)
})
test('wildcard token works for any stream', () => {
  assert.ok(verify(pub, mint(prv, '*', NOW + 60), 'NHL', NOW).ok)
})
test('expired token refused', () => {
  assert.equal(verify(pub, mint(prv, 'ESPN', NOW - 1), 'ESPN', NOW).reason, 'expired')
})
test('never-expiring token (e=0) accepted', () => {
  assert.ok(verify(pub, mint(prv, 'ESPN', 0), 'ESPN', NOW).ok)
})
test('token for a different stream refused', () => {
  assert.equal(verify(pub, mint(prv, 'ESPN', NOW + 60), 'NHL', NOW).reason, 'wrong-stream')
})
test('tampered payload refused', () => {
  const [v, p, s] = mint(prv, 'ESPN', NOW + 60).split('.')
  const forged = Buffer.from(JSON.stringify({ s: '*', e: 0 })).toString('base64url')
  assert.equal(verify(pub, [v, forged, s].join('.'), 'NHL', NOW).reason, 'bad-signature')
})
test('token signed by another key refused', () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
  assert.equal(verify(pub, mint(other, 'ESPN', NOW + 60), 'ESPN', NOW).reason, 'bad-signature')
})
test('garbage refused', () => {
  for (const t of ['', 'x', 'v1.a', 'v2.a.b', undefined]) assert.equal(verify(pub, t, 'ESPN', NOW).ok, false)
})

const read = (extra) => ({ action: 'read', ip: '203.0.113.9', path: 'ESPN', ...extra })
test('hook: publish always allowed', () => {
  assert.ok(decide({ action: 'publish', ip: '203.0.113.9', path: 'ESPN' }, NOW, pub, true).allow)
})
test('hook: localhost read allowed with no token', () => {
  assert.ok(decide(read({ ip: '127.0.0.1' }), NOW, pub, true).allow)
})
test('hook: remote read without token denied when enforcing', () => {
  assert.equal(decide(read({}), NOW, pub, true).allow, false)
})
test('hook: remote read without token allowed when not enforcing', () => {
  assert.ok(decide(read({}), NOW, pub, false).allow)
})
test('hook: remote read with valid token allowed when enforcing', () => {
  assert.ok(decide(read({ user: 'link', password: mint(prv, 'ESPN', NOW + 60) }), NOW, pub, true).allow)
})
test('hook: remote api access denied', () => {
  assert.equal(decide({ action: 'api', ip: '203.0.113.9', path: '' }, NOW, pub, true).allow, false)
})
