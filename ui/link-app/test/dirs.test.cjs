'use strict'
// A directory address can be "main,backup": reads and heartbeats fall over to the next one that answers.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const { splitDirs, withDirectories } = require('../dist-electron/dirs.js')
const { startUpdater } = require('../dist-electron/updater.js')

test('addresses are split on commas and tidied', () => {
  assert.deepEqual(splitDirs('http://a:8002, http://b:8002 ,'), ['http://a:8002', 'http://b:8002'])
  assert.deepEqual(splitDirs('http://a:8002'), ['http://a:8002'])
  assert.deepEqual(splitDirs(''), [])
  assert.deepEqual(splitDirs(undefined), [])
})

test('falls over to the backup, then stays on whichever answered last', async () => {
  const state = { last: 0 }
  const hits = []
  const fn = down => async u => { hits.push(u); if (down.includes(u)) throw new Error('down ' + u); return 'from ' + u }
  assert.equal(await withDirectories('A,B', fn(['A']), state), 'from B')
  assert.deepEqual(hits, ['A', 'B'])
  assert.equal(state.last, 1)
  hits.length = 0
  assert.equal(await withDirectories('A,B', fn(['A']), state), 'from B')          // goes straight to B now
  assert.deepEqual(hits, ['B'])
  hits.length = 0
  assert.equal(await withDirectories('A,B', fn(['B']), state), 'from A')          // B drops: back to A
  assert.equal(state.last, 0)
  await assert.rejects(withDirectories('A,B', fn(['A', 'B']), { last: 0 }), /down/)
  await assert.rejects(withDirectories('', fn([]), { last: 0 }), /no directory address/)
})

test('an answer can be refused too (for example HTTP 500 or a rejected key), and the next address is tried', async () => {
  const state = { last: 0 }
  const answers = { A: { status: 500 }, B: { status: 200, v: 'b' } }
  const r = await withDirectories('A,B', async u => answers[u], state, x => x.status === 200)
  assert.equal(r.v, 'b'); assert.equal(state.last, 1)
  const bad = await withDirectories('A,B', async u => ({ status: u === 'A' ? 401 : 503 }), { last: 0 }, x => x.status === 200)
  assert.equal(bad.status, 503)                                                    // nothing acceptable: the last answer, so the screen can say why
})

// ── the updater with a main and a backup directory ────────────────────────────────
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const BIG = crypto.randomBytes(1.2 * 1024 * 1024)
const DIRECTORY_PY = path.join(__dirname, '..', '..', '..', 'link', 'directory', 'directory.py')
const procs = []
async function startDirectory(port, withRelease) {
  const upd = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-' + port + '-'))
  if (withRelease) {
    fs.mkdirSync(path.join(upd, 'link'))
    fs.writeFileSync(path.join(upd, 'link', 'Arena-Link-Setup-0.2.0.exe'), BIG)
    fs.writeFileSync(path.join(upd, 'link', 'latest.json'), JSON.stringify({ version: '0.2.0', file: 'Arena-Link-Setup-0.2.0.exe', sha256: sha(BIG), size: BIG.length, paused: false, allow: [], exact: false }))
  }
  const p = spawn('python', [DIRECTORY_PY], { env: { ...process.env, LINK_PORT: String(port), LINK_KEY: 'k', LINK_UPDATE_DIR: upd }, stdio: 'ignore' })
  procs.push(p)
  await new Promise(r => setTimeout(r, 900))
  return p
}
test.after(() => { for (const p of procs) try { p.kill() } catch { /* gone */ } })

const mkUpdater = (directory, dir) => startUpdater({ app: 'link', version: '0.1.0', host: 'pc-a', dir, config: () => ({ directory, key: 'k' }), isLive: () => true, prepareToQuit: async () => {}, quit: () => {}, run: () => {}, onStatus: () => {}, log: () => {} })

test('updates still download when the main directory is down, and a backup that has no release does not cancel one already downloaded', async () => {
  const main = await startDirectory(18072, true)
  await startDirectory(18073, false)                                               // a backup that has no release files
  const both = 'http://127.0.0.1:18072,http://127.0.0.1:18073'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-cli-'))
  const u = mkUpdater(both, dir)
  await u.checkNow()
  assert.equal(u.status().state, 'ready')                                          // via the main directory
  assert.ok(fs.existsSync(path.join(dir, 'Arena-Link-Setup-0.2.0.exe')))

  main.kill(); await new Promise(r => setTimeout(r, 600))
  await u.checkNow()                                                               // main is gone; the backup says "nothing"
  assert.equal(u.status().state, 'ready')                                          // ...which must not throw the download away
  assert.equal(u.status().pending, '0.2.0')
  assert.ok(fs.existsSync(path.join(dir, 'Arena-Link-Setup-0.2.0.exe')))
})

test('the first download can come from the backup when the main is unreachable', async () => {
  await startDirectory(18074, false)
  await startDirectory(18075, true)                                                // only the second has the release
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-cli-'))
  const u = mkUpdater('http://127.0.0.1:18079,http://127.0.0.1:18075', dir)        // 18079: nothing is listening
  await u.checkNow()
  assert.equal(u.status().state, 'ready')
  assert.equal(sha(fs.readFileSync(path.join(dir, 'Arena-Link-Setup-0.2.0.exe'))), sha(BIG))
})
