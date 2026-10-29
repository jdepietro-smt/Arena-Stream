// Directory: channels, groups and users, plus who may talk/listen where.
//
// Permissions are per channel and split into `talk` and `listen`. A user's
// effective permission is the union of the grants of every group they belong
// to, then per-user overrides (explicit allow or deny) are applied on top.
// Persisted as one JSON file (atomic write); pass `null` for in-memory use.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

export class DirectoryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

const CHANNEL_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/
const COLOR = /^#[0-9a-f]{6}$/i
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)

export function hashPasswordSync(pw) {
  const salt = randomBytes(16)
  return `s1$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`
}

export async function verifyPassword(pw, stored) {
  const [v, salt, hash] = String(stored ?? '').split('$')
  if (v !== 's1' || !salt || !hash) return false
  const calc = await scrypt(String(pw), Buffer.from(salt, 'hex'), 32)
  const want = Buffer.from(hash, 'hex')
  return calc.length === want.length && timingSafeEqual(calc, want)
}

export function seedFromConfig(cfg) {
  const channels = cfg.channels.map(c => ({
    id: c.id, name: c.name, color: c.color ?? '#6366f1',
    ...(c.music ? { music: true } : {}), ...(c.music && c.source ? { source: c.source } : {}),
    ...(c.ifb && !c.music ? { ifb: true } : {}), ...(c.duck != null ? { duck: c.duck } : {}),
  }))
  // One self-join group per configured role, granted the channels that role could use before.
  const groups = cfg.roles.map(role => ({
    id: slug(role), name: role, selfJoin: true,
    grants: Object.fromEntries(
      cfg.channels.filter(c => !c.roles || c.roles.includes(role)).map(c => [c.id, { talk: true, listen: true }]),
    ),
  }))
  return { channels, groups, users: [] }
}

export class Directory {
  constructor(file, data) {
    this.file = file
    this.data = data
    this.listeners = new Set()
  }

  static load(file, seed) {
    if (file && fs.existsSync(file)) return new Directory(file, JSON.parse(fs.readFileSync(file, 'utf8')))
    const d = new Directory(file, seed())
    d.save()
    return d
  }

  save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  onChange(fn) { this.listeners.add(fn) }
  #changed() { this.save(); for (const fn of this.listeners) fn() }

  // ── reads ──────────────────────────────────────────────────────────────────
  get channels() { return this.data.channels }
  get groups() { return this.data.groups }
  get users() { return this.data.users }
  channel(id) { return this.channels.find(c => c.id === id) }
  group(id) { return this.groups.find(g => g.id === id) }
  user(id) { return this.users.find(u => u.id === id) }
  userByName(username) {
    const n = String(username ?? '').trim().toLowerCase()
    return this.users.find(u => u.username.toLowerCase() === n)
  }
  publicUser(u) { const { passwordHash, ...rest } = u; return rest }

  /** { channelId: {talk, listen} } for every channel the user can use at all. */
  effective(user) {
    const out = {}
    const slot = ch => (out[ch] ??= { talk: false, listen: false })
    for (const gid of user.groups ?? []) {
      const g = this.group(gid)
      if (!g) continue
      for (const [ch, gr] of Object.entries(g.grants)) {
        if (!this.channel(ch)) continue
        if (gr.talk) slot(ch).talk = true
        if (gr.listen) slot(ch).listen = true
      }
    }
    for (const [ch, ov] of Object.entries(user.overrides ?? {})) {
      if (!this.channel(ch)) continue
      if (typeof ov.talk === 'boolean') slot(ch).talk = ov.talk
      if (typeof ov.listen === 'boolean') slot(ch).listen = ov.listen
    }
    for (const ch of Object.keys(out)) if (!out[ch].talk && !out[ch].listen) delete out[ch]
    return out
  }

