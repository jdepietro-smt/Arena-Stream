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
  thumbEverySec:        { type: 'int', min: 2, max: 30, def: 3 },
  defaultLinkExpiryMin: { type: 'int', min: 0, max: 525600, def: 1440 },
  requireLinkPassword:  { type: 'bool', def: false },
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
  let data = { ownerPwHash: '', adminPwHash: '', epoch: 1, settings: {}, audit: [] }
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

module.exports = { openAdmin, SETTINGS, cleanSetting }
