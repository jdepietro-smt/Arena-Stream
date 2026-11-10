'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../lib/captest-core')

// A pretend server: CPU = base + per-stream cost, a generator that costs a little, readers that fall behind past a point.
function fakeWorld(o = {}) {
  const w = { t: 1_000_000, streams: 0, started: [], stopped: [], status: null, stopAfterSec: o.stopAfterSec || 0, calls: 0 }
  const cores = 4, hz = 100
  const model = { base: o.base ?? 3, perStream: o.perStream ?? 4, gen: o.gen ?? 1, failAt: o.failAt ?? 1e9 }
  let total = 0, idle = 0, lastT = w.t
  const pidTicks = {}
  const live = o.live || []
  const d = {
    now: () => w.t, sleep: async ms => { w.t += ms }, selfPid: 1, cores,
    stopped: () => w.stopAfterSec > 0 && (w.t - 1_000_000) / 1000 > w.stopAfterSec,
    progress: s => { w.status = s },
    live: async () => (typeof live === 'function' ? live(w) : live),
    prepareSample: async () => ({ mbps: 10 }),
    ...(o.preflight ? { preflight: async () => o.preflight } : {}),
    ...(o.diagnostics ? { diagnostics: async () => o.diagnostics } : {}),
    start: async (kind, i) => {
      if (kind === 'whep' && o.whepFails) throw new Error(o.whepFails)
      w.started.push(kind + i)
      if (kind === 'pub') w.streams = Math.max(w.streams, i)
      const t0 = w.t
      const rate = () => (kind === 'rtsp' && o.rtspDown ? 0 : kind === 'whep' && o.whepDown ? 0 : w.streams > model.failAt ? 4 : 10)
      return {
        kind, stop: async () => { w.stopped.push(kind + i) },
        stats: since => ({ bytes: (w.t - t0) / 1000 * rate() * 1e6 / 8, mediaUs: (w.t - t0) * 1000 * (rate() === 10 ? 1 : 0.5), maxGapSec: 0.5 }),
      }
    },
    sample: async () => {
      const dt = (w.t - lastT) / 1000; lastT = w.t
      const genPct = model.gen * w.streams, sys = Math.min(100, model.base + (model.perStream + model.gen) * w.streams)
      total += cores * hz * dt; idle += cores * hz * dt * (1 - sys / 100)
      const procs = [{ pid: 1, comm: 'node', ppid: 0, ticks: 0 }, { pid: 50, comm: 'arena-srt-rela', ppid: 0, ticks: Math.round((pidTicks[50] = (pidTicks[50] || 0) + cores * hz * dt * 0.02 * w.streams)) },
        { pid: 51, comm: 'mediamtx', ppid: 0, ticks: Math.round((pidTicks[51] = (pidTicks[51] || 0) + cores * hz * dt * 0.02 * w.streams)) }]
      for (let i = 1; i <= w.streams; i++) procs.push({ pid: 1000 + i, comm: 'ffmpeg', ppid: 1, ticks: Math.round((pidTicks[1000 + i] = (pidTicks[1000 + i] || 0) + cores * hz * dt * genPct / 100 / w.streams)) })
      return { t: w.t, stat: { total, idle }, net: { rx: w.t * 1000, tx: w.t * 1000 }, mem: o.mem ?? 12, load: [sys / 100 * cores, 0, 0], procs }
    },
  }
  return { d, w }
}

test('parsers read /proc text', () => {
  const a = core.parseProcStat('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1')
  const b = core.parseProcStat('cpu  200 0 200 800 100 0 0 0 0 0')
  assert.deepEqual(a, { total: 1000, idle: 800 })
  assert.equal(Math.round(core.cpuPct(a, b)), 67)                                      // 200 busy of 300
  assert.deepEqual(core.parsePidStat('123 (my (odd) name) S 7 1 1 0 -1 0 0 0 0 0 40 60 0 0 20 0 1 0 5 0 0'), { comm: 'my (odd) name', ppid: 7, ticks: 100 })
  const net = core.parseNetDev('h1\nh2\n    lo: 500 0 0 0 0 0 0 0 500 0\n  eth0: 1000 0 0 0 0 0 0 0 2000 0\n')
  assert.deepEqual(net, { rx: 1000, tx: 2000 })                                        // loopback is not counted
  assert.equal(Math.round(core.parseMemAvailGB('MemTotal: 1\nMemAvailable:   2097152 kB\n')), 2)
  const f = core.fitLine([[2, 11], [4, 19], [6, 27]])
  assert.ok(Math.abs(f.b - 4) < 1e-9 && Math.abs(f.a - 3) < 1e-9)
  assert.equal(core.fitLine([[2, 5]]), null)
})

