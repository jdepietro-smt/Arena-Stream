#!/usr/bin/env node
'use strict'
// Capacity test runner, for the server. Started from the Admin page (through the root helper, as its own
// transient service so the portal's CPU limit does not hold it back), or by hand:
//   node /opt/arena-portal/captest.js [--streams 20] [--step 2] [--step-sec 40] [--allow-live]
//   node /opt/arena-portal/captest.js --preflight     (only checks that one stream goes through the relay and back)
// Needs ffmpeg with SRT, the relay on 127.0.0.1:8895 and mediamtx. Reads LINK_KEY, DIRECTORY_URL, MEDIAMTX_API,
// RELAY_SRT from the environment (the portal's /etc/arena-portal/env). Writes status.json and history.json to the output dir.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const core = require('./lib/captest-core')

const argv = process.argv.slice(2)
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def }
const OUT = arg('--out', process.env.CAPTEST_DIR || '/var/lib/arena-portal/captest')
let cfg = {}
if (arg('--config')) { try { cfg = JSON.parse(fs.readFileSync(arg('--config'), 'utf8')) } catch (e) { console.error('bad config: ' + e.message); process.exit(2) } }
else cfg = { streamsMax: arg('--streams'), step: arg('--step'), stepSec: arg('--step-sec'), allowLive: argv.includes('--allow-live') }

const FFMPEG = process.env.PORTAL_FFMPEG || 'ffmpeg'
const DIRECTORY = (process.env.DIRECTORY_URL || 'http://127.0.0.1:8002').replace(/\/$/, '')
const KEY = process.env.LINK_KEY || ''
const MTX_API = (process.env.MEDIAMTX_API || 'http://127.0.0.1:9997').replace(/\/$/, '')
const MTX_RTSP = (process.env.MEDIAMTX_RTSP || 'rtsp://127.0.0.1:8554').replace(/\/$/, '')
const RELAY = process.env.RELAY_SRT || '127.0.0.1:8895'
const MTX_WEBRTC = (process.env.MEDIAMTX_WEBRTC || 'http://127.0.0.1:8889').replace(/\/$/, '')
const MTX_BIN = process.env.MEDIAMTX_BIN || '/usr/local/bin/mediamtx'
const VIEW_API = 'http://127.0.0.1:19997', VIEW_RTSP = 'rtsp://127.0.0.1:18554'   // the viewer simulator's own ports
fs.mkdirSync(OUT, { recursive: true })

let stopRequested = false
// The page counts a status file nobody has touched for 15 s as a dead run, so keep it fresh even while a slow step blocks the runner.
setInterval(() => { try { const t = new Date(); fs.utimesSync(path.join(OUT, 'status.json'), t, t) } catch { /* no status yet */ } }, 4000).unref()
process.on('SIGTERM', () => { stopRequested = true })
process.on('SIGINT', () => { stopRequested = true })

const writeJson = (file, obj) => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, file) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = new Set()
const handles = []   // every publisher and reader, for the error report
// ffmpeg's errors repeat the stream URL, and the publish URL carries the relay secret: it must never reach the page or the history.
let secret = ''
const scrub = t => { let s = String(t || '').replace(/\r/g, ''); if (secret) s = s.split(secret).join('***'); return s.replace(/(streamid=publish:[^:&\s]+:)[^&\s]+/g, '$1***') }
const tail = (t, n = 2, max = 220) => scrub(t).trim().split('\n').slice(-n).join(' / ').slice(0, max)

