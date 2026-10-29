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

test('music channel: grants decide who sends and hears; subscribed only while a sender has it on', async () => {
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
  const srv = createServer({ ...cfg, pin: '' }, { sfu: fake })
  const port = await srv.listen(0)
  const dir = srv.directory
  const mus = dir.addChannel({ name: 'MUSIC', music: true, ifb: true })
  assert.ok(mus.music && !mus.ifb, 'a music channel is never an IFB')
  const grant = (group, g) => {
    const grp = dir.groups.find(x => x.name === group)
    dir.updateGroup(grp.id, { grants: { ...grp.grants, [mus.id]: g } })
  }
  grant('Audio', { talk: true, listen: true })
  grant('Camera', { listen: true })
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
    const chan = w => w.channels.find(c => c.id === mus.id)
    assert.deepEqual([chan(A1.welcome).canTalk, chan(A1.welcome).canListen, chan(A1.welcome).music], [true, true, true])
    assert.deepEqual([chan(cam.welcome).canTalk, chan(cam.welcome).canListen], [false, true])
    assert.equal(chan(talent.welcome), undefined, 'a role with no grant never sees the channel')

    tracksBy.set(A1.id, [{ name: `music:${mus.id}`, sid: 'A-music' }])
    A1.c.send({ type: 'tracks' })
    await new Promise(r => setTimeout(r, 80))
    assert.ok(!has(cam.id, 'A-music'), 'published but switched off: nobody receives it')

    A1.c.send({ type: 'music', channel: mus.id, on: true })
    const notice = await cam.c.next(m => m.type === 'music')
    assert.deepEqual([notice.channel, notice.id, notice.name, notice.on], [mus.id, A1.id, 'Ann', true])
    await until(() => has(cam.id, 'A-music'), 'listener subscribed once the sender turns it on')
    assert.ok(!has(talent.id, 'A-music'), 'role without a grant never receives it')
    assert.ok(!has(A1.id, 'A-music'), 'never subscribed to own track')

    // Muting the channel (listen off) unsubscribes, like any channel.
    cam.c.send({ type: 'state', talk: [], listen: [] })
    await until(() => !has(cam.id, 'A-music'), 'listen off unsubscribes')
    cam.c.send({ type: 'state', talk: [], listen: [mus.id] })
    await until(() => has(cam.id, 'A-music'), 'listen on subscribes again')

    // Someone without talk on it cannot switch it on, even by publishing a track with that name.
    tracksBy.set(cam.id, [{ name: `music:${mus.id}`, sid: 'C-music' }])
    cam.c.send({ type: 'tracks' })
    cam.c.send({ type: 'music', channel: mus.id, on: true })
    await new Promise(r => setTimeout(r, 120))
    assert.ok(!has(A1.id, 'C-music'), 'non-sender music is never forwarded')

    // Talk state can never name a music channel.
    A1.c.send({ type: 'state', talk: [mus.id], listen: [mus.id] })
    const st = await cam.c.next(m => m.type === 'peer-state' && m.id === A1.id)
    assert.deepEqual(st.talk, [])

    // Someone joining later is told who is sending.
    const late = await mk('Dee', 'Audio')
    assert.deepEqual(late.welcome.musicSenders, [{ channel: mus.id, id: A1.id, name: 'Ann' }])

    // Taking away the sender's talk right switches the music off for everyone.
    grant('Audio', { listen: true })
    await until(() => !has(cam.id, 'A-music'), 'revoking talk stops the music')
    for (const x of [A1, cam, talent, late]) x.c.ws.close()
  } finally {
    await srv.close()
  }
})