test('ramps to the maximum cleanly and estimates capacity from the server-side CPU', async () => {
  const { d, w } = fakeWorld()
  const r = await core.runCapacityTest({ streamsMax: 8, step: 4, stepSec: 15, warmSec: 5, whepReaders: 0 }, d)
  assert.equal(r.phase, 'done'); assert.equal(r.aborted, '')
  assert.deepEqual(r.steps.map(s => [s.streams, s.verdict]), [[4, 'clean'], [8, 'clean']])
  assert.ok(Math.abs(r.steps[1].serverCpu - 35) < 2, 'server-side CPU leaves out the generator: ' + r.steps[1].serverCpu)
  assert.ok(r.steps[1].generatorCpu > 5 && r.steps[1].generatorCpu < 11)
  assert.equal(r.steps[1].readers, 16)                                                  // 8 streams x (1 srt + 1 rtsp)
  assert.ok(Math.abs(r.estimate.serverCpuPerStreamPctOfOneCore - 16) < 1.5)            // 4% of 4 cores
  assert.ok(Math.abs(r.estimate.streamsAt70PctCpu - 16) <= 1)                          // (70 - 3) / 4
  assert.match(r.conclusion, /Clean through 8 streams/); assert.match(r.conclusion, /limit is higher than this run/)
  assert.equal(w.stopped.length, w.started.length, 'everything started is stopped')
  assert.ok(r.steps[1].top.some(t => t[0] === 'mediamtx'), 'busiest processes are listed')
})

test('stops at the first step where readers fall behind, and says so', async () => {
  const { d, w } = fakeWorld({ failAt: 6 })
  const r = await core.runCapacityTest({ streamsMax: 20, step: 2, stepSec: 15, warmSec: 5 }, d)
  assert.deepEqual(r.steps.map(s => s.verdict), ['clean', 'clean', 'clean', 'strained'])
  assert.equal(r.steps[3].streams, 8)
  assert.match(r.conclusion, /Clean through 6 streams/); assert.match(r.conclusion, /readers fell behind/)
  assert.equal(w.stopped.length, w.started.length)
})