  // ── channels ───────────────────────────────────────────────────────────────
  #cleanChannel(id, src) {
    const name = String(src.name ?? '').trim().slice(0, 24)
    if (!name) throw new DirectoryError('Channel name is required')
    const color = src.color ?? '#6366f1'
    if (!COLOR.test(color)) throw new DirectoryError('Color must look like #rrggbb')
    const duck = src.duck
    if (duck != null && !(duck >= 0 && duck <= 1)) throw new DirectoryError('Duck level must be between 0 and 1')
    // A music channel carries one-way stereo music: no talk-back, and it is never an IFB.
    const music = !!src.music
    const ifb = !!src.ifb && !music
    // Optional stream (internet radio, Icecast, an MP3/AAC/Ogg stream or file) the A1 can start with one click.
    let source = ''
    if (music && src.source) {
      source = String(src.source).trim().slice(0, 500)
      let url = null
      try { url = new URL(source) } catch { /* not a URL */ }
      if (!url || !/^https?:$/.test(url.protocol)) throw new DirectoryError('Stream URL must start with http:// or https://')
      // Links to a music service's web page are not audio streams and cannot be played here.
      if (/(^|\.)(youtube\.com|youtu\.be|spotify\.com|music\.apple\.com|soundcloud\.com|deezer\.com|tidal\.com|pandora\.com|music\.amazon\.[a-z.]+)$/i.test(url.hostname)) {
        throw new DirectoryError('That is a web page for a music service, not an audio stream. Use a radio station\'s direct stream address, or play the service on the A1\'s computer and share its audio instead.')
      }
    }
    // A music channel ducks under IFB talkers by default (its own depth if set); noDuck turns that off.
    const noDuck = music && !!src.noDuck
    return {
      id, name, color, ...(music ? { music: true } : {}), ...(source ? { source } : {}),
      ...(noDuck ? { noDuck: true } : {}),
      ...(ifb ? { ifb: true } : {}), ...((ifb || (music && !noDuck)) && duck != null ? { duck: Number(duck) } : {}),
    }
  }

  addChannel(body) {
    const id = body.id ? String(body.id) : slug(body.name ?? '')
    if (!CHANNEL_ID.test(id)) throw new DirectoryError('Channel id must be 1–24 chars of a-z, 0-9, - or _')
    if (this.channel(id)) throw new DirectoryError(`Channel "${id}" already exists`, 409)
    const ch = this.#cleanChannel(id, body)
    this.channels.push(ch)
    this.#changed()
    return ch
  }

  updateChannel(id, body) {
    const i = this.channels.findIndex(c => c.id === id)
    if (i < 0) throw new DirectoryError('No such channel', 404)
    const src = { ...this.channels[i] }
    for (const k of ['name', 'color', 'ifb', 'duck', 'music', 'source', 'noDuck']) if (body[k] !== undefined) src[k] = body[k]
    this.channels[i] = this.#cleanChannel(id, src)
    this.#changed()
    return this.channels[i]
  }

  deleteChannel(id) {
    if (!this.channel(id)) throw new DirectoryError('No such channel', 404)
    this.data.channels = this.channels.filter(c => c.id !== id)
    for (const g of this.groups) delete g.grants[id]
    for (const u of this.users) delete u.overrides?.[id]
    this.#changed()
  }

  reorderChannels(ids) {
    const byId = new Map(this.channels.map(c => [c.id, c]))
    if (!Array.isArray(ids) || ids.length !== byId.size || !ids.every(i => byId.has(i))) {
      throw new DirectoryError('Reorder must list every channel exactly once')
    }
    this.data.channels = ids.map(i => byId.get(i))
    this.#changed()
  }

  // ── groups ─────────────────────────────────────────────────────────────────
  #cleanGrants(grants = {}) {
    const out = {}
    for (const [ch, g] of Object.entries(grants)) {
      if (!this.channel(ch)) continue
      if (g?.talk || g?.listen) out[ch] = { talk: !!g.talk, listen: !!g.listen }
    }
    return out
  }

  addGroup(body) {
    const name = String(body.name ?? '').trim().slice(0, 32)
    if (!name) throw new DirectoryError('Group name is required')
    if (this.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) throw new DirectoryError('A group with that name exists', 409)
    let id = slug(name) || `g-${randomBytes(3).toString('hex')}`
    while (this.group(id)) id = `${slug(name).slice(0, 18)}-${randomBytes(2).toString('hex')}`
    const g = { id, name, selfJoin: !!body.selfJoin, grants: this.#cleanGrants(body.grants) }
    this.groups.push(g)
    this.#changed()
    return g
  }

  updateGroup(id, body) {
    const g = this.group(id)
    if (!g) throw new DirectoryError('No such group', 404)
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 32)
      if (!name) throw new DirectoryError('Group name is required')
      if (this.groups.some(o => o !== g && o.name.toLowerCase() === name.toLowerCase())) throw new DirectoryError('A group with that name exists', 409)
      g.name = name
    }
    if (body.selfJoin !== undefined) g.selfJoin = !!body.selfJoin
    if (body.grants !== undefined) g.grants = this.#cleanGrants(body.grants)
    this.#changed()
    return g
  }

  deleteGroup(id) {
    if (!this.group(id)) throw new DirectoryError('No such group', 404)
    this.data.groups = this.groups.filter(g => g.id !== id)
    for (const u of this.users) u.groups = u.groups.filter(x => x !== id)
    this.#changed()
  }

  // ── users ──────────────────────────────────────────────────────────────────
  #cleanUserFields(body, base) {
    const out = { ...base }
    if (body.username !== undefined) {
      const username = String(body.username).trim()
      if (!/^[\w.@-]{2,40}$/.test(username)) throw new DirectoryError('Username must be 2–40 letters, digits or . _ @ -')
      const clash = this.userByName(username)
      if (clash && clash.id !== base.id) throw new DirectoryError('That username is taken', 409)
      out.username = username
    }
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 32)
      if (!name) throw new DirectoryError('Display name is required')
      out.name = name
    }
    if (body.title !== undefined) out.title = String(body.title).trim().slice(0, 32)
    if (body.groups !== undefined) {
      if (!Array.isArray(body.groups) || body.groups.some(g => !this.group(g))) throw new DirectoryError('Unknown group')
      out.groups = [...new Set(body.groups)]
    }
    if (body.overrides !== undefined) {
      const ov = {}
      for (const [ch, o] of Object.entries(body.overrides ?? {})) {
        if (!this.channel(ch)) continue
        const e = {}
        if (typeof o?.talk === 'boolean') e.talk = o.talk
        if (typeof o?.listen === 'boolean') e.listen = o.listen
        if (Object.keys(e).length) ov[ch] = e
      }
      out.overrides = ov
    }
    if (body.admin !== undefined) out.admin = !!body.admin
    if (body.disabled !== undefined) out.disabled = !!body.disabled
    if (body.password !== undefined && body.password !== '') {
      if (String(body.password).length < 8) throw new DirectoryError('Password must be at least 8 characters')
      out.passwordHash = hashPasswordSync(String(body.password))
    }
    return out
  }

  #adminsExcluding(user) {
    return this.users.filter(u => u !== user && u.admin && !u.disabled).length
  }

  addUser(body) {
    if (!body.password) throw new DirectoryError('A password is required')
    const base = { id: `u_${randomBytes(5).toString('hex')}`, username: '', name: '', title: '', groups: [], overrides: {}, admin: false, disabled: false }
    if (!body.username) throw new DirectoryError('Username is required')
    const u = this.#cleanUserFields({ name: body.username, ...body }, base)
    this.users.push(u)
    this.#changed()
    return u
  }

  updateUser(id, body) {
    const i = this.users.findIndex(u => u.id === id)
    if (i < 0) throw new DirectoryError('No such user', 404)
    const next = this.#cleanUserFields(body, this.users[i])
    if (this.users[i].admin && !this.users[i].disabled && (!next.admin || next.disabled) && this.#adminsExcluding(this.users[i]) === 0) {
      throw new DirectoryError('Cannot remove or disable the last administrator', 409)
    }
    this.users[i] = next
    this.#changed()
    return next
  }

  deleteUser(id) {
    const u = this.user(id)
    if (!u) throw new DirectoryError('No such user', 404)
    if (u.admin && !u.disabled && this.#adminsExcluding(u) === 0) throw new DirectoryError('Cannot delete the last administrator', 409)
    this.data.users = this.users.filter(x => x !== u)
    this.#changed()
  }

  /** First-run bootstrap so there is always someone who can open the admin page. */
  ensureAdmin(password) {
    if (this.users.some(u => u.admin && !u.disabled)) return null
    const pw = password || randomBytes(9).toString('base64url')
    const base = this.userByName('admin')
    if (base) { base.admin = true; base.disabled = false; base.passwordHash = hashPasswordSync(pw) }
    else this.users.push({ id: `u_${randomBytes(5).toString('hex')}`, username: 'admin', name: 'Admin', title: 'Admin', groups: [], overrides: {}, admin: true, disabled: false, passwordHash: hashPasswordSync(pw) })
    this.#changed()
    return { username: 'admin', password: pw, generated: !password }
  }
}
