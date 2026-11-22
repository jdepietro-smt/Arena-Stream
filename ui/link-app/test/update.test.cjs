'use strict'
// Software update logic: decisions, and the real download path against the real Link directory service.
// Run: npm test   (compiles the Electron code first)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const core = require('../dist-electron/update-core.js')
const net = require('../dist-electron/update-net.js')
const { startUpdater } = require('../dist-electron/updater.js')

const DIRECTORY_PY = path.join(__dirname, '..', '..', '..', 'link', 'directory', 'directory.py')
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const at = (h, m) => { const d = new Date(2026, 10, 20, h, m, 0); return d }

// ── decisions ──────────────────────────────────────────────────────────────────
test('versions compare numerically', () => {
  assert.ok(core.cmpVersion('0.10.0', '0.9.0') > 0)
  assert.ok(core.cmpVersion('1.0.0', '0.99.99') > 0)
  assert.equal(core.cmpVersion('0.2.0', '0.2.0'), 0)
  assert.ok(core.cmpVersion('garbage', '0.0.1') < 0)
})

test('an offer is only taken when it is complete, safe and actually different', () => {
  const ok = { update: true, version: '0.2.0', file: 'Arena-Link-Setup-0.2.0.exe', sha256: 'a'.repeat(64), size: 5e6 }
  assert.ok(core.worthTaking(ok, '0.1.0'))
  assert.ok(!core.worthTaking(ok, '0.2.0'))                                    // already on it
  assert.ok(!core.worthTaking(ok, '0.3.0'))                                    // older is not an update...
  assert.ok(core.worthTaking({ ...ok, exact: true }, '0.3.0'))                 // ...unless it is a roll back
  assert.ok(!core.worthTaking({ ...ok, exact: true }, '0.2.0'))
  assert.ok(!core.worthTaking({ ...ok, update: false }, '0.1.0'))
  assert.ok(!core.worthTaking({ ...ok, sha256: 'xyz' }, '0.1.0'))
  assert.ok(!core.worthTaking({ ...ok, file: '..\\evil.exe' }, '0.1.0'))
  assert.ok(!core.worthTaking({ ...ok, file: '../../evil.exe' }, '0.1.0'))
  assert.ok(!core.worthTaking({ ...ok, size: 100 }, '0.1.0'))                  // an installer is never that small
  assert.ok(!core.worthTaking(null, '0.1.0'))
})

test('maintenance windows, including overnight ones', () => {
  const day = { from: '09:00', to: '17:00' }, night = { from: '23:00', to: '05:00' }
  assert.ok(core.inWindow(at(9, 0), day) && core.inWindow(at(16, 59), day) && !core.inWindow(at(17, 0), day) && !core.inWindow(at(8, 59), day))
  assert.ok(core.inWindow(at(23, 30), night) && core.inWindow(at(2, 0), night) && !core.inWindow(at(5, 0), night) && !core.inWindow(at(12, 0), night))
  assert.ok(!core.inWindow(at(3, 0), null) && !core.inWindow(at(3, 0), { from: '03:00', to: '03:00' }) && !core.inWindow(at(3, 0), { from: 'x', to: 'y' }))
})

test('install decision: never while live unless the window allows, quiet moment first, manual always', () => {
  const base = { mode: 'idle', live: false, idleMs: 10 * 60 * 1000, now: at(14, 0), window: null, manual: false }
  assert.deepEqual(core.installDecision(base), { install: true, waiting: '' })
  assert.equal(core.installDecision({ ...base, live: true }).install, false)
  assert.match(core.installDecision({ ...base, live: true }).waiting, /stream to stop/)
  assert.equal(core.installDecision({ ...base, idleMs: 30000 }).install, false)            // only just went quiet
  assert.match(core.installDecision({ ...base, idleMs: 30000 }).waiting, /quiet moment/)
  assert.equal(core.installDecision({ ...base, live: true, window: { from: '13:00', to: '15:00' } }).install, true)   // maintenance window
  assert.equal(core.installDecision({ ...base, live: true, window: { from: '02:00', to: '04:00' } }).install, false)
  assert.equal(core.installDecision({ ...base, mode: 'off' }).install, false)
  assert.equal(core.installDecision({ ...base, mode: 'ask' }).install, false)
  assert.equal(core.installDecision({ ...base, mode: 'off', live: true, manual: true }).install, true)
})

// ── the real thing: download from the real directory service ───────────────────────
const PORT = 18062, KEY = 'testkey'
const BIG = crypto.randomBytes(1.5 * 1024 * 1024)
let srv, UPD

test.before(async () => {
  UPD = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-srv-'))
  fs.mkdirSync(path.join(UPD, 'link'))
  fs.writeFileSync(path.join(UPD, 'link', 'Arena-Link-Setup-0.2.0.exe'), BIG)
  srv = spawn('python', [DIRECTORY_PY], { env: { ...process.env, LINK_PORT: String(PORT), LINK_KEY: KEY, LINK_UPDATE_DIR: UPD }, stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 1000))
})
test.after(() => { try { srv.kill() } catch { /* gone */ } })

const publish = (o = {}) => fs.writeFileSync(path.join(UPD, 'link', 'latest.json'), JSON.stringify({ version: '0.2.0', file: 'Arena-Link-Setup-0.2.0.exe', sha256: sha(BIG), size: BIG.length, notes: '', paused: false, allow: [], exact: false, ...o }))
const D = { directory: `http://127.0.0.1:${PORT}`, key: KEY }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'upd-cli-'))