test('a failed pre-flight stops the test before anything is ramped, and says why', async () => {
  const { d, w } = fakeWorld({ preflight: { ok: false, message: "this server's ffmpeg has no SRT support" } })
  const r = await core.runCapacityTest({ streamsMax: 8, step: 2 }, d)
  assert.match(r.conclusion, /could not start: this server's ffmpeg has no SRT support/)
  assert.equal(r.steps.length, 0); assert.equal(w.started.length, 0, 'no stream was started')
  const ok = await core.runCapacityTest({ streamsMax: 2, step: 2, stepSec: 15, warmSec: 5 }, fakeWorld({ preflight: { ok: true } }).d)
  assert.equal(ok.steps[0].verdict, 'clean')
})

test('when readers get nothing, the errors from the test processes are in the conclusion', async () => {
  const { d } = fakeWorld({ failAt: 0, diagnostics: ['CT-1 srt reader exited (1): Connection setup failure', 'CT-1 publisher exited (1): Error opening output file'] })
  const r = await core.runCapacityTest({ streamsMax: 4, step: 2, stepSec: 15, warmSec: 5 }, d)
  assert.match(r.aborted, /Errors from the test processes: CT-1 srt reader exited \(1\): Connection setup failure/)
  assert.deepEqual(r.diagnostics.length, 2)
})

test('carries on with decoder-style readers when the mediamtx readers get nothing', async () => {
  const { d } = fakeWorld({ rtspDown: true })
  const r = await core.runCapacityTest({ streamsMax: 4, step: 2, stepSec: 15, warmSec: 5, whepReaders: 0 }, d)
  assert.equal(r.aborted, ''); assert.deepEqual(r.steps.map(s => s.verdict), ['clean', 'clean'])
  assert.equal(r.steps[1].readers, 4)                                                   // only the 4 SRT readers are counted
  assert.match(r.note, /RTSP/); assert.match(r.conclusion, /RTSP/)
})

test('WebRTC viewers are measured as readers, and left out with a note when they cannot work', async () => {
  const cfg = { streamsMax: 4, step: 2, stepSec: 15, warmSec: 5, whepReaders: 2 }
  const ok = await core.runCapacityTest(cfg, fakeWorld().d)
  assert.equal(ok.steps[1].readers, 4 * (1 + 1 + 2)); assert.match(ok.conclusion, /2 as a real WebRTC viewer/)

  const down = await core.runCapacityTest(cfg, fakeWorld({ whepDown: true }).d)
  assert.equal(down.aborted, ''); assert.equal(down.steps[1].readers, 8); assert.match(down.note, /WebRTC viewers received no data/)
  assert.doesNotMatch(down.conclusion, /real WebRTC viewer/)

  const { d, w } = fakeWorld({ whepFails: 'mediamtx too old' })
  const broke = await core.runCapacityTest(cfg, d)
  assert.equal(broke.aborted, ''); assert.match(broke.note, /could not be started \(mediamtx too old\)/)
  assert.equal(w.stopped.length, w.started.length)
})

test('stops when the CPU stays too high', async () => {
  const { d } = fakeWorld({ perStream: 6 })                                              // sys = 3 + 7n: 6 streams 45%, 12 -> 87%, 14 -> 100%
  const r = await core.runCapacityTest({ streamsMax: 20, step: 2, stepSec: 30, warmSec: 5, cpuStopPct: 90 }, d)
  assert.match(r.aborted, /CPU stayed above 90%/)
  assert.ok(r.steps.length >= 2 && r.steps[r.steps.length - 1].verdict === 'stopped')
})

test('stops when memory runs low', async () => {
  const { d } = fakeWorld({ mem: 0.5 })
  const r = await core.runCapacityTest({ streamsMax: 8, step: 2, stepSec: 15, warmSec: 5 }, d)
  assert.match(r.aborted, /free memory/)
})

test('does not start while live streams are on air, unless told to; protects them once started', async () => {
  const live = [{ name: 'Studio A', kbps: 10000 }]
  const refused = await core.runCapacityTest({ streamsMax: 4, step: 2 }, fakeWorld({ live }).d)
  assert.match(refused.aborted, /live streams on air/); assert.equal(refused.steps.length, 0)

  const dropping = w => [{ name: 'Studio A', kbps: w.streams >= 4 ? 5000 : 10000 }]    // the real stream suffers once 4 test streams run
  const { d, w } = fakeWorld({ live: dropping })
  const r = await core.runCapacityTest({ streamsMax: 12, step: 2, stepSec: 30, warmSec: 5, allowLive: true }, d)
  assert.match(r.aborted, /live stream was affected \(Studio A\)/)
  assert.ok(r.steps[r.steps.length - 1].streams <= 4)
  assert.equal(w.stopped.length, w.started.length)
})

test('stops when asked to, and cleans up', async () => {
  const { d, w } = fakeWorld({ stopAfterSec: 20 })
  const r = await core.runCapacityTest({ streamsMax: 12, step: 2, stepSec: 60, warmSec: 5 }, d)
  assert.equal(r.aborted, 'stopped by you')
  assert.equal(w.stopped.length, w.started.length)
})

test('settings are clamped to safe ranges', () => {
  const c = core.defaults({ streamsMax: 9999, step: 0, stepSec: 1, srtReaders: 50, cpuStopPct: 5, allowLive: 'yes' })
  assert.deepEqual([c.streamsMax, c.step, c.stepSec, c.srtReaders, c.cpuStopPct, c.allowLive], [60, 1, 15, 3, 50, false])
})
