#!/usr/bin/env node
'use strict'
// Capacity test runner, for the server. Started from the Admin page (through the root helper, as its own
// transient service so the portal's CPU limit does not hold it back), or by hand:
//   node /opt/arena-portal/captest.js [--streams 20] [--step 2] [--step-sec 40] [--allow-live]
// Needs ffmpeg, the relay on 127.0.0.1:8895 and mediamtx. Reads LINK_KEY, DIRECTORY_URL, MEDIAMTX_API, RELAY_SRT
// from the environment (the portal's /etc/arena-portal/env). Writes status.json and history.json to the output dir.
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
fs.mkdirSync(OUT, { recursive: true })

let stopRequested = false
process.on('SIGTERM', () => { stopRequested = true })
process.on('SIGINT', () => { stopRequested = true })

const writeJson = (file, obj) => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, file) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = new Set()

async function dirGet(p) {
  const r = await fetch(DIRECTORY + p, { headers: { 'X-Arena-Key': KEY }, signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`directory ${r.status}`)
  return r.json()
}

function proc(args, { progress = false } = {}) {
  const p = spawn(FFMPEG, args, { stdio: ['ignore', progress ? 'pipe' : 'ignore', 'ignore'] })
  children.add(p); p.on('close', () => children.delete(p))
  return p
}
const killProc = p => new Promise(res => { if (p.exitCode !== null) return res(); p.once('close', res); p.kill('SIGTERM'); setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } }, 1500) })

function makeReader(kind, ffArgs) {
  const h = { kind, bytes: 0, mediaUs: 0, last: 0, gaps: [] }
  const p = proc(['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...ffArgs, '-c', 'copy', '-f', 'mpegts', os.devNull], { progress: true })
  let buf = ''
  p.stdout.on('data', d => {
    buf += d; const lines = buf.split('\n'); buf = lines.pop()
    for (const l of lines) {
      if (l.startsWith('total_size=')) h.bytes = Number(l.slice(11)) || h.bytes
      else if (l.startsWith('out_time_us=')) h.mediaUs = Number(l.slice(12)) || h.mediaUs
      else if (l.startsWith('progress=')) { const now = Date.now(); if (h.last) h.gaps.push([now, (now - h.last) / 1000]); h.last = now; if (h.gaps.length > 400) h.gaps.splice(0, 100) }
    }
  })
  h.stats = since => ({ bytes: h.bytes, mediaUs: h.mediaUs, maxGapSec: Math.max(0, ...h.gaps.filter(g => !since || g[0] >= since).map(g => g[1]), h.last && Date.now() - h.last > 3000 ? (Date.now() - h.last) / 1000 : 0) })
  h.stop = () => killProc(p)
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

let secret = ''
async function world() {
  if (spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('ffmpeg is not installed')
  secret = (await dirGet('/v1/config')).relaySecret || ''
  const sampleFile = path.join(OUT, 'sample-10m.ts')
  return {
    now: () => Date.now(), sleep, selfPid: process.pid, cores: os.cpus().length,
    stopped: () => stopRequested,
    progress: s => writeJson(path.join(OUT, 'status.json'), s),
    live: async () => { try { return (await dirGet('/v1/encoders')).encoders.map(e => ({ name: e.name, kbps: e.kbps })) } catch { return [] } },
    prepareSample: async () => {
      if (!fs.existsSync(sampleFile) || fs.statSync(sampleFile).size < 5e6) {
        const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30000/1001', '-vf', 'noise=alls=25:allf=t+u,format=yuv420p', '-t', '20',
          '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '10M', '-minrate', '10M', '-maxrate', '10M', '-bufsize', '5M', '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-g', '30', '-bf', '0', '-an', '-f', 'mpegts', sampleFile], { timeout: 180000 })
        if (r.status !== 0 || !fs.existsSync(sampleFile)) throw new Error('could not make the 10 Mbps sample')
      }
      return { mbps: fs.statSync(sampleFile).size * 8 / 20 / 1e6 }
    },
    start: async (kind, i) => {
      if (kind === 'pub') {
        const p = proc(['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', sampleFile, '-c', 'copy', '-f', 'mpegts', `srt://${RELAY}?streamid=publish:CT-${i}:${secret}&mode=caller&latency=150`])
        return { stop: () => killProc(p) }
      }
      if (kind === 'srt') return makeReader('srt', ['-i', `srt://${RELAY}?streamid=read:CT-${i}&mode=caller&latency=150`])
      const name = await ensureMtxPath(i)
      return makeReader('rtsp', ['-rtsp_transport', 'tcp', '-i', `${MTX_RTSP}/${name}`])
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
  h.unshift({ at: status.startedAt || Date.now(), cfg: status.cfg, expectedMbps: status.expectedMbps, steps: status.steps, conclusion: status.conclusion, aborted: status.aborted, estimate: status.estimate })
  writeJson(hist, h.slice(0, 10))
  console.log(status.conclusion)
  process.exit(0)
})()
