// Arena Comms server.
//
// Audio never passes through this process: it is a signaling + presence +
// routing-state server. Who may talk/listen where comes from the directory
// (users -> groups -> per-channel grants, see directory.js), is enforced here
// on every state change, and is re-applied live when an admin edits it.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { createLiveKit } from './sfu.js'
import { Directory, seedFromConfig } from './directory.js'
import { AuthError, createAuth } from './auth.js'
import { createAdmin } from './admin.js'
import { createArenaWatcher } from './arena.js'

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
  if (process.env.COMMS_AUTH) cfg.auth = { mode: process.env.COMMS_AUTH }
  // The directory file holds users/groups/channels once created; config channels/roles only seed it.
  cfg.dataFile = process.env.COMMS_DATA ?? cfg.dataFile ?? path.join(here, 'data', 'directory.json')
  return cfg
}

const MAX_NAME = 32
const MAX_PEERS = 64

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function createServer(
  cfg = loadConfig(),
  { sfu = cfg.media?.mode === 'sfu' ? createLiveKit(cfg.media.livekit) : null, arenaFetch } = {},
) {
  const authMode = cfg.auth?.mode === 'open' ? 'open' : 'accounts'
  const dir = Directory.load(cfg.dataFile ?? null, () => seedFromConfig(cfg))
  const bootstrap = dir.ensureAdmin(process.env.COMMS_ADMIN_PASSWORD)
  // Session tokens are signed with a secret kept next to the directory so they survive restarts.
  const sessionSecret = (() => {
    const file = cfg.dataFile ? path.join(path.dirname(cfg.dataFile), 'session.key') : null
    try { if (file && fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url') } catch { /* make a new one */ }
    const secret = randomBytes(32)
    try {
      if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, secret.toString('base64url'), { mode: 0o600 }) }
    } catch { /* sessions then last until the next restart */ }
    return secret
  })()
  const auth = createAuth(dir, { secret: sessionSecret })

  /** @type {Map<string, any>} connected peers by connection id */
  const peers = new Map()

  // Music channels are separate SFU tracks, so the mesh cannot carry them: hide them there.
  const visibleChannels = perms => dir.channels
    .filter(c => perms[c.id] && (sfu || !c.music))
    .map(c => ({ ...c, canTalk: perms[c.id].talk, canListen: perms[c.id].listen }))
  const publicInfo = p => ({ id: p.id, name: p.user.name, role: p.title, talk: p.talk, listen: p.listen })
  const titleOf = u => u.title || dir.group(u.groups?.[0])?.name || ''
  const send = (p, msg) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)) }
  const broadcast = (msg, exceptId) => {
    for (const p of peers.values()) if (p.id !== exceptId) send(p, msg)
  }
  const kick = (id, code = 'kicked', message = 'You were removed by an administrator') => {
    const p = peers.get(id)
    if (!p) return false
    send(p, { type: 'error', code, message })
    p.ws.close(4000, code)
    return true
  }

  // ── Arena stream awareness ─────────────────────────────────────────────────
  // Feed health from the stream server, announced on the channel each stream belongs to.
  const arena = cfg.arena?.apiUrl && cfg.arena.streams?.length
    ? createArenaWatcher({
        apiUrl: cfg.arena.apiUrl, streams: cfg.arena.streams, pollMs: cfg.arena.pollMs, confirmPolls: cfg.arena.confirmPolls,
        stallPolls: cfg.arena.stallPolls, fetchImpl: arenaFetch ?? fetch,
        onChange: (streams, events) => {
          broadcast({ type: 'streams', streams })
          for (const ev of events) {
            const level = ev.kind === 'restored' || ev.kind === 'monitor-online' ? 'ok' : 'warn'
            for (const p of peers.values()) {
              if (ev.channel && !(p.perms[ev.channel]?.listen && p.listen.includes(ev.channel))) continue
              send(p, { type: 'alert', level, kind: ev.kind, stream: ev.stream ?? null, channel: ev.channel, text: ev.text })
            }
          }
        },
      })
    : null

  // ── Music feed ─────────────────────────────────────────────────────────────
  // A music channel is a channel an operator (usually the A1) plays stereo music into, as its own track named
  // `music:<channel>`. Group grants decide who may send (talk) and who may hear (listen); listeners only ever
  // receive it while a permitted sender has it switched on. SFU only: the mesh has no separate per-purpose tracks.
  const isMusic = id => !!sfu && !!dir.channel(id)?.music
  /** Who is sending music on the channels this peer may hear. */
  const musicSendersFor = L => [...peers.values()].flatMap(p =>
    [...p.musicOn].filter(ch => L.perms[ch]?.listen).map(ch => ({ channel: ch, id: p.id, name: p.user.name })))
  const announceMusic = (P, channel, on) => {
    for (const L of peers.values()) if (L.perms[channel]?.listen) send(L, { type: 'music', channel, id: P.id, name: P.user.name, on })
  }

  // ── SFU subscription routing ───────────────────────────────────────────────
  // A listener may receive a publisher's `ch:<id>` track iff the publisher may
  // talk there, the listener may listen there and has it switched on, and the
  // publisher's `direct` track only while a direct call targets that listener.
  const wantedSids = L => {
    const want = new Set()
    for (const P of peers.values()) {
      if (P === L) continue
      for (const [name, sid] of P.tracks) {
        if (name === 'direct') {
          if (P.talk.includes(`u:${L.id}`)) want.add(sid)
        } else if (name.startsWith('music:')) {
          const ch = name.slice(6)
          if (P.musicOn.has(ch) && P.perms[ch]?.talk && L.perms[ch]?.listen && L.listen.includes(ch)) want.add(sid)
        } else if (name.startsWith('ch:')) {
          const ch = name.slice(3)
          if (P.perms[ch]?.talk && L.perms[ch]?.listen && L.listen.includes(ch)) want.add(sid)
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
        console.warn(`[arena-comms] subscription update for ${L.user.name} failed: ${e.message}`)
      }
    })
    return L.recon
  }
  const reconcileAll = () => Promise.all([...peers.values()].map(reconcile))

  const refreshTracks = async P => {
    try {
      P.tracks = new Map((await sfu.listTracks(P.id)).map(t => [t.name, t.sid]))
      // P announces its tracks only once it is connected to the SFU. Whatever was subscribed for it before that
      // point never took effect (it was not in the room yet), so forget it and subscribe from scratch.
      P.subs = new Set()
      await reconcileAll()
    } catch (e) {
      console.warn(`[arena-comms] track refresh for ${P.user.name} failed: ${e.message}`)
    }
  }

  // Self-heal: retry anything a transient LiveKit error left unsynced.
  const healTimer = sfu ? setInterval(reconcileAll, 5_000) : null

  // ── live directory changes ─────────────────────────────────────────────────
  // After any admin edit: drop disabled/removed users, and push each affected
  // client its new channel list; clamp talk/listen to what is still allowed.
  function refreshAll() {
    for (const p of [...peers.values()]) {
      const user = p.user.ephemeral ? p.user : dir.user(p.user.id)
      const gone = !user || user.disabled || (user.ephemeral && !user.groups.every(g => dir.group(g)))
      if (gone) { kick(p.id, 'account-disabled', 'Your account was disabled or removed'); continue }
      const prevIds = new Set(Object.keys(p.perms))
      const nameChanged = user.name !== p.user.name || titleOf(user) !== p.title
      p.user = user
      p.title = titleOf(user)
      p.perms = dir.effective(user)
      const chans = visibleChannels(p.perms)
      const json = JSON.stringify(chans)
      if (json !== p.chansJson) {
        p.chansJson = json
        // Newly visible, listenable channels start switched on, like at join.
        const added = chans.filter(c => !prevIds.has(c.id) && c.canListen).map(c => c.id)
        p.listen = [...new Set([...p.listen, ...added])].filter(id => p.perms[id]?.listen)
        p.talk = p.talk.filter(t => (t.startsWith('u:') ? peers.has(t.slice(2)) : p.perms[t]?.talk))
        // Lost the right to send on a music channel (or it stopped being one): switch it off for everyone.
        for (const ch of [...p.musicOn]) {
          if (!isMusic(ch) || !p.perms[ch]?.talk) { p.musicOn.delete(ch); announceMusic(p, ch, false) }
        }
        send(p, { type: 'directory', channels: chans, listen: p.listen, musicSenders: musicSendersFor(p) })
        broadcast({ type: 'peer-state', id: p.id, talk: p.talk, listen: p.listen }, p.id)
      }
      if (nameChanged) broadcast({ type: 'peer-update', id: p.id, name: user.name, role: p.title })
    }
    void reconcileAll()
  }
  dir.onChange(refreshAll)

  const admin = createAdmin({
    dir, auth, kick,
    online: () => [...peers.values()].map(p => ({
      id: p.id, userId: p.user.ephemeral ? null : p.user.id, name: p.user.name, title: p.title, ephemeral: !!p.user.ephemeral,
    })),
  })

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, peers: peers.size }))
      return
    }
    if (url.pathname === '/info') {
      // Lets the client adapt its login form before connecting.
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify({
        auth: authMode,
        pin: authMode === 'open' && !!cfg.pin,
        groups: authMode === 'open' ? dir.groups.filter(g => g.selfJoin).map(g => ({ id: g.id, name: g.name })) : [],
      }))
      return
    }
    admin(req, res, url).then(handled => { if (!handled) res.writeHead(404).end() }, () => res.writeHead(500).end())
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

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress
    let me = null
    let joining = false
    const joinTimer = setTimeout(() => { if (!me) ws.close(4001, 'join timeout') }, 10_000)

    const fail = (code, message) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', code, message }))
      ws.close(4000, code)
    }

    async function join(msg) {
      let user
      if (authMode === 'accounts' && msg.token) {
        user = auth.userForSession(msg.token)
        if (!user) return fail('bad-token', 'Your session expired. Sign in again.')
      } else if (authMode === 'accounts') {
        try {
          user = await auth.authenticate(msg.username, msg.password, `${ip}:${String(msg.username).toLowerCase()}`)
        } catch (e) {
          if (e instanceof AuthError) return fail(e.code, e.message)
          throw e
        }
      } else {
        if (cfg.pin && !safeEqual(msg.pin ?? '', cfg.pin)) return fail('bad-pin', 'Incorrect PIN')
        const name = String(msg.name ?? '').trim().slice(0, MAX_NAME)
        if (!name) return fail('bad-name', 'A name is required')
        const sel = msg.group ?? msg.role
        const group = dir.groups.find(g => g.selfJoin && (g.id === sel || g.name === sel))
        if (!group) return fail('bad-group', 'Pick a valid role')
        user = { id: `guest:${randomUUID()}`, ephemeral: true, name, title: '', groups: [group.id], overrides: {} }
      }
      if (peers.size >= MAX_PEERS) return fail('full', 'Server is full')
      if (!user.ephemeral) {
        for (const p of peers.values()) if (p.user.id === user.id) kick(p.id, 'signed-in-elsewhere', 'Signed in on another device')
      }

      const perms = dir.effective(user)
      const chans = visibleChannels(perms)
      me = {
        id: randomUUID(), ws, user, title: titleOf(user), perms, talk: [], alive: true,
        listen: chans.filter(c => c.canListen).map(c => c.id),
        tracks: new Map(), subs: new Set(), chansJson: JSON.stringify(chans),
        musicOn: new Set(),
      }
      clearTimeout(joinTimer)
      const others = [...peers.values()].map(publicInfo)
      peers.set(me.id, me)
      const joined = me
      const groupNames = user.groups.map(g => dir.group(g)?.name?.toLowerCase())
      const prog = cfg.program
      const progOk = prog?.whepUrl && (!prog.roles?.length || prog.roles.some(r => groupNames.includes(String(r).toLowerCase())))
      Promise.resolve(sfu ? sfu.token({ id: joined.id, name: user.name }) : null).then(token => send(joined, {
        type: 'welcome',
        media: sfu ? 'sfu' : 'mesh',
        livekit: sfu ? { url: sfu.url, token } : null,
        id: joined.id,
        me: { name: user.name, title: joined.title, admin: !!user.admin },
        session: authMode === 'accounts' && !user.ephemeral ? auth.issueSession(user) : null,
        iceServers: cfg.iceServers,
        channels: chans,
        program: progOk ? { name: prog.name || 'PGM', whepUrl: prog.whepUrl } : null,
        musicSenders: musicSendersFor(joined),
        listen: joined.listen,
        streams: arena ? arena.snapshot() : [],
        peers: others,
      }), e => fail('sfu', `Media server unavailable: ${e.message}`))
      broadcast({ type: 'peer-join', peer: publicInfo(me) }, me.id)
    }

    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!msg || typeof msg.type !== 'string') return

      if (!me) {
        if (msg.type !== 'join' || joining) return
        joining = true
        join(msg).catch(e => { console.error('[arena-comms] join error', e); fail('server', 'Join failed') })
        return
      }

      switch (msg.type) {
        case 'state': {
          const asList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
          const prevDirect = me.talk.filter(t => t.startsWith('u:')).join()
          me.listen = [...new Set(asList(msg.listen).filter(id => me.perms[id]?.listen))]
          me.talk = [...new Set(asList(msg.talk).filter(id =>
            (me.perms[id]?.talk && !isMusic(id)) || (id.startsWith('u:') && peers.has(id.slice(2)))))]
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
        case 'music': {
          const ch = String(msg.channel ?? '')
          if (!isMusic(ch) || !me.perms[ch]?.talk) break
          const on = !!msg.on
          if (on === me.musicOn.has(ch)) break
          if (on) me.musicOn.add(ch); else me.musicOn.delete(ch)
          announceMusic(me, ch, on)
          void reconcileAll()
          break
        }
        case 'tracks':
          // Only a trigger: the real track list is read back from LiveKit.
          if (sfu) void refreshTracks(me)
          break
        case 'call': {
          if (!me.perms[msg.channel]?.talk) break
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
        for (const ch of me.musicOn) announceMusic(me, ch, false)
        broadcast({ type: 'peer-leave', id: me.id })
      }
    })
    ws.on('error', () => {})
  })

  return {
    httpServer,
    peers,
    directory: dir,
    bootstrap,
    listen: (port = cfg.port) =>
      new Promise(resolve => httpServer.listen(port, process.env.COMMS_HOST || undefined, () => { arena?.start(); resolve(httpServer.address().port) })),
    close: () => new Promise(resolve => {
      arena?.stop()
      for (const c of wss.clients) c.terminate()
      wss.close(() => httpServer.close(() => resolve()))
    }),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig()
  const srv = createServer(cfg)
  srv.listen().then(port => {
    console.log(`[arena-comms] listening on :${port} — auth ${cfg.auth?.mode === 'open' ? 'open' : 'accounts'}, admin UI at /admin`)
    if (srv.bootstrap) {
      const b = srv.bootstrap
      console.log(`[arena-comms] created administrator "${b.username}" ${b.generated ? `with password: ${b.password}  (shown once — change it in the admin UI)` : 'from COMMS_ADMIN_PASSWORD'}`)
    }
  })
}
