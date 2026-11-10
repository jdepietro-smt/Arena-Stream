'use strict'
// Owner-level state: the passwords, the session epoch (bumping it signs everyone out), the portal
// settings and the activity log. One JSON file, written atomically.
const fs = require('node:fs')
const path = require('node:path')

const MAX_AUDIT = 3000

// What can be changed from the Admin page, with the limits the server enforces.
const SETTINGS = {
  publicBase:           { type: 'url', def: '' },                      // what share links start with
  relayLatencyMs:       { type: 'int', min: 40, max: 1500, def: 0 },   // 0 = use the installed default
  maxPreviews:          { type: 'int', min: 1, max: 10, def: 3 },
  thumbnailsEnabled:    { type: 'bool', def: true },
  thumbEverySec:        { type: 'int', min: 2, max: 30, def: 5 },
  defaultLinkExpiryMin: { type: 'int', min: 0, max: 525600, def: 1440 },
  requireLinkPassword:  { type: 'bool', def: false },
  sharedLogin:          { type: 'bool', def: true },                   // the one shared portal password still works at sign-in
}

function cleanSetting(key, v) {
  const d = SETTINGS[key]
  if (!d) throw new Error(`unknown setting ${key}`)
  if (d.type === 'bool') return v === true || v === 'true'
  if (d.type === 'int') {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`)
    if (d.def === 0 && key === 'relayLatencyMs' && n === 0) return 0
    if (n < d.min || n > d.max) throw new Error(`${key} must be between ${d.min} and ${d.max}`)
    return n
  }
  if (d.type === 'url') {
    const s = String(v || '').trim().replace(/\/$/, '')
    if (s && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(s)) throw new Error('address must look like http://host or https://host')
    return s
  }
  return v
}

function openAdmin(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'admin.json')
  let data = { ownerPwHash: '', adminPwHash: '', epoch: 1, settings: {}, audit: [], users: {} }
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { /* first run */ }

  let timer = null
  const write = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(data)); fs.renameSync(t, file) }
  const save = () => { if (timer) return; timer = setTimeout(() => { timer = null; write() }, 200); timer.unref?.() }
  const flush = () => { if (timer) { clearTimeout(timer); timer = null } write() }

  return {
    flush,
    get ownerPwHash() { return data.ownerPwHash },
    set ownerPwHash(h) { data.ownerPwHash = h; flush() },
    get adminPwHash() { return data.adminPwHash },
    set adminPwHash(h) { data.adminPwHash = h; flush() },
    get epoch() { return data.epoch },
    bumpEpoch() { data.epoch += 1; flush(); return data.epoch },
    settings() {
      const out = {}
      for (const [k, d] of Object.entries(SETTINGS)) out[k] = k in data.settings ? data.settings[k] : d.def
      return out
    },
    // Validates every key first, then applies, so a bad value changes nothing. Returns what changed.
    patchSettings(patch) {
      const clean = {}
      for (const [k, v] of Object.entries(patch || {})) clean[k] = cleanSetting(k, v)
      const before = this.settings(), changed = {}
      for (const [k, v] of Object.entries(clean)) if (before[k] !== v) { data.settings[k] = v; changed[k] = { from: before[k], to: v } }
      if (Object.keys(changed).length) flush()
      return changed
    },
    // Named portal accounts. `ver` changes with the password, which ends that user's sessions.
    users: () => Object.values(data.users).map(u => ({ username: u.username, role: u.role || 'admin', name: u.name || '', email: u.email || '', createdAt: u.createdAt, ver: u.ver })),
    user: name => data.users[String(name).toLowerCase()] || null,
    // role: 'admin' (the Admin area opens without a second password) or 'user'. An account made before
    // roles existed has none, and counts as admin. A password change keeps the role.
    setUser(name, pwHash, role) {
      const key = String(name).toLowerCase()
      const old = data.users[key]
      data.users[key] = { username: old ? old.username : String(name), pwHash, role: role || (old ? old.role : 'user'), createdAt: old ? old.createdAt : Date.now(), ver: old ? old.ver + 1 : 1 }
      flush()
      return data.users[key]
    },
    setProfile(name, prof) {
      const u = data.users[String(name).toLowerCase()]
      if (!u) return false
      u.name = prof.name; u.email = prof.email; flush(); return true
    },
    setRole(name, role) {
      const u = data.users[String(name).toLowerCase()]
      if (!u) return false
      u.role = role; flush(); return true
    },
    deleteUser(name) { const k = String(name).toLowerCase(); const had = !!data.users[k]; delete data.users[k]; if (had) flush(); return had },
    audit(who, action, detail = '', ip = '') {
      data.audit.push({ at: Date.now(), who, action, detail: String(detail).slice(0, 300), ip })
      if (data.audit.length > MAX_AUDIT) data.audit.splice(0, data.audit.length - MAX_AUDIT)
      save()
    },
    auditList({ limit = 200, action = '' } = {}) {
      const rows = action ? data.audit.filter(a => a.action === action || a.action.startsWith(action + '.')) : data.audit
      return rows.slice(-limit).reverse()
    },
  }
}

const ROLES = ['admin', 'user']

// Name and email shown against an account. Both optional; an email must look like one.
function cleanProfile(p) {
  const name = String((p && p.name) || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const email = String((p && p.email) || '').trim()
  if (name.length > 80) throw new Error('name: at most 80 characters')
  if (email.length > 120 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('email address does not look right')
  return { name, email }
}
const USERNAME = /^[A-Za-z0-9._@-]{2,40}$/
module.exports = { openAdmin, SETTINGS, cleanSetting, USERNAME, ROLES, cleanProfile }
