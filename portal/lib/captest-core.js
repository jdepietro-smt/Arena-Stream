'use strict'
// Capacity test: how many 10 Mbps streams can this server carry? The runner publishes synthetic streams to the
// relay (loopback, from a looped sample, -c copy) and reads each back twice, as a decoder PC would (SRT, through the
// relay) and as a browser viewer would (through mediamtx). Every second it samples CPU, memory, network and
// per-process load. It ramps the stream count and stops at the first sign of strain.
//
// All the I/O goes through `d` (real in captest.js, simulated in the tests), so the logic here is plain data.

// ── /proc parsing ─────────────────────────────────────────────────────────────
function parseProcStat(text) {   // first line: cpu user nice system idle iowait irq softirq steal ...
  const f = String(text).split('\n')[0].trim().split(/\s+/).slice(1).map(Number)
  const idle = (f[3] || 0) + (f[4] || 0)
  return { total: f.reduce((a, b) => a + (b || 0), 0), idle }
}
function cpuPct(a, b) {
  const dt = b.total - a.total
  return dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - (b.idle - a.idle) / dt))) : 0
}
function parsePidStat(text) {   // pid (comm) state ppid ... utime stime ...; comm can hold spaces and brackets
  const s = String(text), i = s.indexOf('('), j = s.lastIndexOf(')')
  if (i < 0 || j < 0) return null
  const rest = s.slice(j + 2).split(' ')
  return { comm: s.slice(i + 1, j), ppid: Number(rest[1]), ticks: Number(rest[11]) + Number(rest[12]) }
}
function parseNetDev(text) {   // bytes received and sent, all interfaces but lo
  let rx = 0, tx = 0
  for (const l of String(text).split('\n').slice(2)) {
    const [name, rest] = l.split(':'); if (!rest || name.trim() === 'lo') continue
    const f = rest.trim().split(/\s+/).map(Number); rx += f[0] || 0; tx += f[8] || 0
  }
  return { rx, tx }
}
const parseMemAvailGB = text => { const m = /MemAvailable:\s+(\d+)/.exec(text); return m ? Number(m[1]) / 1048576 : 0 }

// ── per-step numbers ──────────────────────────────────────────────────────────
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0 }

// Least-squares line y = a + b*x; with fewer than two distinct x it returns null.
function fitLine(points) {
  const n = points.length
  if (n < 2) return null
  const mx = points.reduce((s, p) => s + p[0], 0) / n, my = points.reduce((s, p) => s + p[1], 0) / n
  const sxx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0)
  if (sxx === 0) return null
  const b = points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx
  return { a: my - b * mx, b }
}

function defaults(cfg = {}) {
  const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def }
  return {
    streamsMax: num(cfg.streamsMax, 1, 60, 20), step: num(cfg.step, 1, 10, 2), stepSec: num(cfg.stepSec, 15, 120, 40), warmSec: num(cfg.warmSec, 5, 30, 10),
    srtReaders: num(cfg.srtReaders, 0, 3, 1), rtspReaders: num(cfg.rtspReaders, 0, 3, 1), whepReaders: num(cfg.whepReaders, 0, 3, 1), cpuStopPct: num(cfg.cpuStopPct, 50, 98, 90),
    allowLive: cfg.allowLive === true, cores: num(cfg.cores, 1, 256, 4),
  }
}

