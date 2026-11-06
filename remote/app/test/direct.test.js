const test = require('node:test')
const assert = require('node:assert/strict')
const { WebSocket } = require('ws')
const { startDirect, proof } = require('../direct')

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const q = [], waiters = []
  ws.on('message', d => { const m = JSON.parse(d); const w = waiters.shift(); w ? w(m) : q.push(m) })
  return new Promise(r => ws.on('open', () => r({
    ws, send: m => ws.send(JSON.stringify(m)),
    next: () => new Promise(res => (q.length ? res(q.shift()) : waiters.push(res))),
    closed: new Promise(res => ws.on('close', res)),
  })))
}

test('direct pairing end to end', async () => {
  const events = []
  const p = 18951 + (process.pid % 1000)
  const d = startDirect({ pubKey: 'PUBKEY', name: 'Test PC', port: p, onMessage: m => events.push(m) })
  await d.ready
  const code = d.code
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/)

  // a wrong code is refused and never reveals the host proof
  let c = await client(p)
  let ch = await c.next()
  assert.equal(ch.pubKey, 'PUBKEY')
  c.send({ t: 'join', proof: proof('AAAAA-AAAAA', 'viewer', ch.nonce, ch.pubKey) })
  assert.equal((await c.next()).error, 'code')
  await c.closed

  // the right code: viewer proves, host proves back (bound to the key)
  c = await client(p)
  ch = await c.next()
  c.send({ t: 'join', proof: proof(code, 'viewer', ch.nonce, ch.pubKey) })
  const joined = await c.next()
  assert.equal(joined.t, 'joined')
  assert.equal(joined.proof, proof(code, 'host', ch.nonce, ch.pubKey))
  assert.notEqual(joined.proof, proof(code, 'host', ch.nonce, 'OTHERKEY'))

  // nothing reaches the host UI until the viewer says go (after its own pinning step)
  c.send({ t: 'signal', sessionId: joined.sessionId, data: { sdp: 'early' } })
  c.send({ t: 'go' })
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(events.map(e => e.t), ['request'])
  c.send({ t: 'signal', sessionId: joined.sessionId, data: { sdp: 'offer' } })
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(events.at(-1).data, { sdp: 'offer' })
  d.send({ t: 'signal', sessionId: joined.sessionId, data: { sdp: 'answer' } })
  assert.deepEqual((await c.next()).data, { sdp: 'answer' })

  // one session at a time
  const c2 = await client(p)
  const ch2 = await c2.next()
  c2.send({ t: 'join', proof: proof(code, 'viewer', ch2.nonce, ch2.pubKey) })
  assert.equal((await c2.next()).error, 'busy')

  d.send({ t: 'end', sessionId: joined.sessionId })
  assert.equal((await c.next()).t, 'ended')

  // five bad codes lock the door, even for the right code
  for (let i = 0; i < 5; i++) {
    const b = await client(p); const bc = await b.next()
    b.send({ t: 'join', proof: 'x' })
    await b.next()
  }
  const late = await client(p); const lc = await late.next()
  late.send({ t: 'join', proof: proof(code, 'viewer', lc.nonce, lc.pubKey) })
  assert.equal((await late.next()).error, 'locked')
  d.stop()
})
