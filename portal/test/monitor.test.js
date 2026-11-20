'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { openMonitor, webhookBody } = require('../lib/monitor')

function rig(opts) {
  let t = 1_000_000
  const snap = {
    directoryOk: true,
    encoders: [{ id: 'e1', name: 'ESPN 1', kbps: 10000, measuredKbps: 9800 }],
    decoders: [{ id: 'd1', name: 'Truck' }],
    services: [{ name: 'mediamtx', label: 'Stream server', installed: true, active: true }],
    system: { load: [1, 1, 1], cpus: 8, memTotal: 1000, memFree: 500 },
    disks: [{ mount: '/', total: 1000, free: 500 }],
  }
  const sent = []
  let fail = false
  const m = openMonitor({ dir: null, now: () => t, opts, collect: async () => { if (fail) throw new Error('boom'); return JSON.parse(JSON.stringify(snap)) }, notify: (k, a) => sent.push([k, a.key]) })
  return { m, snap, sent, adv: s => { t += s * 1000 }, set: f => { fail = f }, step: async (s = 5) => { t += s * 1000; await m.tick() } }
}
const keys = r => r.m.state().alerts.map(a => a.key)

test('a healthy system raises nothing', async () => {
  const r = rig()
  for (let i = 0; i < 10; i++) await r.step()
  assert.deepEqual(keys(r), [])
  assert.equal(r.m.state().streams[0].live, true)
})

test('a stream that disappears alerts after the delay, and resolves when it returns', async () => {
  const r = rig({ offlineSec: 15 })
  await r.step()
  r.snap.encoders = []
  await r.step(5); await r.step(5)
  assert.deepEqual(keys(r), [])                       // 10 s: a blip, not yet an alert
  await r.step(10)
  assert.deepEqual(keys(r), ['stream.offline:e1'])
  assert.equal(r.m.state().alerts[0].severity, 'critical')
  r.snap.encoders = [{ id: 'e1', name: 'ESPN 1', kbps: 10000, measuredKbps: 9800 }]
  await r.step()
  assert.deepEqual(keys(r), [])
  assert.deepEqual(r.sent.map(x => x[0]), ['open', 'resolved'])
  assert.ok(r.m.state().events[0].closedAt > 0)
})

test('a low measured rate must last before it alerts, and clears when the rate recovers', async () => {
  const r = rig({ lowRateSec: 20 })
  r.snap.encoders[0].measuredKbps = 2000
  await r.step(); await r.step(10)
  assert.deepEqual(keys(r), [])
  await r.step(15)
  assert.deepEqual(keys(r), ['stream.lowrate:e1'])
  r.snap.encoders[0].measuredKbps = 9500
  await r.step()
  assert.deepEqual(keys(r), [])
})

test('no measured rate means no low-rate alert', async () => {
  const r = rig({ lowRateSec: 1 })
  r.snap.encoders[0].measuredKbps = undefined
  for (let i = 0; i < 5; i++) await r.step()
  assert.deepEqual(keys(r), [])
})

test('directory down is one alert and does not blame every stream', async () => {
  const r = rig({ offlineSec: 5 })
  await r.step()
  r.snap.directoryOk = false; r.snap.encoders = []; r.snap.decoders = []
  for (let i = 0; i < 6; i++) await r.step()
  assert.deepEqual(keys(r), ['app.directory'])
})

test('a stopped service alerts; a disk over the limit alerts at two levels', async () => {
  const r = rig({ serviceDownSec: 10 })
  r.snap.services[0].active = false
  r.snap.disks[0].free = 80       // 92% used
  await r.step(); await r.step(12)
  assert.deepEqual(keys(r).sort(), ['disk:/', 'service.down:mediamtx'])
  assert.equal(r.m.state().alerts.find(a => a.key === 'disk:/').severity, 'warning')
  r.snap.disks[0].free = 10       // 99% used
  await r.step()
  assert.equal(r.m.state().alerts.find(a => a.key === 'disk:/').severity, 'critical')
  r.snap.disks[0].free = 600; r.snap.services[0].active = true
  await r.step()
  assert.deepEqual(keys(r), [])
})

