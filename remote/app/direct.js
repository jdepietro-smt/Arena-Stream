// Serverless mode: the host app listens for viewers itself. No accounts, no matchmaking server.
//
// Security: the host shows a one-time-per-run access code. It is never sent. The host proves it knows the code (and binds
// its identity key to it) and the viewer proves it too, using HMACs over a fresh nonce, so a machine in the middle can neither
// learn the code nor pose as the host. The code is rate limited, and the host person still approves every connection.
// Wire messages are JSON over WebSocket; after pairing they match what the account server relays.

const crypto = require('node:crypto')
const os = require('node:os')
const { WebSocketServer } = require('ws')

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
const MAX_FAILS = 5
const LOCK_MS = 60_000

const newCode = () => Array.from(crypto.randomBytes(10), b => ALPHABET[b % 32]).join('')
const formatCode = c => `${c.slice(0, 5)}-${c.slice(5)}`
const normalizeCode = c => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const proof = (code, who, nonce, pubKey) => crypto.createHmac('sha256', normalizeCode(code)).update(`${who}|${nonce}|${pubKey}`).digest('base64')
const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y) }

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
}

/**
 * @param {{ pubKey: string, name: string, onMessage: (m: object) => void, port?: number, code?: string }} o
 * `onMessage` receives {t:'request'|'signal'|'ended'} for the host UI. Returns { code, port, addresses, send, stop }.
 */
function startDirect({ pubKey, name, onMessage, port = 8951, code = newCode() }) {
  const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 })
  let fails = 0, lockedUntil = 0
  let active = null // { id, ws, requested }

  const endActive = reason => {
    if (!active) return
    const a = active
    active = null
    try { a.ws.send(JSON.stringify({ t: 'ended', sessionId: a.id, reason })) } catch {}
    a.ws.close()
    onMessage({ t: 'ended', sessionId: a.id, reason })
  }

  wss.on('connection', (ws, req) => {
    const nonce = crypto.randomBytes(24).toString('base64url')
    const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?'
    let paired = false, me = null
    const timer = setTimeout(() => ws.close(), 15_000)
    ws.send(JSON.stringify({ t: 'challenge', nonce, pubKey, name }))

    ws.on('message', raw => {
      let m
      try { m = JSON.parse(raw) } catch { return ws.close() }

      if (!paired) {
        if (m.t !== 'join') return ws.close()
        if (Date.now() < lockedUntil) { ws.send(JSON.stringify({ t: 'error', error: 'locked' })); return ws.close() }
        if (active) { ws.send(JSON.stringify({ t: 'error', error: 'busy' })); return ws.close() }
        if (typeof m.proof !== 'string' || !safeEqual(m.proof, proof(code, 'viewer', nonce, pubKey))) {
          if (++fails >= MAX_FAILS) { fails = 0; lockedUntil = Date.now() + LOCK_MS }
          ws.send(JSON.stringify({ t: 'error', error: 'code' }))
          return ws.close()
        }
        fails = 0; paired = true; clearTimeout(timer)
        me = { id: crypto.randomBytes(12).toString('base64url'), ws, requested: false }
        active = me
        // Hand the viewer proof that this host knows the code, bound to the key it will later sign with.
        return ws.send(JSON.stringify({ t: 'joined', sessionId: me.id, proof: proof(code, 'host', nonce, pubKey) }))
      }

      if (active !== me) return
      if (m.t === 'go' && !me.requested) { me.requested = true; return onMessage({ t: 'request', sessionId: me.id, user: `Direct viewer ${ip}` }) }
      if (!me.requested) return
      if (m.t === 'signal') {
        if (JSON.stringify(m.data ?? '').length > 32_000) return
        return onMessage({ t: 'signal', sessionId: me.id, data: m.data })
      }
      if (m.t === 'end') endActive('closed')
    })
    ws.on('close', () => { clearTimeout(timer); if (active === me && me) { active = null; onMessage({ t: 'ended', sessionId: me.id, reason: 'peer-left' }) } })
  })

  return {
    code: formatCode(code),
    port,
    addresses: lanAddresses(),
    ready: new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej) }),
    /** Host UI -> viewer (signal answers/candidates, or end). */
    send(m) {
      if (!active || m.sessionId !== active.id) return
      if (m.t === 'end') return endActive('closed')
      if (m.t === 'signal') active.ws.send(JSON.stringify({ t: 'signal', sessionId: active.id, data: m.data }))
    },
    stop() { endActive('stopped'); for (const c of wss.clients) c.terminate(); wss.close() },
  }
}

module.exports = { startDirect, proof, normalizeCode }