test('music stream: URL stays on the server, relayed only to a key holder with Talk on the channel', async () => {
  const http = await import('node:http')
  const radio = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end('FAKE-RADIO-BYTES')
  })
  await new Promise(r => radio.listen(0, '127.0.0.1', r))
  const radioUrl = `http://127.0.0.1:${radio.address().port}/live.mp3`
  const fake = { url: 'ws://sfu', token: async () => 't', listTracks: async () => [], updateSubscriptions: async () => {} }
  const srv = createServer({ ...cfg, pin: '' }, { sfu: fake })
  const port = await srv.listen(0)
  const dir = srv.directory
  assert.throws(() => dir.addChannel({ name: 'Bad', music: true, source: 'ftp://x/y' }), /http/)
  assert.equal(dir.addChannel({ name: 'Plain', source: radioUrl }).source, undefined, 'only music channels keep a stream URL')
  const mus = dir.addChannel({ name: 'Radio', music: true, source: radioUrl })
  assert.equal(mus.source, radioUrl)
  const grant = (group, g) => {
    const grp = dir.groups.find(x => x.name === group)
    dir.updateGroup(grp.id, { grants: { ...grp.grants, [mus.id]: g } })
  }
  grant('Audio', { talk: true, listen: true })
  grant('Camera', { listen: true })
  try {
    const mk = async (name, role) => {
      const c = await client(port)
      c.send({ type: 'join', name, role })
      const w = await c.next(m => m.type === 'welcome')
      return { c, w }
    }
    const A1 = await mk('Ann', 'Audio')
    const cam = await mk('Bob', 'Camera')
    const ch = A1.w.channels.find(c => c.id === mus.id)
    assert.equal(ch.stream, true)
    assert.equal(JSON.stringify(A1.w).includes('live.mp3'), false, 'the URL is never sent to a client')
    assert.ok(A1.w.musicKey && A1.w.musicKey !== cam.w.musicKey)

    const get = k => fetch(`http://127.0.0.1:${port}/music/${mus.id}${k === undefined ? '' : `?k=${k}`}`)
    const ok = await get(A1.w.musicKey)
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'audio/mpeg')
    assert.equal(await ok.text(), 'FAKE-RADIO-BYTES')
    assert.equal((await get('nope')).status, 403, 'unknown key')
    assert.equal((await get()).status, 403, 'no key')
    assert.equal((await get(cam.w.musicKey)).status, 404, 'listen-only user cannot pull the sender stream')
    assert.equal((await fetch(`http://127.0.0.1:${port}/music/prod?k=${A1.w.musicKey}`)).status, 404, 'channel without a stream')
    for (const x of [A1, cam]) x.c.ws.close()
  } finally {
    await srv.close()
    await new Promise(r => radio.close(r))
  }
})

test('music channel: a service page link is kept as a player link; duck settings are kept only where they apply', async () => {
  const srv = createServer({ ...cfg, pin: '' }, { sfu: { url: 'ws://sfu', token: async () => 't', listTracks: async () => [], updateSubscriptions: async () => {} } })
  const dir = srv.directory
  for (const page of ['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://open.spotify.com/track/x', 'https://music.apple.com/us/album/x', 'https://soundcloud.com/a/b']) {
    const c = dir.addChannel({ name: 'Radio' + Math.random().toString(36).slice(2, 6), music: true, source: page })
    assert.deepEqual([c.link, c.source], [page, undefined], page + ' is a player link, not a stream')
    dir.deleteChannel(c.id)
  }
  assert.throws(() => dir.addChannel({ name: 'Bad', music: true, source: 'ftp://x/y' }), /http/)
  const st = dir.addChannel({ name: 'Station', music: true, source: 'https://radio.example.com/live.mp3' })
  assert.deepEqual([st.source, st.link], ['https://radio.example.com/live.mp3', undefined])
  // Editing the one field re-sorts it: stream -> player link -> stream -> cleared.
  assert.deepEqual([dir.updateChannel(st.id, { source: 'https://youtu.be/xyz' }).link, dir.channel(st.id).source], ['https://youtu.be/xyz', undefined])
  assert.equal(dir.updateChannel(st.id, { name: 'Station2' }).link, 'https://youtu.be/xyz', 'unrelated edits keep the link')
  assert.deepEqual([dir.updateChannel(st.id, { source: 'https://radio.example.com/b.mp3' }).source, dir.channel(st.id).link], ['https://radio.example.com/b.mp3', undefined])
  assert.deepEqual([dir.updateChannel(st.id, { source: '' }).source, dir.channel(st.id).link], [undefined, undefined])

  // Music ducks under IFB talkers by default; the depth is kept, and noDuck turns it off.
  const a = dir.addChannel({ name: 'Bed', music: true, duck: 0.3 })
  assert.deepEqual([a.music, a.duck, a.noDuck, a.ifb], [true, 0.3, undefined, undefined])
  const b = dir.updateChannel(a.id, { noDuck: true })
  assert.deepEqual([b.noDuck, b.duck], [true, undefined], 'a depth is meaningless once ducking is off')
  const c = dir.updateChannel(a.id, { noDuck: false, duck: 0.4 })
  assert.deepEqual([c.noDuck, c.duck], [undefined, 0.4])
  assert.throws(() => dir.updateChannel(a.id, { duck: 2 }), /between 0 and 1/)
  // A normal channel never carries music-only settings.
  const plain = dir.addChannel({ name: 'Plain', noDuck: true, source: 'https://x.example/live.mp3' })
  assert.equal(plain.noDuck, undefined)
  assert.equal(plain.source, undefined)
  await srv.close()
})