test('the directory offers it to a PC on an older version only when released', async () => {
  const q = (v = '0.1.0', host = 'pc-a') => net.checkOffer({ ...D, app: 'link', host, version: v })
  assert.equal((await q()).update, false)                                         // nothing published
  publish({ paused: true });          assert.equal((await q()).update, false)     // held back
  publish();                          assert.equal((await q()).update, true)
  assert.equal((await q('0.2.0')).update, false)
  publish({ allow: ['pc-b'] });       assert.equal((await q('0.1.0', 'pc-a')).update, false)
  assert.equal((await q('0.1.0', 'pc-b')).update, true)
  await assert.rejects(net.checkOffer({ ...D, key: 'wrong', app: 'link', host: 'x', version: '0.1.0' }), /401/)
})

test('download: complete, checked, and no partial file left under the final name', async () => {
  publish()
  const offer = await net.checkOffer({ ...D, app: 'link', host: 'pc-a', version: '0.1.0' })
  const dir = tmp(), seen = []
  const f = await net.downloadRelease({ ...D, app: 'link', offer, dir, onProgress: p => seen.push(p) })
  assert.equal(path.basename(f), 'Arena-Link-Setup-0.2.0.exe')
  assert.equal(sha(fs.readFileSync(f)), sha(BIG))
  assert.equal(seen[seen.length - 1], 100)
  assert.deepEqual(fs.readdirSync(dir), ['Arena-Link-Setup-0.2.0.exe'])
  // run again: already intact, nothing is fetched
  const f2 = await net.downloadRelease({ ...D, app: 'link', offer: { ...offer }, dir })
  assert.equal(f2, f)
})

test('download resumes a half-finished file instead of starting over', async () => {
  publish()
  const offer = await net.checkOffer({ ...D, app: 'link', host: 'pc-a', version: '0.1.0' })
  const dir = tmp()
  fs.writeFileSync(path.join(dir, offer.file + '.part'), BIG.subarray(0, 700000))         // an earlier attempt got this far
  const f = await net.downloadRelease({ ...D, app: 'link', offer, dir })
  assert.equal(sha(fs.readFileSync(f)), sha(BIG))
})

test('a download that does not match what was published is thrown away', async () => {
  publish({ sha256: 'f'.repeat(64) })
  const offer = await net.checkOffer({ ...D, app: 'link', host: 'pc-a', version: '0.1.0' })
  const dir = tmp()
  await assert.rejects(net.downloadRelease({ ...D, app: 'link', offer, dir }), /integrity check/)
  assert.deepEqual(fs.readdirSync(dir), [])                                                // nothing that could be run
  publish({ size: BIG.length + 5 })
  const offer2 = await net.checkOffer({ ...D, app: 'link', host: 'pc-a', version: '0.1.0' })
  await assert.rejects(net.downloadRelease({ ...D, app: 'link', offer: offer2, dir }))
  assert.ok(!fs.existsSync(path.join(dir, offer2.file)))
})

test('the updater: downloads quietly, waits while live, installs on request after stopping everything', async () => {
  publish()
  const dir = tmp()
  const calls = []
  let live = true, mode = 'idle', status
  const u = startUpdater({
    app: 'link', version: '0.1.0', host: 'pc-a', dir,
    config: () => ({ ...D, updateMode: mode, updateWindow: null }),
    isLive: () => live,
    prepareToQuit: async () => { calls.push('prepare') },
    quit: () => calls.push('quit'),
    run: (file, args) => calls.push(['run', path.basename(file), args]),
    onStatus: s => { status = s },
    log: () => {},
  })
  await u.checkNow()
  assert.equal(u.status().state, 'ready')
  assert.equal(u.status().pending, '0.2.0')
  assert.ok(fs.existsSync(path.join(dir, 'Arena-Link-Setup-0.2.0.exe')))
  assert.deepEqual(calls, [])                                                              // downloaded, but nothing installed: it is live
  assert.equal(status.state, 'ready')

  mode = 'off'; await u.checkNow()
  assert.equal(u.status().state, 'off')                                                    // turned off on this PC
  mode = 'idle'; await u.checkNow()
  assert.equal(u.status().state, 'ready')

  await u.installNow()                                                                     // someone pressed Install now
  assert.equal(u.status().state, 'installing')
  assert.deepEqual(calls.slice(0, 2), ['prepare', ['run', 'Arena-Link-Setup-0.2.0.exe', ['/S', '--updated', '--force-run']]])   // stopped first, then the installer
  await new Promise(r => setTimeout(r, 1800))
  assert.equal(calls[2], 'quit')                                                           // and the app steps aside for it
})

test('the updater ignores an offer that is not newer, and reports a download failure without crashing', async () => {
  publish({ version: '0.1.0', file: 'Arena-Link-Setup-0.1.0.exe' })
  let u = startUpdater({ app: 'link', version: '0.1.0', host: 'pc-a', dir: tmp(), config: () => ({ ...D }), isLive: () => false, prepareToQuit: async () => {}, quit: () => {}, run: () => {}, onStatus: () => {}, log: () => {} })
  await u.checkNow()
  assert.equal(u.status().state, 'idle')
  publish({ sha256: 'e'.repeat(64) })
  u = startUpdater({ app: 'link', version: '0.1.0', host: 'pc-a', dir: tmp(), config: () => ({ ...D }), isLive: () => false, prepareToQuit: async () => {}, quit: () => {}, run: () => {}, onStatus: () => {}, log: () => {} })
  await u.checkNow()
  assert.equal(u.status().state, 'error')
  assert.match(u.status().error, /integrity/)
})