async function dirGet(p) {
  const r = await fetch(DIRECTORY + p, { headers: { 'X-Arena-Key': KEY }, signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`directory ${r.status}`)
  return r.json()
}

// One ffmpeg child. Its last words (stderr) are kept so a failure can be explained.
// A reader's media goes to stdout (counted here, then dropped) and its -progress lines to stderr, so the byte count does
// not depend on ffmpeg's own total_size, which is not reported for devices such as /dev/null.
function launch(args, h) {
  const p = spawn(FFMPEG, args, { stdio: ['ignore', h ? 'pipe' : 'ignore', 'pipe'] })
  p.err = ''
  if (!h) p.stderr.on('data', d => { p.err = (p.err + d).slice(-500) })
  else {
    p.stdout.on('data', d => { h.bytes += d.length })
    let ebuf = ''
    p.stderr.on('data', d => {
      ebuf += d; const lines = ebuf.split('\n'); ebuf = lines.pop()
      for (const l of lines) {
        if (l.startsWith('out_time_us=')) h.mediaUs = Number(l.slice(12)) || h.mediaUs
        else if (l.startsWith('progress=')) { const now = Date.now(); if (h.last) h.gaps.push([now, (now - h.last) / 1000]); h.last = now; if (h.gaps.length > 400) h.gaps.splice(0, 100) }
        else if (!/^[a-z_0-9]+=/.test(l)) p.err = (p.err + l + '\n').slice(-500)   // progress is key=value; anything else is an error message
      }
    })
  }
  children.add(p); p.on('close', () => children.delete(p))
  p.on('error', e => { p.err = 'could not run ffmpeg: ' + e.message })
  return p
}
const killProc = p => new Promise(res => { if (!p || p.exitCode !== null) return res(); p.once('close', res); p.kill('SIGTERM'); setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } }, 1500) })

// A publisher or reader that dies before any data has flowed is started again (a few times): the relay or mediamtx
// may simply not have been ready for it yet.
function managed(name, kind, build, readerStats) {
  const h = { name, kind, stopped: false, restarts: 0, bytes: 0, mediaUs: 0, last: 0, gaps: [], p: null, exits: [] }
  const run = () => {
    const p = launch(build(), readerStats ? h : null)
    h.p = p
    p.on('close', code => {
      if (h.stopped) return
      h.exits.push(`${name} ${kind} exited (${code}): ${tail(p.err)}`)
      if (h.restarts < 6 && h.bytes === 0) { h.restarts++; setTimeout(() => { if (!h.stopped) run() }, 1500) }
    })
  }
  run()
  h.stats = since => ({ bytes: h.bytes, mediaUs: h.mediaUs, maxGapSec: Math.max(0, ...h.gaps.filter(g => !since || g[0] >= since).map(g => g[1]), h.last && Date.now() - h.last > 3000 ? (Date.now() - h.last) / 1000 : 0) })
  h.stop = async () => { h.stopped = true; await killProc(h.p) }
  handles.push(h)
  return h
}

const mtxPaths = new Set()
async function ensureMtxPath(i) {
  const name = `captest_CT-${i}`
  const body = { source: `srt://${RELAY}?streamid=read:CT-${i}&mode=caller&latency=150`, sourceOnDemand: true, sourceOnDemandStartTimeout: '10s', sourceOnDemandCloseAfter: '10s' }
  const r = await fetch(`${MTX_API}/v3/config/paths/add/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
  if (!r.ok && r.status !== 400) throw new Error(`mediamtx ${r.status}`)
  mtxPaths.add(name)
  return name
}
async function dropMtxPaths() {
  for (const name of mtxPaths) { try { await fetch(`${MTX_API}/v3/config/paths/delete/${encodeURIComponent(name)}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) }) } catch { /* mediamtx may be gone */ } }
  mtxPaths.clear()
}