test('music stream relay: a web page behind the URL is refused with 415', async () => {
  const http = await import('node:http')
  const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>not audio</html>') })
  await new Promise(r => page.listen(0, '127.0.0.1', r))
  const fake = { url: 'ws://sfu', token: async () => 't', listTracks: async () => [], updateSubscriptions: async () => {} }
  const srv = createServer({ ...cfg, pin: '' }, { sfu: fake })
  const port = await srv.listen(0)
  const mus = srv.directory.addChannel({ name: 'Page', music: true, source: `http://127.0.0.1:${page.address().port}/watch` })
  const grp = srv.directory.groups.find(x => x.name === 'Audio')
  srv.directory.updateGroup(grp.id, { grants: { ...grp.grants, [mus.id]: { talk: true, listen: true } } })
  try {
    const c = await client(port)
    c.send({ type: 'join', name: 'Ann', role: 'Audio' })
    const w = await c.next(m => m.type === 'welcome')
    const r = await fetch(`http://127.0.0.1:${port}/music/${mus.id}?k=${w.musicKey}`)
    assert.equal(r.status, 415)
    c.ws.close()
  } finally {
    await srv.close()
    await new Promise(r => page.close(r))
  }
})

test('party-line channel with music: talk keeps working and music routes by the same grants', async () => {
  const subs = new Map()
  const tracksBy = new Map()
  const fake = {
    url: 'ws://sfu', token: async p => `tok-${p.name}`, listTracks: async id => tracksBy.get(id) ?? [],
    updateSubscriptions: async (id, sids, on) => {
      const set = subs.get(id) ?? new Set()
      for (const x of sids) on ? set.add(x) : set.delete(x)
      subs.set(id, set)
    },
  }
  const srv = createServer({ ...cfg, pin: '' }, { sfu: fake })
  const port = await srv.listen(0)
  const dir = srv.directory
  const prog = dir.addChannel({ name: 'Program', withMusic: true, source: 'https://www.youtube.com/watch?v=abc' })
  assert.deepEqual([prog.withMusic, prog.music, prog.link, prog.source], [true, undefined, 'https://www.youtube.com/watch?v=abc', undefined])
  assert.equal(dir.addChannel({ name: 'Talkback', ifb: true, withMusic: true }).withMusic, undefined, 'an IFB cannot also carry music')
  const grant = (group, g) => { const grp = dir.groups.find(x => x.name === group); dir.updateGroup(grp.id, { grants: { ...grp.grants, [prog.id]: g } }) }
  grant('Audio', { talk: true, listen: true })
  grant('Camera', { listen: true })
  const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } assert.fail('timed out: ' + what) }
  const has = (id, sid) => subs.get(id)?.has(sid) ?? false
  try {
    const mk = async (name, role) => { const c = await client(port); c.send({ type: 'join', name, role }); const w = await c.next(m => m.type === 'welcome'); return { c, id: w.id, w } }
    const A1 = await mk('Ann', 'Audio')
    const cam = await mk('Bob', 'Camera')
    assert.equal(A1.w.channels.find(c => c.id === prog.id).withMusic, true)

    // Talk on the channel still works (unlike a music-only channel).
    A1.c.send({ type: 'state', talk: [prog.id], listen: [prog.id] })
    const st = await cam.c.next(m => m.type === 'peer-state' && m.id === A1.id)
    assert.deepEqual(st.talk, [prog.id])

    // Music: published as music:<channel>, forwarded only while the sender has it on.
    tracksBy.set(A1.id, [{ name: 'ch:' + prog.id, sid: 'A-talk' }, { name: 'music:' + prog.id, sid: 'A-music' }])
    A1.c.send({ type: 'tracks' })
    await until(() => has(cam.id, 'A-talk'), 'talk track forwarded')
    assert.ok(!has(cam.id, 'A-music'), 'music off: not forwarded')
    A1.c.send({ type: 'music', channel: prog.id, on: true })
    await until(() => has(cam.id, 'A-music'), 'music forwarded once on')
    cam.c.send({ type: 'music', channel: prog.id, on: true }) // listen-only user cannot start it
    await new Promise(r => setTimeout(r, 100))
    A1.c.send({ type: 'music', channel: prog.id, on: false })
    await until(() => !has(cam.id, 'A-music'), 'music stops when switched off')
    assert.ok(has(cam.id, 'A-talk'), 'the talk track is unaffected')
    for (const x of [A1, cam]) x.c.ws.close()
  } finally {
    await srv.close()
  }
})