test('overload needs to last; not-installed services are ignored', async () => {
  const r = rig({ cpuSec: 30 })
  r.snap.system.load = [8, 8, 8]
  r.snap.services.push({ name: 'arena-livekit', label: 'LiveKit', installed: false, active: false })
  await r.step(); await r.step(20)
  assert.deepEqual(keys(r), [])
  await r.step(15)
  assert.deepEqual(keys(r), ['system.cpu'])
})

test('a decoder that stops reporting alerts', async () => {
  const r = rig({ decoderOfflineSec: 30 })
  await r.step()
  r.snap.decoders = []
  await r.step(20)
  assert.deepEqual(keys(r), [])
  await r.step(20)
  assert.deepEqual(keys(r), ['decoder.offline:d1'])
})

test('failing to read the server alerts only after repeated failures, and a bad webhook never breaks monitoring', async () => {
  const r = rig()
  r.set(true)
  await r.step(); await r.step()
  assert.deepEqual(keys(r), [])
  await r.step()
  assert.deepEqual(keys(r), ['monitor.collect'])
  r.set(false)
  await r.step()
  assert.deepEqual(keys(r), [])
  const bad = openMonitor({ dir: null, collect: async () => ({ directoryOk: false, encoders: [] }), notify: () => { throw new Error('x') }, now: (() => { let t = 0; return () => (t += 20000) })() })
  for (let i = 0; i < 3; i++) await bad.tick()
  assert.equal(bad.state().alerts.length, 1)
})

test('history gives uptime and a per-minute series', async () => {
  const r = rig()
  for (let i = 0; i < 12; i++) await r.step()          // one minute of 5 s ticks
  r.snap.encoders = []
  for (let i = 0; i < 12; i++) await r.step()
  const s = r.m.state().streams[0]
  assert.ok(s.uptimePct > 40 && s.uptimePct < 60, 'uptime ' + s.uptimePct)
  assert.ok(s.series.length >= 2)
})

test('webhook text is readable for chat tools', () => {
  const open = webhookBody('open', { key: 'k', severity: 'critical', title: 'ESPN 1 went off air', detail: 'Last seen 20 s ago.', openedAt: 0 })
  assert.match(open.text, /CRITICAL.*ESPN 1 went off air/)
  const done = webhookBody('resolved', { key: 'k', severity: 'critical', title: 'ESPN 1 went off air', openedAt: 0, closedAt: 90000 })
  assert.match(done.text, /Resolved.*90 s/)
  assert.equal(done.closedAt, new Date(90000).toISOString())
})

test('a stream stopped on purpose is not an outage, until it is seen live again', async () => {
  const r = rig({ offlineSec: 10 })
  await r.step()
  r.m.expectOff('ESPN 1')
  r.snap.encoders = []
  for (let i = 0; i < 6; i++) await r.step()
  assert.deepEqual(keys(r), [])
  assert.equal(r.m.state().streams[0].stopped, true)
  r.snap.encoders = [{ id: 'e1', name: 'ESPN 1', kbps: 10000, measuredKbps: 9800 }]
  await r.step()
  r.snap.encoders = []
  for (let i = 0; i < 5; i++) await r.step()
  assert.deepEqual(keys(r), ['stream.offline:e1'])                   // it was live again, so a later loss is a real one
})

test('an outside alert closes by itself after its time', async () => {
  const r = rig()
  await r.step()
  r.m.external('schedule:1', 'critical', 'Scheduled start did not happen', 'PC is off', 60)
  assert.deepEqual(keys(r), ['schedule:1'])
  await r.step(30)
  assert.deepEqual(keys(r), ['schedule:1'])
  await r.step(40)
  assert.deepEqual(keys(r), [])
})

test('a stream that keeps announcing for a few seconds after a stop is still a stop, not an outage', async () => {
  const r = rig({ offlineSec: 10 })
  await r.step()
  r.m.expectOff('ESPN 1')
  await r.step(); await r.step()                       // the encoder is still winding down (about 10 s)
  r.snap.encoders = []
  for (let i = 0; i < 6; i++) await r.step()
  assert.deepEqual(keys(r), [])
})
