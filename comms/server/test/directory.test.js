import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createServer, loadConfig } from '../server.js'
import { Directory, DirectoryError, seedFromConfig, verifyPassword } from '../directory.js'

const baseCfg = () => ({ ...loadConfig('/nonexistent.json'), dataFile: null })
const freshDir = () => new Directory(null, seedFromConfig(baseCfg()))

test('effective permissions: union of groups, then per-user overrides', () => {
  const d = freshDir()
  const a = d.addGroup({ name: 'A', grants: { prod: { talk: true, listen: true } } })
  const b = d.addGroup({ name: 'B', grants: { prod: { listen: true }, eng: { listen: true } } })
  const u = { groups: [a.id, b.id], overrides: {} }
  assert.deepEqual(d.effective(u), { prod: { talk: true, listen: true }, eng: { talk: false, listen: true } })
  u.overrides = { prod: { talk: false }, eng: { listen: false }, cam: { listen: true } }
  assert.deepEqual(d.effective(u), { prod: { talk: false, listen: true }, cam: { talk: false, listen: true } })
})

test('deleting a channel or group cleans up everything that referenced it', () => {
  const d = freshDir()
  const g = d.addGroup({ name: 'Ops', grants: { prod: { talk: true, listen: true } } })
  const u = d.addUser({ username: 'ops1', password: 'longenough1', groups: [g.id], overrides: { prod: { talk: false } } })
  d.deleteChannel('prod')
  assert.equal(d.group(g.id).grants.prod, undefined)
  assert.equal(d.user(u.id).overrides.prod, undefined)
  d.deleteGroup(g.id)
  assert.deepEqual(d.user(u.id).groups, [])
})

test('passwords are hashed, usernames unique, last admin protected', async () => {
  const d = freshDir()
  d.ensureAdmin('adminpass1')
  const admin = d.userByName('admin')
  assert.ok(admin.passwordHash.startsWith('s1$') && !admin.passwordHash.includes('adminpass1'))
  assert.ok(await verifyPassword('adminpass1', admin.passwordHash))
  assert.ok(!(await verifyPassword('wrong', admin.passwordHash)))
  assert.throws(() => d.addUser({ username: 'Admin', password: 'longenough1' }), e => e instanceof DirectoryError && e.status === 409)
  assert.throws(() => d.addUser({ username: 'x', password: 'longenough1' }), DirectoryError)
  assert.throws(() => d.addUser({ username: 'shorty', password: 'short' }), /at least 8/)
  assert.throws(() => d.updateUser(admin.id, { admin: false }), /last administrator/)
  assert.throws(() => d.deleteUser(admin.id), /last administrator/)
  assert.throws(() => d.updateUser(admin.id, { disabled: true }), /last administrator/)
})

