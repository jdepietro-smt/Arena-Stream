// Arena Comms server.
//
// Audio never passes through this process: it is a signaling + presence +
// routing-state server. Clients exchange WebRTC offers/answers through it and
// each client gates its own outgoing audio per peer from the shared
// talk/listen state kept here.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { createLiveKit } from './sfu.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_CONFIG = JSON.parse(
  fs.readFileSync(path.join(here, 'comms.config.example.json'), 'utf8'),
)

export function loadConfig(file = process.env.COMMS_CONFIG || path.join(here, 'comms.config.json')) {
  let cfg = { ...DEFAULT_CONFIG }
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`bad config ${file}: ${e.message}`)
  }
  if (process.env.COMMS_PORT) cfg.port = Number(process.env.COMMS_PORT)
  if (process.env.COMMS_PIN !== undefined) cfg.pin = process.env.COMMS_PIN
  if (process.env.COMMS_ICE) cfg.iceServers = JSON.parse(process.env.COMMS_ICE)
  return cfg
}

const MAX_NAME = 32
const MAX_PEERS = 64

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function createServer(cfg = loadConfig(), { sfu = cfg.media?.mode === 'sfu' ? createLiveKit(cfg.media.livekit) : null } = {}) {
  const channels = cfg.channels
  const channelIds = new Set(channels.map(c => c.id))
  /** @type {Map<string, {id:string, ws:any, name:string, role:string, talk:string[], listen:string[], alive:boolean}>} */
  const peers = new Map()

  const canAccess = (role, ch) => !ch.roles || ch.roles.includes(role)
  const allowedIds = role => new Set(channels.filter(c => canAccess(role, c)).map(c => c.id))

  const publicInfo = p => ({ id: p.id, name: p.name, role: p.role, talk: p.talk, listen: p.listen })
  const send = (p, msg) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)) }
  const broadcast = (msg, exceptId) => {
    for (const p of peers.values()) if (p.id !== exceptId) send(p, msg)
  }

  // ── SFU subscription routing ───────────────────────────────────────────────
  // A listener may receive a publisher's `ch:<id>` track iff both roles may
  // access the channel and the listener has it in its listen set, and the
  // publisher's `direct` track only while it is talking directly to that listener.
  const wantedSids = L => {
    const want = new Set()
    for (const P of peers.values()) {
      if (P === L) continue
      for (const [name, sid] of P.tracks) {
        if (name === 'direct') {
          if (P.talk.includes(`u:${L.id}`)) want.add(sid)
        } else if (name.startsWith('ch:')) {
          const ch = channels.find(c => c.id === name.slice(3))
          if (ch && canAccess(P.role, ch) && canAccess(L.role, ch) && L.listen.includes(ch.id)) want.add(sid)
        }
      }
    }
    return want
  }

  const reconcile = L => {
    if (!sfu) return Promise.resolve()
    L.recon = (L.recon ?? Promise.resolve()).then(async () => {
      if (peers.get(L.id) !== L) return
      const want = wantedSids(L)
      const live = new Set([...peers.values()].flatMap(p => [...p.tracks.values()]))
      const add = [...want].filter(x => !L.subs.has(x))
      // Tracks of departed peers are already gone from LiveKit; don't try to unsubscribe them.
      const drop = [...L.subs].filter(x => !want.has(x) && live.has(x))
      try {
        if (add.length) await sfu.updateSubscriptions(L.id, add, true)
        if (drop.length) await sfu.updateSubscriptions(L.id, drop, false)
        L.subs = want
      } catch (e) {
        console.warn(`[arena-comms] subscription update for ${L.name} failed: ${e.message}`)
      }
    })
    return L.recon
  }
  const reconcileAll = () => Promise.all([...peers.values()].map(reconcile))

  const refreshTracks = async P => {
    try {
      P.tracks = new Map((await sfu.listTracks(P.id)).map(t => [t.name, t.sid]))
      await reconcileAll()
    } catch (e) {
      console.warn(`[arena-comms] track refresh for ${P.name} failed: ${e.message}`)
    }
  }

  // Self-heal: retry anything a transient LiveKit error left unsynced.
  const healTimer = sfu ? setInterval(reconcileAll, 5_000) : null

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, peers: peers.size }))
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 })

  // Heartbeat: drop peers whose TCP connection died without a close frame.
  const heartbeat = setInterval(() => {
    for (const p of peers.values()) {
      if (!p.alive) { p.ws.terminate(); continue }
      p.alive = false
      p.ws.ping()
    }
  }, 10_000)
  wss.on('close', () => { clearInterval(heartbeat); if (healTimer) clearInterval(healTimer) })

  wss.on('connection', ws => {
    let me = null
    const joinTimer = setTimeout(() => { if (!me) ws.close(4001, 'join timeout') }, 10_000)

    const fail = (code, message) => {
      ws.send(JSON.stringify({ type: 'error', code, message }))
      ws.close(4000, code)
    }

    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!msg || typeof msg.type !== 'string') return

      if (!me) {
        if (msg.type !== 'join') return
        if (cfg.pin && !safeEqual(msg.pin ?? '', cfg.pin)) return fail('bad-pin', 'Incorrect PIN')
        if (peers.size >= MAX_PEERS) return fail('full', 'Server is full')
        const name = String(msg.name ?? '').trim().slice(0, MAX_NAME)
        if (!name) return fail('bad-name', 'A name is required')
        const role = cfg.roles.includes(msg.role) ? msg.role : 'Guest'
        me = { id: randomUUID(), ws, name, role, talk: [], listen: [], alive: true, tracks: new Map(), subs: new Set() }
        // Default: listening to everything the role may access.
        me.listen = [...allowedIds(role)]
        clearTimeout(joinTimer)
        const others = [...peers.values()].map(publicInfo)
        peers.set(me.id, me)
        const joined = me
        Promise.resolve(sfu ? sfu.token(joined) : null).then(token => send(joined, {
          type: 'welcome',
          media: sfu ? 'sfu' : 'mesh',
          livekit: sfu ? { url: sfu.url, token } : null,
          id: me.id,
          roles: cfg.roles,
          iceServers: cfg.iceServers,
          channels: channels.filter(c => canAccess(role, c)),
          // Program feed (WHEP URL) is offered only when configured and allowed for the role.
          program: cfg.program?.whepUrl && (!cfg.program.roles?.length || cfg.program.roles.includes(role))
            ? { name: cfg.program.name || 'PGM', whepUrl: cfg.program.whepUrl }
            : null,
          listen: me.listen,
          peers: others,
        }), e => fail('sfu', `Media server unavailable: ${e.message}`))
        broadcast({ type: 'peer-join', peer: publicInfo(me) }, me.id)
        return
      }

      switch (msg.type) {
        case 'state': {
          const ok = allowedIds(me.role)
          const asList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
          const prevDirect = me.talk.filter(t => t.startsWith('u:')).join()
          me.listen = [...new Set(asList(msg.listen).filter(id => ok.has(id)))]
          me.talk = [...new Set(asList(msg.talk).filter(id =>
            ok.has(id) || (id.startsWith('u:') && peers.has(id.slice(2)))))]
          broadcast({ type: 'peer-state', id: me.id, talk: me.talk, listen: me.listen })
          // Listen changes affect me; a changed direct target affects that listener.
          void reconcile(me)
          if (me.talk.filter(t => t.startsWith('u:')).join() !== prevDirect) void reconcileAll()
          break
        }
        case 'signal': {
          const to = peers.get(msg.to)
          if (to && to !== me) send(to, { type: 'signal', from: me.id, data: msg.data })
          break
        }
        case 'tracks':
          // Only a trigger: the real track list is read back from LiveKit.
          if (sfu) void refreshTracks(me)
          break
        case 'call': {
          if (!channelIds.has(msg.channel) || !allowedIds(me.role).has(msg.channel)) break
          for (const p of peers.values()) {
            if (p !== me && p.listen.includes(msg.channel)) {
              send(p, { type: 'call', from: me.id, channel: msg.channel })
            }
          }
          break
        }
        case 'ping':
          send(me, { type: 'pong', t: msg.t })
          break
      }
    })

    ws.on('pong', () => { if (me) me.alive = true })
    ws.on('close', () => {
      clearTimeout(joinTimer)
      if (me && peers.get(me.id) === me) {
        peers.delete(me.id)
        broadcast({ type: 'peer-leave', id: me.id })
      }
    })
    ws.on('error', () => {})
  })

  return {
    httpServer,
    peers,
    listen: (port = cfg.port) =>
      new Promise(resolve => httpServer.listen(port, () => resolve(httpServer.address().port))),
    close: () => new Promise(resolve => {
      for (const c of wss.clients) c.terminate()
      wss.close(() => httpServer.close(() => resolve()))
    }),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig()
  const srv = createServer(cfg)
  srv.listen().then(port => {
    console.log(`[arena-comms] listening on :${port} (${cfg.channels.length} channels, pin ${cfg.pin ? 'on' : 'off'})`)
  })
}
