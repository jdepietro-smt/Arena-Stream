// Capacity simulator for the Comms server: connects many gateways and crew members to the real server (with a fake media
// relay) and reports how many audio streams the media relay would have to forward, plus what the control side costs.
//
//   node tools/capacity-sim.mjs [--gateways 16] [--tracks 8] [--crew 5] [--channels distinct|shared] [--design current|bridged] [--seconds 30] [--kbps 55]
//   node tools/capacity-sim.mjs --compare            (runs "current" and "bridged" side by side)
//
// current = how gateways behave today: each listens to every channel it may, bridged or not.
// bridged = the proposed change: a gateway listens only to the channels it bridges.
// channels: distinct = every arena has its own channels; shared = every arena uses the same channels.
import { fork } from 'node:child_process'
import { WebSocket } from 'ws'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] ?? true) }
const opt = {
  gateways: Number(arg('gateways', 16)), tracks: Number(arg('tracks', 8)), crew: Number(arg('crew', 5)),
  channels: String(arg('channels', 'distinct')), seconds: Number(arg('seconds', 30)), kbps: Number(arg('kbps', 55)),
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function scenario(design) {
  const child = fork(path.join(here, 'sim-server.mjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const wait = type => new Promise(res => { const h = m => { if (m.type === type) { child.off('message', h); res(m) } }; child.on('message', h) })
  const { port } = await wait('ready')

  // Each gateway bridges `tracks` channels (4 to 12 around the average, like real arenas).
  const perGw = i => Math.max(4, Math.min(12, opt.tracks + ((i * 5) % 9) - 4))
  const SHARED = Array.from({ length: 12 }, (_, k) => `c${k + 1}`)
  const chans = i => opt.channels === 'shared' ? SHARED.slice(0, perGw(i)) : Array.from({ length: perGw(i) }, (_, k) => `a${i}c${k + 1}`)
  const allChannels = opt.channels === 'shared' ? SHARED : [...new Set(Array.from({ length: opt.gateways }, (_, i) => chans(i)).flat())]
  const groups = [{ name: 'crew', grants: Object.fromEntries(allChannels.map(c => [c, { talk: true, listen: true }])) }]
  const users = []
  for (let g = 0; g < opt.gateways; g++) for (let k = 0; k < opt.crew; k++) users.push({ username: `u${g}_${k}`, password: 'simpass123', groups: ['crew'] })
  child.send({ type: 'setup', channels: allChannels, groups, users })
  await wait('setup-done')

  const sockets = []
  const open = () => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); const q = []; ws.on('message', m => q.push(JSON.parse(m.toString()))); ws.on('open', () => res({ ws, q })); ws.on('error', rej) })
  const next = async (c, type) => { for (let i = 0; i < 400; i++) { const j = c.q.findIndex(m => m.type === type || m.type === 'error'); if (j >= 0) return c.q.splice(j, 1)[0]; await sleep(25) } throw new Error('timed out waiting for ' + type) }
  const send = (c, m) => c.ws.send(JSON.stringify(m))

  let sid = 0
  for (let g = 0; g < opt.gateways; g++) {
    const c = await open(); sockets.push(c)
    send(c, { type: 'join', gateway: true, name: `Arena ${g}`, gatewayId: `gw-${String(g).padStart(8, '0')}` })
    const w = await next(c, 'welcome'); if (w.type === 'error') throw new Error(w.message)
    const mine = chans(g)
    child.send({ type: 'tracks', id: w.id, tracks: [{ name: 'direct', sid: `s${++sid}` }, ...mine.map(ch => ({ name: `ch:${ch}`, sid: `s${++sid}` }))] })
    await wait('tracks-ok')
    send(c, { type: 'tracks' })
    if (design === 'bridged') send(c, { type: 'state', talk: [], listen: mine })
    await sleep(15)
  }
  for (let g = 0; g < opt.gateways; g++) for (let k = 0; k < opt.crew; k++) {
    const c = await open(); sockets.push(c)
    send(c, { type: 'join', username: `u${g}_${k}`, password: 'simpass123' })
    const w = await next(c, 'welcome'); if (w.type === 'error') throw new Error(`crew join failed: ${w.message}`)
    send(c, { type: 'state', talk: [], listen: chans(g) })
    await sleep(8)
  }
  await sleep(3000)                                        // let subscriptions settle
  const sample = async () => { child.send({ type: 'stats' }); return wait('stats') }
  const a = await sample(); const t0 = Date.now()
  await sleep(opt.seconds * 1000)
  const b = await sample(); const secs = (Date.now() - t0) / 1000

  for (const c of sockets) c.ws.close()
  child.kill()
  const kb = x => x * opt.kbps / 1000
  return {
    design, peers: b.peers, published: b.published, streams: b.streams, egressMbps: kb(b.streams), ingressMbps: kb(b.published),
    callsPerMin: (b.calls - a.calls) / secs * 60, sidsPerMin: (b.sids - a.sids) / secs * 60,
    cpuPct: (b.cpuMs - a.cpuMs) / (secs * 1000) * 100, lagP99: b.lagP99, lagMax: b.lagMax, rssMb: b.rssMb,
  }
}

const fmt = r => [
  `  connected: ${r.peers}   published tracks: ${r.published}`,
  `  audio streams the media relay must forward: ${r.streams}  (~${r.egressMbps.toFixed(0)} Mbit/s out, ~${r.ingressMbps.toFixed(1)} Mbit/s in at ${opt.kbps} kbit/s each)`,
  `  control side, steady state: ${r.callsPerMin.toFixed(0)} relay calls/min (${r.sidsPerMin.toFixed(0)} subscriptions sent/min), server CPU ${r.cpuPct.toFixed(1)}% of one core, event-loop lag p99 ${r.lagP99.toFixed(1)} ms (max ${r.lagMax.toFixed(0)} ms), ${r.rssMb.toFixed(0)} MB`,
].join('\n')

console.log(`${opt.gateways} gateways x ~${opt.tracks} channels (4 to 12 each), ${opt.crew} crew per gateway, ${opt.channels} channels, ${opt.seconds}s steady-state window`)
const designs = process.argv.includes('--compare') ? ['current', 'bridged'] : [String(arg('design', 'current'))]
for (const d of designs) { console.log(`\n[${d}]`); console.log(fmt(await scenario(d))) }
process.exit(0)
