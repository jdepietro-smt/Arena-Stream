import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createServer, loadConfig } from '../server.js'

const cfg = { ...loadConfig('/nonexistent.json'), dataFile: null, auth: { mode: 'open' }, pin: 'sekret' }

async function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const inbox = []
  const waiters = []
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    const i = waiters.findIndex(w => w.pred(m))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
    else inbox.push(m)
  })
  await new Promise(r => ws.on('open', r))
  const next = (pred = () => true) => {
    const i = inbox.findIndex(pred)
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
    return new Promise(resolve => waiters.push({ pred, resolve }))
  }
  return { ws, next, send: m => ws.send(JSON.stringify(m)) }
}

test('join, state, signal relay, call, leave', async () => {
  const srv = createServer(cfg)
  const port = await srv.listen(0)
  try {
    const a = await client(port)
    a.send({ type: 'join', name: 'Alice', role: 'Director', pin: 'sekret' })
    const wa = await a.next(m => m.type === 'welcome')
    assert.equal(wa.peers.length, 0)
    assert.ok(wa.channels.some(c => c.id === 'talent'))

    const b = await client(port)
    b.send({ type: 'join', name: 'Bob', role: 'Camera', pin: 'sekret' })
    const wb = await b.next(m => m.type === 'welcome')
    assert.equal(wb.peers[0].name, 'Alice')
    assert.ok(!wb.channels.some(c => c.id === 'talent'), 'role-restricted channel hidden')
    assert.equal((await a.next(m => m.type === 'peer-join')).peer.name, 'Bob')

    // state is sanitised against the role's channel access
    b.send({ type: 'state', talk: ['cam', 'talent'], listen: ['cam', 'talent'] })
    const st = await a.next(m => m.type === 'peer-state')
    assert.deepEqual(st.talk, ['cam'])
    assert.deepEqual(st.listen, ['cam'])

    // direct-call target must be a live peer
    b.send({ type: 'state', talk: ['u:' + wa.id, 'u:nobody'], listen: ['cam'] })
    assert.deepEqual((await a.next(m => m.type === 'peer-state')).talk, ['u:' + wa.id])

    a.send({ type: 'signal', to: wb.id, data: { sdp: 'x' } })
    const sig = await b.next(m => m.type === 'signal')
    assert.equal(sig.from, wa.id)
    assert.deepEqual(sig.data, { sdp: 'x' })

    a.send({ type: 'call', channel: 'cam' })
    assert.equal((await b.next(m => m.type === 'call')).channel, 'cam')

    b.ws.close()
    assert.equal((await a.next(m => m.type === 'peer-leave')).id, wb.id)
    a.ws.close()
  } finally {
    await srv.close()
  }
})

test('program feed and IFB flag are delivered per role', async () => {
  const srv = createServer({
    ...cfg, pin: '',
    program: { name: 'PGM', whepUrl: 'http://x/pgm/whep', roles: ['Talent'] },
  })
  const port = await srv.listen(0)
  try {
    const t = await client(port)
    t.send({ type: 'join', name: 'Tina', role: 'Talent' })
    const wt = await t.next(m => m.type === 'welcome')
    assert.deepEqual(wt.program, { name: 'PGM', whepUrl: 'http://x/pgm/whep' })
    assert.equal(wt.channels.find(c => c.id === 'talent').ifb, true)

    const g = await client(port)
    g.send({ type: 'join', name: 'Gus', role: 'Guest' })
    assert.equal((await g.next(m => m.type === 'welcome')).program, null)
    t.ws.close(); g.ws.close()
  } finally {
    await srv.close()
  }
})

test('wrong pin is rejected', async () => {
  const srv = createServer(cfg)
  const port = await srv.listen(0)
  try {
    const c = await client(port)
    c.send({ type: 'join', name: 'Eve', role: 'Guest', pin: 'nope' })
    const err = await c.next(m => m.type === 'error')
    assert.equal(err.code, 'bad-pin')
    assert.equal(srv.peers.size, 0)
  } finally {
    await srv.close()
  }
})

