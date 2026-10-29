// Admin REST API (/admin/api/*) and the static admin page (/admin).
// Everything except login requires a Bearer token belonging to an admin user.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DirectoryError } from './directory.js'
import { AuthError } from './auth.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MAX_BODY = 64 * 1024

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(new DirectoryError('Request too large', 413)); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch { reject(new DirectoryError('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

export function createAdmin({ dir, auth, online, kick }) {
  const page = () => fs.readFileSync(path.join(here, 'admin', 'index.html'))

  return async function handle(req, res, url) {
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page())
      return true
    }
    if (!url.pathname.startsWith('/admin/api/')) return false
    const route = url.pathname.slice('/admin/api/'.length).split('/').filter(Boolean)
    const method = req.method

    try {
      if (route[0] === 'login' && method === 'POST') {
        const { username, password } = await readJson(req)
        const user = await auth.authenticate(username, password, `${req.socket.remoteAddress}:${String(username).toLowerCase()}`)
        if (!user.admin) throw new AuthError('forbidden', 'This account is not an administrator', 403)
        return send(res, 200, { token: auth.issueToken(user), name: user.name }), true
      }

      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      if (!token || !auth.adminForToken(token)) throw new AuthError('unauthorized', 'Sign in again', 401)

      const [kind, id, sub] = route
      const body = ['POST', 'PUT'].includes(method) ? await readJson(req) : {}

      if (kind === 'state' && method === 'GET') {
        return send(res, 200, {
          channels: dir.channels, groups: dir.groups,
          users: dir.users.map(u => dir.publicUser(u)), online: online(),
        }), true
      }
      if (kind === 'logout' && method === 'POST') { auth.revoke(token); return send(res, 200, { ok: true }), true }

      if (kind === 'channels') {
        if (method === 'POST' && id === 'reorder') { dir.reorderChannels(body.ids); return send(res, 200, { ok: true }), true }
        if (method === 'POST' && !id) return send(res, 201, dir.addChannel(body)), true
        if (method === 'PUT' && id) return send(res, 200, dir.updateChannel(id, body)), true
        if (method === 'DELETE' && id) { dir.deleteChannel(id); return send(res, 200, { ok: true }), true }
      }
      if (kind === 'groups') {
        if (method === 'POST' && !id) return send(res, 201, dir.addGroup(body)), true
        if (method === 'PUT' && id) return send(res, 200, dir.updateGroup(id, body)), true
        if (method === 'DELETE' && id) { dir.deleteGroup(id); return send(res, 200, { ok: true }), true }
      }
      if (kind === 'users') {
        if (method === 'POST' && !id) return send(res, 201, dir.publicUser(dir.addUser(body))), true
        if (method === 'PUT' && id) return send(res, 200, dir.publicUser(dir.updateUser(id, body))), true
        if (method === 'DELETE' && id) { dir.deleteUser(id); return send(res, 200, { ok: true }), true }
      }
      if (kind === 'kick' && method === 'POST' && id) {
        return send(res, kick(id) ? 200 : 404, { ok: true }), true
      }
      void sub
      throw new DirectoryError('Not found', 404)
    } catch (e) {
      if (e instanceof DirectoryError || e instanceof AuthError) return send(res, e.status, { error: e.message, code: e.code }), true
      console.error('[arena-comms] admin error', e)
      return send(res, 500, { error: 'Internal error' }), true
    }
  }
}