// WebRTC viewers: a second mediamtx (the "viewer host") pulls each stream from the real one over WHEP, exactly as a browser
// does, so the real mediamtx does the WebRTC work (DTLS/SRTP) it would do for people. The viewer host is our child process,
// so its own CPU is counted with the generator and left out of the server's numbers; an ffmpeg reads each viewer for counting.
let viewerHost = null
async function ensureViewerHost() {
  if (viewerHost) { if (viewerHost.exitCode !== null) throw new Error('the viewer host stopped: ' + tail(viewerHost.err)); return }
  if (!fs.existsSync(MTX_BIN)) throw new Error(MTX_BIN + ' was not found')
  const conf = path.join(OUT, 'viewer-host.yml')
  // mediamtx versions differ in which settings they know (an unknown one is a fatal error), so try a few shapes of config.
  // Its log goes to stdout, so both streams are kept. It must not share a port with the real mediamtx.
  const base = ['logLevel: warn', 'api: yes', 'apiAddress: 127.0.0.1:19997', 'rtspAddress: 127.0.0.1:18554', 'rtpAddress: 127.0.0.1:18000', 'rtcpAddress: 127.0.0.1:18001',
    'rtmp: no', 'hls: no', 'webrtc: no']
  const variants = [[...base, 'srt: no', 'rtspTransports: [tcp]', 'paths:', '  all_others:'], [...base, 'rtspTransports: [tcp]', 'paths:', '  all_others:'], [...base, 'srt: no'], base]
  let last = ''
  for (const lines of variants) {
    fs.writeFileSync(conf, lines.join('\n') + '\n')
    const p = spawn(MTX_BIN, [conf], { stdio: ['ignore', 'pipe', 'pipe'], cwd: OUT })
    p.err = ''
    const keep = d => { p.err = (p.err + d).slice(-600) }
    p.stdout.on('data', keep); p.stderr.on('data', keep); p.on('error', e => { p.err = e.message })
    children.add(p); p.on('close', () => children.delete(p))
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      if (p.exitCode !== null) break
      try { if ((await fetch(VIEW_API + '/v3/config/global/get', { signal: AbortSignal.timeout(1000) })).ok) { viewerHost = p; return } } catch { /* not up yet */ }
    }
    last = tail(p.err.replace(/\x1b\[[0-9;]*m/g, ''), 3, 300) || ('exit code ' + p.exitCode)
    await killProc(p)
  }
  throw new Error('the viewer host would not start: ' + last)
}
async function ensureViewerPath(i) {
  await ensureViewerHost()
  const name = `viewer_CT-${i}`
  const r = await fetch(`${VIEW_API}/v3/config/paths/add/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: `${MTX_WEBRTC.replace(/^http/, 'whep')}/captest_CT-${i}/whep`, sourceOnDemand: false }), signal: AbortSignal.timeout(3000) })
  if (!r.ok && r.status !== 400) throw new Error('the viewer host refused the WebRTC source (' + r.status + '; is mediamtx new enough for WHEP sources?)')
  return name
}

let sampleFile = ''
const pubArgs = i => ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', sampleFile, '-c', 'copy', '-f', 'mpegts', `srt://${RELAY}?streamid=publish:CT-${i}:${secret}&mode=caller&latency=150`]
const srtReadArgs = i => ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats', '-i', `srt://${RELAY}?streamid=read:CT-${i}&mode=caller&latency=150`, '-c', 'copy', '-f', 'mpegts', 'pipe:1']

async function preflight() {
  const prot = spawnSync(FFMPEG, ['-hide_banner', '-protocols'], { encoding: 'utf8' })
  if (prot.status !== 0) return { ok: false, message: 'ffmpeg could not run: ' + scrub(String(prot.error || prot.stderr)).slice(0, 200) }
  if (!/^\s*srt\s*$/m.test(prot.stdout || '')) return { ok: false, message: 'this server\'s ffmpeg has no SRT support, so it cannot publish to or read from the relay. Install an ffmpeg built with libsrt (the Ubuntu package has it).' }
  // One stream, end to end, before anything is ramped: if this does not work the ramp would only fail the same way.
  const pub = managed('CT-0', 'publisher', () => pubArgs(0), false)
  const rd = managed('CT-0', 'reader', () => srtReadArgs(0), true)
  let ok = false
  for (let s = 0; s < 15 && !stopRequested; s++) { await sleep(1000); if (rd.bytes > 200000) { ok = true; break } }
  const problems = handles.flatMap(h => h.exits).slice(0, 3).concat([pub.p && pub.p.err, rd.p && rd.p.err].filter(Boolean).map(x => tail(x)))
  await pub.stop(); await rd.stop()
  handles.length = 0
  if (!ok) return { ok: false, message: 'a single test stream published to the relay at ' + RELAY + ' was not received back within 15 s.' + (problems.length ? ' ffmpeg said: ' + problems.join(' | ') : ' ffmpeg printed no error, so check that the relay service is running and listening on UDP 8895.') }
  return { ok: true }
}

async function world() {
  secret = (await dirGet('/v1/config')).relaySecret || ''
  sampleFile = path.join(OUT, 'sample-10m.ts')
  return {
    now: () => Date.now(), sleep, selfPid: process.pid, cores: os.cpus().length,
    stopped: () => stopRequested,
    progress: s => writeJson(path.join(OUT, 'status.json'), s),
    live: async () => { try { return (await dirGet('/v1/encoders')).encoders.map(e => ({ name: e.name, kbps: e.kbps })) } catch { return [] } },
    prepareSample: async () => {
      if (!fs.existsSync(sampleFile) || fs.statSync(sampleFile).size < 5e6) {
        const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30000/1001', '-vf', 'noise=alls=25:allf=t+u,format=yuv420p', '-t', '20',
          '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '10M', '-minrate', '10M', '-maxrate', '10M', '-bufsize', '5M', '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-g', '30', '-bf', '0', '-an', '-f', 'mpegts', sampleFile], { timeout: 180000 })
        if (r.status !== 0 || !fs.existsSync(sampleFile)) throw new Error('could not make the 10 Mbps sample: ' + String(r.error || r.stderr || '').slice(0, 200))
      }
      return { mbps: fs.statSync(sampleFile).size * 8 / 20 / 1e6 }
    },
    preflight,
    diagnostics: async () => {
      const out = []
      for (const h of handles) { for (const e of h.exits.slice(-1)) out.push(e); if (!h.exits.length && h.bytes === 0 && h.p && h.p.err) out.push(`${h.name} ${h.kind}: ${tail(h.p.err, 2, 200)}`) }
      return [...new Set(out)]
    },
    start: async (kind, i) => {
      if (kind === 'pub') return managed(`CT-${i}`, 'publisher', () => pubArgs(i), false)
      if (kind === 'srt') return managed(`CT-${i}`, 'srt reader', () => srtReadArgs(i), true)
      const name = await ensureMtxPath(i)
      if (kind === 'whep') {
        const v = await ensureViewerPath(i)
        return managed(`CT-${i}`, 'webrtc viewer', () => ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats', '-rtsp_transport', 'tcp', '-i', `${VIEW_RTSP}/${v}`, '-c', 'copy', '-f', 'mpegts', 'pipe:1'], true)
      }
      return managed(`CT-${i}`, 'rtsp reader', () => ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats', '-rtsp_transport', 'tcp', '-i', `${MTX_RTSP}/${name}`, '-c', 'copy', '-f', 'mpegts', 'pipe:1'], true)
    },
    sample: async () => {
      const procs = []
      for (const e of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(e)) continue
        try { const s = core.parsePidStat(fs.readFileSync(`/proc/${e}/stat`, 'utf8')); if (s) procs.push({ pid: Number(e), ...s }) } catch { /* process ended */ }
      }
      return { t: Date.now(), stat: core.parseProcStat(fs.readFileSync('/proc/stat', 'utf8')), net: core.parseNetDev(fs.readFileSync('/proc/net/dev', 'utf8')),
        mem: core.parseMemAvailGB(fs.readFileSync('/proc/meminfo', 'utf8')), load: os.loadavg(), procs }
    },
  }
}

;(async () => {
  if (argv.includes('--preflight')) {   // just the end-to-end check: node captest.js --preflight
    try { await world(); const r = await preflight(); console.log(JSON.stringify(r)); process.exitCode = r.ok ? 0 : 1 } catch (e) { console.log(JSON.stringify({ ok: false, message: e.message })); process.exitCode = 1 }
    for (const p of children) { try { p.kill('SIGKILL') } catch { /* gone */ } }
    process.exit()
  }
  let status
  try {
    const d = await world()
    status = await core.runCapacityTest(cfg, d)
  } catch (e) {
    status = { phase: 'done', conclusion: 'The test could not run: ' + e.message, aborted: e.message, steps: [], finishedAt: Date.now() }
    writeJson(path.join(OUT, 'status.json'), status)
  } finally {
    for (const p of children) { try { p.kill('SIGKILL') } catch { /* gone */ } }
    await dropMtxPaths()
  }
  const hist = path.join(OUT, 'history.json')
  let h = []; try { h = JSON.parse(fs.readFileSync(hist, 'utf8')) } catch { /* first run */ }
  h.unshift({ at: status.startedAt || Date.now(), cfg: status.cfg, expectedMbps: status.expectedMbps, steps: status.steps, conclusion: status.conclusion, aborted: status.aborted, estimate: status.estimate, diagnostics: status.diagnostics })
  writeJson(hist, h.slice(0, 10))
  console.log(status.conclusion)
  process.exit(0)
})()
