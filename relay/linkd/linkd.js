'use strict'
// mediamtx external-auth hook: decides who may read a stream.
//
//   publish       always allowed here (the SRT publish passphrase protects it)
//   read/playback localhost always allowed; everyone else needs a valid,
//                 unexpired share-link token for that stream
//   api/metrics   localhost only
//
// A token arrives as the password of the SRT streamid:
//   srt://host:8890?streamid=read:<stream>:link:<token>
// LINKD_ENFORCE=0 (default) logs what would be refused but lets it through, so the
// hook can be switched on before any links exist.  Set LINKD_ENFORCE=1 to enforce.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { verify } = require('./token')

const PORT = parseInt(process.env.LINKD_PORT || '9100', 10)
const ENFORCE = process.env.LINKD_ENFORCE === '1'
const PUBKEY = fs.readFileSync(process.env.LINKD_PUBKEY || path.join(__dirname, 'public-key.pem'), 'utf8')
const LOCAL_BYPASS = process.env.LINKD_LOCAL_BYPASS !== '0'   // 0 only for testing from the same box
const isLocal = ip => LOCAL_BYPASS && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')

function decide(req, now = Math.floor(Date.now() / 1000), pubkey = PUBKEY, enforce = ENFORCE) {
  const { action, ip, path: stream = '', user, password, query } = req
  if (action === 'publish') return { allow: true, why: 'publish' }
  if (isLocal(ip)) return { allow: true, why: 'local' }
  if (action === 'read' || action === 'playback') {
    const fromQuery = typeof query === 'string' ? new URLSearchParams(query).get('token') : null
    const v = verify(pubkey, password || fromQuery || '', stream, now)
    if (v.ok) return { allow: true, why: 'token' }
    return enforce ? { allow: false, why: v.reason } : { allow: true, why: 'unenforced:' + v.reason }
  }
  return { allow: false, why: 'action:' + action }
}

function serve() {
  http.createServer((rq, rs) => {
    if (rq.method !== 'POST' || rq.url !== '/auth') { rs.writeHead(404); return rs.end() }
    let body = ''
    rq.on('data', c => { body += c; if (body.length > 65536) rq.destroy() })
    rq.on('end', () => {
      let r = {}
      try { r = JSON.parse(body) } catch { /* treated as empty */ }
      const d = decide(r)
      console.log(`${d.allow ? 'ALLOW' : 'DENY '} ${r.action} ${r.path} from ${r.ip} (${d.why})`)
      rs.writeHead(d.allow ? 200 : 401); rs.end()
    })
  }).listen(PORT, '127.0.0.1', () => console.log(`linkd on 127.0.0.1:${PORT} enforce=${ENFORCE}`))
}

module.exports = { decide }
if (require.main === module) serve()
