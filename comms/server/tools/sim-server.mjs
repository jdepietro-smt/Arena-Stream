// The server half of the capacity simulator (see capacity-sim.mjs). It is the real Comms server with a fake media relay,
// so it does all the real work of who-hears-whom and counts what it asks the relay to forward. Run it only via capacity-sim.
import { createServer, loadConfig } from '../server.js'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const cfg = { ...loadConfig('/nonexistent.json'), dataFile: null, auth: { mode: 'accounts' }, pin: '' }
const tracksBy = new Map()           // peer id -> tracks it has published
const subs = new Map()               // listener id -> set of track sids the server asked the relay to forward to it
const st = { calls: 0, sids: 0 }
const fake = {
  url: 'ws://sim-sfu',
  token: async p => `tok-${p.name}`,
  listTracks: async id => tracksBy.get(id) ?? [],
  updateSubscriptions: async (id, sids, on) => {
    st.calls++; st.sids += sids.length
    const set = subs.get(id) ?? new Set()
    for (const s of sids) on ? set.add(s) : set.delete(s)
    subs.set(id, set)
  },
}
const srv = createServer(cfg, { sfu: fake })
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable()

process.on('message', msg => {
  if (msg.type === 'setup') {
    const d = srv.directory
    for (const c of msg.channels) d.addChannel({ id: c, name: c })
    for (const g of msg.groups) d.addGroup({ name: g.name, grants: g.grants })
    for (const u of msg.users) d.addUser({ username: u.username, password: u.password, groups: u.groups.map(n => d.groups.find(x => x.name === n).id) })
    process.send({ type: 'setup-done' })
  } else if (msg.type === 'tracks') {
    tracksBy.set(msg.id, msg.tracks)
    process.send({ type: 'tracks-ok' })
  } else if (msg.type === 'stats') {
    const cpu = process.cpuUsage()
    const own = new Set()
    for (const [id, ts] of tracksBy) for (const t of ts) own.add(`${id}:${t.sid}`)
    let streams = 0
    for (const [id, set] of subs) for (const sid of set) if (!(tracksBy.get(id) ?? []).some(t => t.sid === sid)) streams++
    process.send({
      type: 'stats', cpuMs: (cpu.user + cpu.system) / 1000, calls: st.calls, sids: st.sids, streams,
      published: [...tracksBy.values()].reduce((n, ts) => n + ts.length, 0),
      lagP99: delay.percentile(99) / 1e6, lagMax: delay.max / 1e6, rssMb: process.memoryUsage().rss / 1048576, peers: srv.peers.size,
    })
    delay.reset()
  }
})
srv.listen(0).then(port => process.send({ type: 'ready', port }))
