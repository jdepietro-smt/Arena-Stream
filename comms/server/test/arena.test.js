import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createServer, loadConfig } from '../server.js'
import { createArenaWatcher } from '../arena.js'

/** A fake mediamtx API whose contents the test controls. */
function fakeApi() {
  const state = { paths: {}, fail: false }
  const fetchImpl = async () => {
    if (state.fail) throw new Error('connection refused')
    return { ok: true, json: async () => ({ items: Object.entries(state.paths).map(([name, p]) => ({ name, ready: true, ...p })) }) }
  }
  return { state, fetchImpl }
}
const streams = [{ path: 'cam1', name: 'Camera 1', channel: 'cam' }, { path: 'cam2', name: 'Camera 2', channel: 'cam' }]

test('watcher: silent baseline, debounced lost/restored, frozen feeds, monitor outage', async () => {
  const api = fakeApi()
  const log = []
  const w = createArenaWatcher({ apiUrl: 'http://x', streams, confirmPolls: 2, stallPolls: 3, fetchImpl: api.fetchImpl, onChange: (snap, ev) => log.push({ snap, ev }) })
  // Healthy feeds deliver more bytes every poll; the test freezes one on purpose.
  let frozen = null
  const poll = async () => {
    for (const [name, p] of Object.entries(api.state.paths)) if (name !== frozen) p.inboundBytes += 10
    await w.poll()
  }
  const events = () => log.flatMap(l => l.ev)

  api.state.paths = { cam1: { inboundBytes: 100 }, cam2: { inboundBytes: 100 } }
  await poll()
  assert.deepEqual(w.snapshot().map(s => s.state), ['live', 'live'])
  assert.equal(events().length, 0, 'first reading is a baseline, not an alert')

  // One missing poll is a blip: nothing is announced.
  delete api.state.paths.cam2
  await poll()
  api.state.paths.cam2 = { inboundBytes: 200 }
  await poll()
  assert.equal(events().length, 0)

  // Two consecutive misses: lost.
  delete api.state.paths.cam2
  await poll(); await poll()
  assert.deepEqual(log.at(-1).ev.map(e => [e.kind, e.text, e.channel]), [['lost', 'Camera 2 feed lost', 'cam']])
  assert.equal(w.snapshot()[1].state, 'down')

  // Back again: restored.
  api.state.paths.cam2 = { inboundBytes: 5 }
  await poll(); await poll()
  assert.equal(log.at(-1).ev[0].text, 'Camera 2 feed restored')

  // Ready but no bytes arriving: frozen, after stallPolls + confirmPolls.
  frozen = 'cam2'
  for (let i = 0; i < 12 && !events().some(e => e.kind === 'stalled'); i++) await poll()
  assert.ok(events().some(e => e.kind === 'stalled' && e.text === 'Camera 2 feed frozen'))
  assert.equal(w.snapshot()[0].state, 'live', 'healthy feed unaffected')
  frozen = null

  // The stream server itself unreachable: one notice after 5 failed polls, one when it returns.
  api.state.fail = true
  for (let i = 0; i < 8; i++) await w.poll()
  assert.equal(events().filter(e => e.kind === 'monitor-offline').length, 1)
  api.state.fail = false
  await poll()
  assert.equal(log.at(-1).ev[0].kind, 'monitor-online')
})

async function client(port, join) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const inbox = []; const waiters = []
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    const i = waiters.findIndex(w => w.pred(m))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m)
  })
  await new Promise(r => ws.on('open', r))
  const next = (pred = () => true, ms = 3000) => {
    const i = inbox.findIndex(pred)
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms)
      waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m) } })
    })
  }
  ws.send(JSON.stringify({ type: 'join', ...join }))
  return { ws, next, send: m => ws.send(JSON.stringify(m)), welcome: await next(m => m.type === 'welcome') }
}

test('server: stream snapshot on join; alerts only reach listeners of the stream\'s channel', async () => {
  const api = fakeApi()
  api.state.paths = { cam1: { inboundBytes: 1 }, cam2: { inboundBytes: 1 } }
  const srv = createServer({
    ...loadConfig('/nonexistent.json'), dataFile: null, auth: { mode: 'open' }, pin: '',
    arena: { apiUrl: 'http://x', pollMs: 15, confirmPolls: 2, stallPolls: 50, streams },
  }, { arenaFetch: api.fetchImpl })
  const port = await srv.listen(0)
  try {
    await new Promise(r => setTimeout(r, 120)) // baseline poll
    const cam = await client(port, { name: 'Cam Op', role: 'Camera' })
    assert.deepEqual(cam.welcome.streams.map(s => [s.id, s.state]), [['cam1', 'live'], ['cam2', 'live']])
    const mute = await client(port, { name: 'Muted', role: 'Camera' })
    mute.send({ type: 'state', talk: [], listen: ['prod'] }) // not listening to cameras
    const eng = await client(port, { name: 'Eng', role: 'Engineer' }) // no access to the stream's channel? (Engineer has cam)
    eng.send({ type: 'state', talk: [], listen: ['cam'] })
    await new Promise(r => setTimeout(r, 50))

    delete api.state.paths.cam2
    const alert = await cam.next(m => m.type === 'alert')
    assert.deepEqual([alert.text, alert.level, alert.channel, alert.stream], ['Camera 2 feed lost', 'warn', 'cam', 'cam2'])
    const snap = await cam.next(m => m.type === 'streams' && m.streams[1].state === 'down')
    assert.ok(snap)
    assert.equal((await eng.next(m => m.type === 'alert')).text, 'Camera 2 feed lost')

    api.state.paths.cam2 = { inboundBytes: 2 }
    assert.equal((await cam.next(m => m.type === 'alert')).level, 'ok')
    await new Promise(r => setTimeout(r, 100))
    // The muted client got stream snapshots but never an alert.
    let alerts = 0
    try { while (true) { await mute.next(m => m.type === 'alert', 150); alerts++ } } catch { /* timeout = none left */ }
    assert.equal(alerts, 0)
    for (const c of [cam, mute, eng]) c.ws.close()
  } finally {
    await srv.close()
  }
})