test('SFU: subscriptions follow channel listen, roles and direct calls', async () => {
  const subs = new Map() // identity -> Set(sid)
  const tracksBy = new Map()
  const fake = {
    url: 'ws://sfu',
    token: async p => `tok-${p.name}`,
    listTracks: async id => tracksBy.get(id) ?? [],
    updateSubscriptions: async (id, sids, on) => {
      const set = subs.get(id) ?? new Set()
      for (const s of sids) on ? set.add(s) : set.delete(s)
      subs.set(id, set)
    },
  }
  const srv = createServer({ ...cfg, pin: '' }, { sfu: fake })
  const port = await srv.listen(0)
  const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) }
    assert.fail(`timed out: ${what}`)
  }
  const has = (id, sid) => subs.get(id)?.has(sid) ?? false
  try {
    const mk = async (name, role) => {
      const c = await client(port)
      c.send({ type: 'join', name, role })
      const w = await c.next(m => m.type === 'welcome')
      assert.equal(w.media, 'sfu')
      assert.deepEqual(w.livekit, { url: 'ws://sfu', token: `tok-${name}` })
      return { c, id: w.id }
    }
    const A = await mk('Alice', 'Director')
    const B = await mk('Bob', 'Camera')
    const C = await mk('Carl', 'Camera')
    tracksBy.set(A.id, [
      { name: 'ch:cam', sid: 'A-cam' }, { name: 'ch:talent', sid: 'A-talent' }, { name: 'direct', sid: 'A-direct' },
    ])
    A.c.send({ type: 'tracks' })

    await until(() => has(B.id, 'A-cam') && has(C.id, 'A-cam'), 'cam track forwarded to listeners')
    assert.ok(!has(B.id, 'A-talent'), 'Camera role never gets the Talent IFB track')
    assert.ok(!has(B.id, 'A-direct'), 'direct track not forwarded without a direct call')
    assert.ok(!has(A.id, 'A-cam'), 'never subscribed to own track')

    C.c.send({ type: 'state', talk: [], listen: [] })
    await until(() => !has(C.id, 'A-cam'), 'muting a channel unsubscribes it')
    assert.ok(has(B.id, 'A-cam'))

    A.c.send({ type: 'state', talk: ['u:' + B.id], listen: ['cam', 'prod', 'eng', 'audio', 'gfx', 'talent'] })
    await until(() => has(B.id, 'A-direct'), 'direct call forwards to target')
    assert.ok(!has(C.id, 'A-direct'), 'direct call not forwarded to others')

    A.c.send({ type: 'state', talk: [], listen: [] })
    await until(() => !has(B.id, 'A-direct'), 'ending the direct call unsubscribes')
    for (const x of [A, B, C]) x.c.ws.close()
  } finally {
    await srv.close()
  }
})

test('music feed: only sender roles publish it; listeners are subscribed only while it is on', async () => {
  const subs = new Map()
  const tracksBy = new Map()
  const fake = {
    url: 'ws://sfu',
    token: async p => `tok-${p.name}`,
    listTracks: async id => tracksBy.get(id) ?? [],
    updateSubscriptions: async (id, sids, on) => {
      const set = subs.get(id) ?? new Set()
      for (const s of sids) on ? set.add(s) : set.delete(s)
      subs.set(id, set)
    },
  }
  const srv = createServer({ ...cfg, pin: '', music: { senderRoles: ['Audio'], listenRoles: ['Audio', 'Camera', 'Director'] } }, { sfu: fake })
  const port = await srv.listen(0)
  const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) }
    assert.fail(`timed out: ${what}`)
  }
  const has = (id, sid) => subs.get(id)?.has(sid) ?? false
  try {
    const mk = async (name, role) => {
      const c = await client(port)
      c.send({ type: 'join', name, role })
      const w = await c.next(m => m.type === 'welcome')
      return { c, id: w.id, welcome: w }
    }
    const A1 = await mk('Ann', 'Audio')
    const cam = await mk('Bob', 'Camera')
    const talent = await mk('Tia', 'Talent')
    assert.deepEqual([A1.welcome.music.canSend, A1.welcome.music.canHear], [true, true])
    assert.deepEqual([cam.welcome.music.canSend, cam.welcome.music.canHear], [false, true])
    assert.equal(talent.welcome.music, null, 'a role outside listenRoles is not offered the feed')

    tracksBy.set(A1.id, [{ name: 'music', sid: 'A-music' }])
    A1.c.send({ type: 'tracks' })
    await new Promise(r => setTimeout(r, 80))
    assert.ok(!has(cam.id, 'A-music'), 'published but switched off: nobody receives it')

    A1.c.send({ type: 'music', on: true })
    const notice = await cam.c.next(m => m.type === 'music')
    assert.deepEqual([notice.id, notice.name, notice.on], [A1.id, 'Ann', true])
    await until(() => has(cam.id, 'A-music'), 'listener subscribed once the sender turns it on')
    assert.ok(!has(talent.id, 'A-music'), 'role outside listenRoles never receives it')
    assert.ok(!has(A1.id, 'A-music'), 'never subscribed to own track')

    // A non-sender cannot switch a music feed on, even if it publishes a track with that name.
    tracksBy.set(cam.id, [{ name: 'music', sid: 'C-music' }])
    cam.c.send({ type: 'tracks' })
    cam.c.send({ type: 'music', on: true })
    await new Promise(r => setTimeout(r, 120))
    assert.ok(!has(A1.id, 'C-music'), 'non-sender music is never forwarded')

    // Someone joining later is told who is sending.
    const late = await mk('Dee', 'Director')
    assert.deepEqual(late.welcome.music.senders, [{ id: A1.id, name: 'Ann' }])

    A1.c.send({ type: 'music', on: false })
    await until(() => !has(cam.id, 'A-music'), 'turning it off unsubscribes listeners')
    for (const x of [A1, cam, talent, late]) x.c.ws.close()
  } finally {
    await srv.close()
  }
})
