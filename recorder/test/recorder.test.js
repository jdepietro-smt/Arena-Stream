'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createRecorder } = require('../lib/recorder')

function rig(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'))
  const procs = []
  let off = 0                                                                       // fake clock: real time plus an offset the test can move
  const spawn = (bin, args, o) => {
    const p = new EventEmitter(); p.stderr = new EventEmitter(); p.args = args; p.env = o.env; p.killed = []
    p.kill = sig => { p.killed.push(sig || 'SIGTERM'); setImmediate(() => p.emit('close')) }
    procs.push(p)
    return p
  }
  const rec = createRecorder({ ffmpeg: 'ffmpeg-test', relaySrt: '127.0.0.1:8895', root, spawn, now: () => Date.now() + off, backoffMs: [10, 20, 40], stallMs: 45000, ...opts })
  return { rec, root, procs, adv: ms => { off += ms }, tick: ms => new Promise(r => setTimeout(r, ms)) }
}
const live = (...names) => names.map(n => ({ name: n, relayName: n.replace(/[^A-Za-z0-9]+/g, '-') }))

test('only streams that are chosen AND on air are recorded, reading from the relay, keeping video as it is', () => {
  const r = rig()
  r.rec.reconcile(new Set(['Rangers - MSG', 'Bruins']), live('Rangers - MSG', 'Devils'))
  assert.equal(r.procs.length, 1)                                                  // Bruins is chosen but off air; Devils is on air but not chosen
  const a = r.procs[0].args.join(' ')
  assert.match(a, /srt:\/\/127\.0\.0\.1:8895\?streamid=read:Rangers-MSG&mode=caller&latency=300000/)
  assert.match(a, /-c:v copy/); assert.match(a, /-c:a aac/)                        // browsers cannot play the Opus the apps send
  assert.match(a, /-segment_time 10/); assert.match(a, /-strftime 1/)
  assert.ok(a.includes(path.join(r.root, 'Rangers-MSG', '%Y%m%dT%H%M%S.ts')))
  assert.equal(r.procs[0].env.TZ, 'UTC')                                           // piece names are UTC times
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.root, 'Rangers-MSG', 'meta.json'), 'utf8')), { name: 'Rangers - MSG', relayName: 'Rangers-MSG' })
})

test('a running recording is left alone, and stopped (gently) when unchosen or the stream goes off air', () => {
  const r = rig()
  r.rec.reconcile(new Set(['A']), live('A'))
  r.rec.reconcile(new Set(['A']), live('A'))
  assert.equal(r.procs.length, 1)                                                  // not started twice
  r.rec.reconcile(new Set([]), live('A'))                                          // unchosen
  assert.deepEqual(r.procs[0].killed[0], 'SIGINT')                                 // lets ffmpeg finish the piece it is writing
  r.rec.reconcile(new Set(['A']), live('A'))
  assert.equal(r.procs.length, 2)
  r.rec.reconcile(new Set(['A']), [])                                              // off air
  assert.deepEqual(r.procs[1].killed[0], 'SIGINT')
  assert.equal(r.rec.has('A'), false)
})

test('a crashed recording is started again, with growing waits', async () => {
  const r = rig()
  r.rec.reconcile(new Set(['A']), live('A'))
  r.procs[0].emit('close')
  await r.tick(40)
  assert.equal(r.procs.length, 2)
  r.procs[1].emit('close')
  await r.tick(80)
  assert.equal(r.procs.length, 3)
  assert.equal(r.rec.status(['A'])[0].restarts >= 2, true)
})

test('streams with odd names or relay names cannot reach outside the recordings folder or the relay', () => {
  const r = rig()
  r.rec.reconcile(new Set(['../../etc']), [{ name: '../../etc', relayName: 'ok-name' }])
  assert.ok(r.procs[0].args.join(' ').includes(path.join(r.root, 'etc')))
  assert.ok(!r.procs[0].args.join(' ').includes('..'))
  r.rec.reconcile(new Set(['../../etc', 'B']), [{ name: 'B', relayName: 'bad name&x=1' }, { name: '../../etc', relayName: 'ok-name' }])
  assert.equal(r.procs.length, 1)                                                  // a relay name that is not plain letters and digits is refused
})

test('the watchdog restarts a recording that has stopped writing, and leaves a healthy one', () => {
  const r = rig({ stallMs: 30000 })
  r.rec.reconcile(new Set(['A']), live('A'))
  fs.writeFileSync(path.join(r.root, 'A', '20261122T154000.ts'), 'x')              // the folder has just been written to
  const fresh = Date.now()
  fs.utimesSync(path.join(r.root, 'A'), fresh / 1000, fresh / 1000)
  r.adv(0); r.rec.watchdog()
  assert.equal(r.procs[0].killed.length, 0)
  const old = (Date.now() - 120000) / 1000
  fs.utimesSync(path.join(r.root, 'A'), old, old)                                   // nothing written for two minutes
  r.adv(60000); r.rec.watchdog()
  assert.equal(r.procs[0].killed.length, 1)
  assert.equal(r.rec.status(['A'])[0].stalls, 1)
})

test('status says waiting for a stream that is not on air', () => {
  const r = rig()
  assert.deepEqual(r.rec.status(['Nobody']), [{ name: 'Nobody', state: 'waiting' }])
})