test('channel validation and reordering', () => {
  const d = freshDir()
  assert.throws(() => d.addChannel({ name: 'Bad', color: 'red' }), /#rrggbb/)
  assert.throws(() => d.addChannel({ id: 'prod', name: 'Dup' }), e => e.status === 409)
  const c = d.addChannel({ name: 'Floor Mgr', color: '#abcdef', ifb: true, duck: 0.2 })
  assert.equal(c.id, 'floor-mgr')
  assert.deepEqual([c.ifb, c.duck], [true, 0.2])
  assert.equal(d.updateChannel('floor-mgr', { ifb: false }).duck, undefined)
  const ids = d.channels.map(x => x.id).reverse()
  d.reorderChannels(ids)
  assert.deepEqual(d.channels.map(x => x.id), ids)
  assert.throws(() => d.reorderChannels(ids.slice(1)), DirectoryError)
})

// ── accounts mode end to end: admin API → login → live permission updates ──────
async function wsClient(port) {
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
  const closed = new Promise(r => ws.on('close', (code, reason) => r(reason.toString())))
  const next = (pred = () => true) => {
    const i = inbox.findIndex(pred)
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
    return new Promise(resolve => waiters.push({ pred, resolve }))
  }
  return { ws, next, closed, send: m => ws.send(JSON.stringify(m)) }
}

test('accounts mode: admin API, login, live permission changes, kick', async () => {
  process.env.COMMS_ADMIN_PASSWORD = 'adminpass1'
  const srv = createServer({ ...baseCfg(), auth: { mode: 'accounts' } })
  const port = await srv.listen(0)
  const base = `http://127.0.0.1:${port}`
  const api = async (method, p, body, token) => {
    const r = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: await r.json() }
  }
  try {
    assert.equal((await fetch(base + '/info').then(r => r.json())).auth, 'accounts')
    assert.equal((await api('GET', '/admin/api/state')).status, 401)
    assert.equal((await api('POST', '/admin/api/login', { username: 'admin', password: 'nope' })).status, 401)
    const { body: { token } } = await api('POST', '/admin/api/login', { username: 'admin', password: 'adminpass1' })
    assert.ok(token)

    const ch = (await api('POST', '/admin/api/channels', { name: 'Floor', color: '#112233' }, token)).body
    const grp = (await api('POST', '/admin/api/groups', { name: 'Floor Crew', grants: { [ch.id]: { talk: true, listen: true }, cam: { listen: true } } }, token)).body
    const usr = (await api('POST', '/admin/api/users', { username: 'dana', name: 'Dana', password: 'danapass12', groups: [grp.id] }, token)).body
    assert.equal(usr.passwordHash, undefined, 'hash never leaves the server')
    assert.equal((await api('POST', '/admin/api/users', { username: 'dana', password: 'danapass12' }, token)).status, 409)

    // Dana joins and sees exactly her grants.
    const bad = await wsClient(port)
    bad.send({ type: 'join', username: 'dana', password: 'wrong' })
    assert.equal((await bad.next(m => m.type === 'error')).code, 'bad-login')

    const dana = await wsClient(port)
    dana.send({ type: 'join', username: 'dana', password: 'danapass12' })
    const w = await dana.next(m => m.type === 'welcome')
    assert.equal(w.me.name, 'Dana')
    assert.deepEqual(w.channels.map(c => [c.id, c.canTalk, c.canListen]).sort(), [['cam', false, true], [ch.id, true, true]].sort())

    // Talking where she may only listen is ignored; listening to unlisted channels too.
    dana.send({ type: 'state', talk: ['cam', ch.id], listen: ['cam', ch.id, 'prod'] })

    // Admin removes her talk right on Floor and adds Production live.
    await api('PUT', `/admin/api/groups/${grp.id}`, { grants: { [ch.id]: { listen: true }, prod: { talk: true, listen: true } } }, token)
    const dir = await dana.next(m => m.type === 'directory')
    assert.deepEqual(dir.channels.map(c => [c.id, c.canTalk, c.canListen]).sort(), [[ch.id, false, true], ['prod', true, true]].sort())
    assert.ok(dir.listen.includes('prod'), 'newly granted channel starts switched on')

    // A second device signs in: the first is told and dropped.
    const dana2 = await wsClient(port)
    dana2.send({ type: 'join', username: 'dana', password: 'danapass12' })
    assert.equal((await dana.next(m => m.type === 'error')).code, 'signed-in-elsewhere')
    await dana2.next(m => m.type === 'welcome')

    // Disabling the account kicks the live session.
    await api('PUT', `/admin/api/users/${usr.id}`, { disabled: true }, token)
    assert.equal((await dana2.next(m => m.type === 'error')).code, 'account-disabled')
    const again = await wsClient(port)
    again.send({ type: 'join', username: 'dana', password: 'danapass12' })
    assert.equal((await again.next(m => m.type === 'error')).code, 'bad-login')

    // Throttle: repeated failures lock the key out even for the right password.
    const t = await wsClient(port)
    for (let i = 0; i < 5; i++) {
      const r = await api('POST', '/admin/api/login', { username: 'admin', password: 'wrong' + i })
      assert.equal(r.status, 401)
    }
    assert.equal((await api('POST', '/admin/api/login', { username: 'admin', password: 'adminpass1' })).status, 429)
    t.ws.close()
  } finally {
    delete process.env.COMMS_ADMIN_PASSWORD
    await srv.close()
  }
})