// ── the run ───────────────────────────────────────────────────────────────────
// d: { now(), sleep(ms), sample() -> {stat, net, mem, load, procs:[{pid,comm,ppid,ticks}]}, selfPid,
//      live() -> [{name,kbps}], prepareSample() -> {mbps}, start(kind, i) -> handle{stop(), stats()}, stopped() -> bool,
//      preflight() -> {ok, message}, diagnostics() -> [string], progress(status), cores }
// A reader handle's stats(since) gives {bytes, mediaUs, maxGapSec}, the gap being the longest silence after time `since`.
async function runCapacityTest(rawCfg, d) {
  const cfg = defaults(rawCfg)
  cfg.cores = d.cores || cfg.cores
  const status = { phase: 'starting', startedAt: d.now(), cfg, steps: [], now: null, note: '' }
  const publish = () => d.progress(JSON.parse(JSON.stringify(status)))
  const finish = (conclusion, aborted) => {
    status.phase = 'done'; status.conclusion = conclusion; status.aborted = aborted || ''; status.finishedAt = d.now(); publish(); return status
  }

  const liveAtStart = (await d.live()).filter(s => !/^CT-/.test(s.name))
  if (liveAtStart.length && !cfg.allowLive) return finish(`Not started: ${liveAtStart.length} live stream(s) are on air (${liveAtStart.map(s => s.name).join(', ')}).`, 'live streams on air')
  const liveBase = Object.fromEntries(liveAtStart.map(s => [s.name, s.kbps]))

  status.phase = 'preparing'; publish()
  const sample = await d.prepareSample()
  status.expectedMbps = sample.mbps
  if (d.preflight) {
    status.phase = 'checking'; publish()
    const pre = await d.preflight()
    if (!pre.ok) return finish(`The test could not start: ${pre.message}`, pre.message)
  }
  const handles = { pub: [], srt: [], rtsp: [], whep: [] }
  const stopAll = async () => { for (const k of Object.keys(handles)) for (const h of handles[k]) { try { await h.stop() } catch { /* gone */ } } }

  const skip = new Set()   // reader kinds that could not be measured (for example mediamtx RTSP switched off)
  let aborted = '', hotRun = 0, liveBad = 0, prevSample = await d.sample(), lastClean = 0, firstStrain = null
  const cpuPoints = []   // [streams, server-side cpu %]
  try {
    for (let n = cfg.step; n <= cfg.streamsMax && !aborted; n += cfg.step) {
      n = Math.min(n, cfg.streamsMax)
      status.phase = 'ramping'; status.step = n; publish()
      for (let i = handles.pub.length + 1; i <= n; i++) {
        handles.pub.push(await d.start('pub', i))
        await d.sleep(300)
        for (let k = 0; k < cfg.srtReaders; k++) handles.srt.push(await d.start('srt', i))
        for (let k = 0; k < cfg.rtspReaders; k++) handles.rtsp.push(await d.start('rtsp', i))
        for (let k = 0; k < cfg.whepReaders && !skip.has('whep'); k++) {
          try { handles.whep.push(await d.start('whep', i)) }
          catch (e) { skip.add('whep'); status.note = (status.note ? status.note + ' ' : '') + 'WebRTC viewers could not be started (' + e.message + '), so they were left out.' }
        }
      }
      const rec = { streams: n, cpu: [], gen: [], net: [], load: 0, memMin: 1e9, top: {} }
      let t0 = null, snap0 = null
      const total = cfg.warmSec + cfg.stepSec
      for (let s = 0; s < total && !aborted; s++) {
        await d.sleep(1000)
        if (d.stopped()) { aborted = 'stopped by you'; break }
        const cur = await d.sample()
        const sys = cpuPct(prevSample.stat, cur.stat)
        const jiffies = cur.stat.total - prevSample.stat.total
        const prevTicks = new Map(prevSample.procs.map(p => [p.pid, p.ticks]))
        let gen = 0; const byComm = {}
        for (const p of cur.procs) {
          const delta = p.ticks - (prevTicks.get(p.pid) ?? p.ticks)
          const isGen = p.pid === d.selfPid || p.ppid === d.selfPid
          if (isGen) gen += delta; else byComm[p.comm] = (byComm[p.comm] || 0) + delta
        }
        const genPct = jiffies > 0 ? 100 * gen / jiffies : 0
        const dt = (cur.t - prevSample.t) / 1000 || 1
        const netMbps = { rx: (cur.net.rx - prevSample.net.rx) * 8 / dt / 1e6, tx: (cur.net.tx - prevSample.net.tx) * 8 / dt / 1e6 }
        status.now = { t: d.now(), streams: n, cpu: +sys.toFixed(1), generatorCpu: +genPct.toFixed(1), serverCpu: +Math.max(0, sys - genPct).toFixed(1), load1: cur.load[0], memAvailGB: +cur.mem.toFixed(1), netRxMbps: +netMbps.rx.toFixed(0), netTxMbps: +netMbps.tx.toFixed(0), phase: s < cfg.warmSec ? 'warming up' : 'measuring' }
        if (s === cfg.warmSec) { t0 = d.now(); snap0 = handles.srt.concat(handles.rtsp, handles.whep).map(h => ({ h, ...h.stats() })) }
        if (s >= cfg.warmSec) {
          rec.cpu.push(sys); rec.gen.push(genPct); rec.net.push(netMbps); rec.load = Math.max(rec.load, cur.load[0]); rec.memMin = Math.min(rec.memMin, cur.mem)
          for (const [c, t] of Object.entries(byComm)) rec.top[c] = (rec.top[c] || 0) + (jiffies > 0 ? 100 * t / jiffies : 0)
        }
        // guards, every second
        hotRun = sys > cfg.cpuStopPct ? hotRun + 1 : 0
        if (hotRun >= 8) aborted = `CPU stayed above ${cfg.cpuStopPct}% for 8 s`
        else if (cur.mem < 1) aborted = 'free memory fell below 1 GB'
        else if (cur.load[0] > cfg.cores * 2.5) aborted = `load average passed ${(cfg.cores * 2.5).toFixed(0)}`
        const live = await d.live()
        const lost = Object.keys(liveBase).filter(k => { const e = live.find(x => x.name === k); return !e || e.kbps < 0.8 * liveBase[k] })
        liveBad = lost.length ? liveBad + 1 : 0
        if (liveBad >= 5) aborted = `a live stream was affected (${lost.join(', ')})`
        prevSample = cur
        status.liveStreams = live.filter(x => !/^CT-/.test(x.name)).length
        publish()
      }
      if (aborted && !rec.cpu.length) break

      // step results
      const t1 = d.now()
      const readers = snap0 ? snap0.map(s0 => { const s1 = s0.h.stats(t0); const secs = (t1 - t0) / 1000
        return secs > 0 ? { mbps: (s1.bytes - s0.bytes) * 8 / secs / 1e6, speed: (s1.mediaUs - s0.mediaUs) / 1e6 / secs, maxGap: s1.maxGapSec, kind: s0.h.kind } : null }).filter(Boolean) : []
      const rtspAll = readers.filter(r => r.kind === 'rtsp')
      if (rtspAll.length && rtspAll.every(r => r.mbps < 0.1) && readers.some(r => r.kind === 'srt' && r.mbps >= 0.85 * sample.mbps)) {
        skip.add('rtsp'); status.note = 'The mediamtx-side readers (RTSP) received no data, so only the decoder-style readers were measured. Is RTSP switched off in mediamtx?'
      }
      const whepAll = readers.filter(r => r.kind === 'whep')
      if (!skip.has('whep') && whepAll.length && whepAll.every(r => r.mbps < 0.1) && readers.some(r => r.kind === 'srt' && r.mbps >= 0.85 * sample.mbps)) {
        skip.add('whep'); status.note = (status.note ? status.note + ' ' : '') + 'The WebRTC viewers received no data (is WebRTC reachable from this server to itself?), so they were left out of the measurement.'
      }
      const measured = readers.filter(r => !skip.has(r.kind))
      const bad = measured.filter(r => r.mbps < 0.85 * sample.mbps || r.speed < 0.9 || r.maxGap > 1.5)
      const cpu = rec.cpu.length ? rec.cpu.reduce((a, b) => a + b, 0) / rec.cpu.length : 0
      const gen = rec.gen.length ? rec.gen.reduce((a, b) => a + b, 0) / rec.gen.length : 0
      const top = Object.entries(rec.top).map(([c, v]) => [c, +(v / Math.max(1, rec.cpu.length)).toFixed(1)]).sort((a, b) => b[1] - a[1]).slice(0, 4)
      const step = {
        streams: n, readers: measured.length, cpuAvg: +cpu.toFixed(1), cpuMax: +Math.max(0, ...rec.cpu).toFixed(1), generatorCpu: +gen.toFixed(1), serverCpu: +Math.max(0, cpu - gen).toFixed(1),
        load1Max: rec.load, memAvailMinGB: +rec.memMin.toFixed(1), netRxMbps: +median(rec.net.map(x => x.rx)).toFixed(0), netTxMbps: +median(rec.net.map(x => x.tx)).toFixed(0),
        readerMbpsMin: +(measured.length ? Math.min(...measured.map(r => r.mbps)) : 0).toFixed(2), readerMbpsMedian: +median(measured.map(r => r.mbps)).toFixed(2),
        readerSpeedMin: +Math.min(...measured.map(r => r.speed), 1).toFixed(2), maxGapSec: +Math.max(0, ...measured.map(r => r.maxGap)).toFixed(2), strained: bad.length, top,
        verdict: aborted ? 'stopped' : bad.length ? 'strained' : 'clean',
      }
      status.steps.push(step)
      if (step.verdict === 'clean') { lastClean = n; cpuPoints.push([n, step.serverCpu]) }
      else if (!firstStrain) firstStrain = step
      publish()
      if (!aborted && bad.length) {
        aborted = `${bad.length} of ${measured.length} readers fell behind (slowest ${step.readerMbpsMin} Mbps against ${sample.mbps.toFixed(1)}, or stalled)`
        const diag = d.diagnostics ? await d.diagnostics() : []
        if (diag.length) { status.diagnostics = diag; aborted += '. Errors from the test processes: ' + diag.slice(0, 3).join(' | ') }
      }
      if (n >= cfg.streamsMax) break
    }
  } finally { await stopAll() }

  const fit = fitLine(cpuPoints)
  const parts = []
  if (lastClean) parts.push(`Clean through ${lastClean} streams at ${sample.mbps.toFixed(1)} Mbps (each read back ${cfg.srtReaders} time${cfg.srtReaders === 1 ? '' : 's'} like a decoder${skip.has('rtsp') || !cfg.rtspReaders ? '' : `, ${cfg.rtspReaders} through mediamtx`}${skip.has('whep') || !cfg.whepReaders ? '' : `, ${cfg.whepReaders} as a real WebRTC viewer`}).`)
  if (status.note) parts.push(status.note)
  else if (!lastClean) parts.push('No step finished clean.')
  if (aborted) parts.push(`Stopped: ${aborted}.`)
  else if (lastClean >= cfg.streamsMax) parts.push('Reached the requested maximum without strain, so the limit is higher than this run.')
  if (fit && fit.b > 0) {
    const perStream = fit.b * cfg.cores   // % of one core: the fit is in % of all cores
    const cap = Math.max(0, Math.floor((70 - fit.a) / fit.b))
    status.estimate = { serverCpuPerStreamPctOfOneCore: +perStream.toFixed(1), baselinePct: +fit.a.toFixed(1), streamsAt70PctCpu: cap }
    parts.push(`The server itself used about ${perStream.toFixed(0)}% of one core per stream (relay, mediamtx and the network stack, without the test generator). At 70% of all ${cfg.cores} cores that is roughly ${cap} streams. Browser viewers add WebRTC encryption on top, which this test does not exercise.`)
  }
  return finish(parts.join(' '), aborted)
}

module.exports = { parseProcStat, cpuPct, parsePidStat, parseNetDev, parseMemAvailGB, fitLine, median, defaults, runCapacityTest }
