// Builds comms/server/comms.config.json for the cloud box from the example config.
// Usage: node make-config.mjs <out.json> <public-ip> <livekit-key> <livekit-secret> [mediamtx-api-url]
// Existing configs are never overwritten by install.sh; this only runs on first install.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [out, ip, key, secret, arenaApi] = process.argv.slice(2)
const here = path.dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(fs.readFileSync(path.join(here, '../server/comms.config.example.json'), 'utf8'))

cfg.port = 8900
cfg.pin = ''
cfg.auth = { mode: 'accounts' }
cfg.media = {
  mode: 'sfu',
  livekit: { url: `wss://${ip}/livekit`, apiUrl: 'http://127.0.0.1:7880', apiKey: key, apiSecret: secret, room: 'arena' },
}

// Stream alerts: the stream server's mediamtx API is on this same machine.
cfg.arena = { apiUrl: arenaApi || '', pollMs: 1000, streams: [] }
if (arenaApi) {
  try {
    const r = await fetch(`${arenaApi.replace(/\/$/, '')}/v3/paths/list?itemsPerPage=1000`, { signal: AbortSignal.timeout(3000) })
    const list = (await r.json()).items ?? []
    cfg.arena.streams = list.map(p => ({ path: p.name, name: p.name.replace(/[_-]+/g, ' '), channel: null }))
  } catch { /* monitor still starts; streams can be added to the config later */ }
}

fs.writeFileSync(out, JSON.stringify(cfg, null, 2))
console.log(`wrote ${out} (${cfg.arena.streams.length} stream(s) to monitor)`)
