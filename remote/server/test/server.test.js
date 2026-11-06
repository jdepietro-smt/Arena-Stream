import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { WebSocket } from 'ws'
import { createRemoteServer, hostAuthMessage } from '../server.js'
import { createStore } from '../store.js'

const rawPub = k => k.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')

function client(url) {
  const ws = new WebSocket(url)
  const q = [], waiters = []
  ws.on('message', d => { const m = JSON.parse(d); const w = waiters.shift(); w ? w(m) : q.push(m) })
  const next = () => new Promise(r => (q.length ? r(q.shift()) : waiters.push(r)))
  const closed = new Promise(r => ws.on('close', r))
  return new Promise(r => ws.on('open', () => r({ ws, next, closed, send: m => ws.send(JSON.stringify(m)) })))
}

async function setup() {
  const store = createStore(null)
  await store.addUser('alice', 'correct horse battery')
  const srv = createRemoteServer({ store, log: () => {} })
  const port = await srv.listen(0, '127.0.0.1')
  const base = `127.0.0.1:${port}`
  const post = (path, body, token) => fetch(`http://${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body ?? {}) }).then(async r => ({ status: r.status, body: await r.json() }))
  return { srv, base, post }
}

test('login rejects bad passwords and throttles', async () => {
  const { srv, post } = await setup()
  assert.equal((await post('/api/login', { username: 'alice', password: 'nope' })).status, 401)
  assert.equal((await post('/api/login', { username: 'alice', password: 'correct horse battery' })).status, 200)
  for (let i = 0; i < 5; i++) await post('/api/login', { username: 'alice', password: 'x' })
  assert.equal((await post('/api/login', { username: 'alice', password: 'correct horse battery' })).status, 429)
  await srv.close()
})

test('enroll host, connect viewer, relay signaling, end session', async () => {
  const { srv, base, post } = await setup()
  const { body: { token } } = await post('/api/login', { username: 'alice', password: 'correct horse battery' })
  const { body: { code } } = await post('/api/enroll-code', {}, token)

  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = rawPub(publicKey)

  // enrollment is single-use
  let h = await client(`ws://${base}/host`)
  await h.next() // challenge
  h.send({ t: 'enroll', code, name: 'Studio PC', pubKey: pub })
  const enrolled = await h.next()
  assert.equal(enrolled.t, 'enrolled')
  h.ws.close()
  const again = await client(`ws://${base}/host`)
  await again.next()
  again.send({ t: 'enroll', code, name: 'x', pubKey: pub })
  assert.equal((await again.next()).error, 'enroll')

  // host authenticates by signature; a wrong key is refused
  h = await client(`ws://${base}/host`)
  const { nonce } = await h.next()
  h.send({ t: 'hello', hostId: enrolled.hostId, sig: sign(null, hostAuthMessage(nonce), privateKey).toString('base64') })
  assert.equal((await h.next()).t, 'ready')
  const imposter = await client(`ws://${base}/host`)
  const n2 = await imposter.next()
  imposter.send({ t: 'hello', hostId: enrolled.hostId, sig: sign(null, hostAuthMessage(n2.nonce), generateKeyPairSync('ed25519').privateKey).toString('base64') })
  assert.equal((await imposter.next()).error, 'auth')

  // viewer lists and connects
  const v = await client(`ws://${base}/viewer`)
  v.send({ t: 'auth', token })
  assert.equal((await v.next()).t, 'ready')
  v.send({ t: 'list' })
  const list = await v.next()
  assert.deepEqual(list.hosts.map(x => [x.id, x.online]), [[enrolled.hostId, true]])
  v.send({ t: 'connect', hostId: enrolled.hostId })
  const req = await h.next()
  assert.equal(req.t, 'request'); assert.equal(req.user, 'alice')
  const { sessionId } = await v.next()
  v.send({ t: 'signal', sessionId, data: { sdp: 'offer' } })
  assert.deepEqual((await h.next()).data, { sdp: 'offer' })
  h.send({ t: 'signal', sessionId, data: { sdp: 'answer' } })
  assert.deepEqual((await v.next()).data, { sdp: 'answer' })
  h.send({ t: 'end', sessionId })
  assert.equal((await v.next()).t, 'ended')

  // an unauthenticated viewer is dropped
  const bad = await client(`ws://${base}/viewer`)
  bad.send({ t: 'auth', token: 'forged.token' })
  assert.equal((await bad.next()).error, 'auth')
  await srv.close()
})
