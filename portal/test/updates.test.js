'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { openUpdates, parseName } = require('../lib/updates')

const exe = (n = 1.2 * 1024 * 1024, fill = 7) => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(Math.floor(n), fill)])
const fresh = () => openUpdates(fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')))
async function put(u, version, buf = exe(), app = 'link', label = 'Link') {
  const file = `Arena-${label}-Setup-${version}.exe`
  const got = await u.receive(app, file, Readable.from([buf]))
  return u.publish(app, { version, file, ...got, notes: 'n' })
}

test('the version is read from the installer file name, and anything else is refused', () => {
  assert.deepEqual(parseName('Arena-Link-Setup-0.2.0.exe'), { app: 'link', version: '0.2.0', file: 'Arena-Link-Setup-0.2.0.exe' })
  assert.equal(parseName('Arena-Decoder-Setup-1.10.3.exe').app, 'decoder')
  assert.equal(parseName('Arena-Comms-Setup-0.2.0.exe').app, 'comms')
  assert.equal(parseName('Arena-Remote-Setup-0.2.0.exe').app, 'remote')
  for (const bad of ['setup.exe', 'Arena-Link-Setup-0.2.exe', 'Arena-Link-Setup-0.2.0.exe.zip', '../Arena-Link-Setup-0.2.0.txt', '', null]) assert.equal(parseName(bad), null, String(bad))
  assert.equal(parseName('../../Arena-Link-Setup-0.2.0.exe').file, 'Arena-Link-Setup-0.2.0.exe')   // only the base name is kept
})

test('an upload is stored with its hash, and a new release starts paused', async () => {
  const u = fresh()
  const buf = exe()
  const st = await put(u, '0.2.0', buf)
  assert.equal(st.latest.version, '0.2.0')
  assert.equal(st.latest.sha256, crypto.createHash('sha256').update(buf).digest('hex'))
  assert.equal(st.latest.size, buf.length)
  assert.deepEqual([st.latest.paused, st.latest.exact, st.latest.allow], [true, false, []])
  assert.equal(st.history.length, 1)
})

test('empty, tiny and non-program uploads are refused and leave nothing behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'))
  const u = openUpdates(dir)
  await assert.rejects(u.receive('link', 'Arena-Link-Setup-0.2.0.exe', Readable.from([Buffer.from('MZ')])), /too small/)
  await assert.rejects(u.receive('link', 'Arena-Link-Setup-0.2.0.exe', Readable.from([Buffer.alloc(2 * 1024 * 1024, 1)])), /not a Windows program/)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'link')), [])
})

test('release control: everyone, named PCs, pause; and a roll back moves to exactly that version', async () => {
  const u = fresh()
  await put(u, '0.2.0'); await put(u, '0.3.0')
  assert.equal(u.state('link').latest.version, '0.3.0')                              // newest wins
  let l = u.setRollout('link', 'all').latest
  assert.deepEqual([l.paused, l.allow], [false, []])
  l = u.setRollout('link', 'only', ['pc-a', 'pc-a', 'pc-b']).latest
  assert.deepEqual([l.paused, l.allow], [false, ['pc-a', 'pc-b']])
  assert.throws(() => u.setRollout('link', 'only', []), /at least one PC/)
  assert.equal(u.setRollout('link', 'pause').latest.paused, true)
  assert.throws(() => u.setRollout('link', 'sideways'), /mode must be/)
  l = u.rollback('link', '0.2.0').latest
  assert.deepEqual([l.version, l.exact, l.paused], ['0.2.0', true, true])           // held back until released, like any release
  assert.throws(() => u.rollback('link', '9.9.9'), /not kept/)
})

test('only the last five releases are kept; the current one cannot be deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'))
  const u = openUpdates(dir)
  for (let i = 1; i <= 7; i++) await put(u, `0.${i}.0`, exe(1.1 * 1024 * 1024, i))
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(u.state('link').history.map(h => h.version), ['0.7.0', '0.6.0', '0.5.0', '0.4.0', '0.3.0'])
  assert.deepEqual(fs.readdirSync(path.join(dir, 'link')).filter(f => f.endsWith('.exe')).length, 5)
  assert.throws(() => u.remove('link', '0.7.0'), /current release/)
  u.remove('link', '0.3.0')
  assert.equal(u.state('link').history.length, 4)
  assert.throws(() => u.remove('link', '0.3.0'), /no such release/)
})

test('versions compare numerically, not as text', () => {
  const { cmp } = openUpdates(fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')))
  assert.ok(cmp('0.10.0', '0.9.0') > 0 && cmp('1.0.0', '0.99.99') > 0 && cmp('0.2.0', '0.2.0') === 0)
})
