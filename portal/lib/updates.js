'use strict'
// Software updates for the Arena Link apps. The portal keeps the releases on disk; the Link directory serves them to the apps
// (see link/directory/directory.py: /v1/update/...), and each app downloads, checks and installs by itself.
//
//   <dir>/<app>/Arena-Link-Setup-0.2.0.exe   the installer, as built (the version is read from its file name)
//   <dir>/<app>/latest.json                  what the apps are offered: {version, file, sha256, size, notes, publishedAt, exact, paused, allow}
//   <dir>/<app>/history.json                 every release kept, newest first, so one can be rolled back to
//
// A new release starts PAUSED: nothing updates until someone chooses Release to everyone (or to named PCs first).
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const APPS = {
  link:    { label: 'Arena Link',    pattern: /^Arena-Link-Setup-(\d+\.\d+\.\d+)\.exe$/, selfUpdates: true },
  decoder: { label: 'Arena Decoder', pattern: /^Arena-Decoder-Setup-(\d+\.\d+\.\d+)\.exe$/, selfUpdates: false },   // the standalone Decoder app cannot update itself yet
}
const KEEP = 5                          // releases kept per app
const MAX_BYTES = 500 * 1024 * 1024
const MIN_BYTES = 1024 * 1024           // an installer is never smaller than this: catches an empty or cut-off upload

const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0 }

// 'Arena-Link-Setup-0.2.0.exe' -> { app: 'link', version: '0.2.0' }, or null for any other name.
function parseName(name) {
  const base = path.basename(String(name || ''))
  for (const [app, a] of Object.entries(APPS)) { const m = base.match(a.pattern); if (m) return { app, version: m[1], file: base } }
  return null
}

function openUpdates(dir) {
  const appDir = app => path.join(dir, app)
  const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
  const writeJson = (p, v) => { const t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, p) }
  const latestFile = app => path.join(appDir(app), 'latest.json')
  const historyFile = app => path.join(appDir(app), 'history.json')
  const history = app => readJson(historyFile(app), [])

  // Streams an upload to disk, counting and hashing as it goes. Resolves { size, sha256 } or rejects (and leaves nothing behind).
  function receive(app, file, stream) {
    fs.mkdirSync(appDir(app), { recursive: true })
    const part = path.join(appDir(app), file + '.part')
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part)
      const hash = crypto.createHash('sha256')
      let size = 0, head = Buffer.alloc(0), done = false
      const fail = err => { if (done) return; done = true; out.destroy(); fs.rm(part, { force: true }, () => reject(err)) }
      stream.on('data', c => {
        size += c.length
        if (size > MAX_BYTES) { stream.destroy(); return fail(new Error('the file is larger than 500 MB')) }
        if (head.length < 2) head = Buffer.concat([head, c.subarray(0, 2 - head.length)])
        hash.update(c)
        if (!out.write(c)) { stream.pause(); out.once('drain', () => stream.resume()) }
      })
      stream.on('error', fail)
      stream.on('aborted', () => fail(new Error('the upload was cut off')))
      stream.on('end', () => out.end(() => {
        if (done) return
        if (size < MIN_BYTES) return fail(new Error('that file is too small to be an installer'))
        if (head.toString('latin1') !== 'MZ') return fail(new Error('that is not a Windows program (installer .exe)'))
        done = true
        fs.renameSync(part, path.join(appDir(app), file))
        resolve({ size, sha256: hash.digest('hex') })
      }))
    })
  }

  function prune(app) {
    const h = history(app)
    const keep = h.slice(0, KEEP)
    for (const old of h.slice(KEEP)) fs.rm(path.join(appDir(app), old.file), { force: true }, () => {})
    writeJson(historyFile(app), keep)
  }

  return {
    parseName, apps: APPS, cmp, receive,
    // Records an uploaded installer as the newest release. Paused until released.
    publish(app, { version, file, sha256, size, notes }) {
      const entry = { version, file, sha256, size, notes: String(notes || '').slice(0, 500), publishedAt: Date.now() }
      const h = history(app).filter(x => x.version !== version)
      h.unshift(entry)
      h.sort((a, b) => cmp(b.version, a.version) || b.publishedAt - a.publishedAt)
      writeJson(historyFile(app), h)
      writeJson(latestFile(app), { ...entry, exact: false, paused: true, allow: [] })
      prune(app)
      return this.state(app)
    },
    state(app) {
      const latest = readJson(latestFile(app), null)
      return { app, label: APPS[app].label, latest, history: history(app) }
    },
    // mode: 'all' (everyone), 'pause' (nobody), 'only' (just these PCs, by name)
    setRollout(app, mode, hosts) {
      const l = readJson(latestFile(app), null)
      if (!l) throw new Error('nothing has been published for this app yet')
      if (mode === 'all') { l.paused = false; l.allow = [] }
      else if (mode === 'pause') { l.paused = true }
      else if (mode === 'only') {
        const list = [...new Set((Array.isArray(hosts) ? hosts : []).map(h => String(h).slice(0, 80)).filter(Boolean))]
        if (!list.length) throw new Error('choose at least one PC')
        l.paused = false; l.allow = list
      } else throw new Error('mode must be all, pause or only')
      writeJson(latestFile(app), l)
      return this.state(app)
    },
    // Makes an older kept release the current one; apps move to exactly that version. Starts paused, like any new release.
    rollback(app, version) {
      const e = history(app).find(x => x.version === version)
      if (!e) throw new Error('that release is not kept any more')
      if (!fs.existsSync(path.join(appDir(app), e.file))) throw new Error('the installer file is missing')
      writeJson(latestFile(app), { ...e, exact: true, paused: true, allow: [] })
      return this.state(app)
    },
    remove(app, version) {
      const l = readJson(latestFile(app), null)
      if (l && l.version === version) throw new Error('that is the current release: roll back to another one first')
      const h = history(app), e = h.find(x => x.version === version)
      if (!e) throw new Error('no such release')
      fs.rmSync(path.join(appDir(app), e.file), { force: true })
      writeJson(historyFile(app), h.filter(x => x.version !== version))
    },
  }
}

module.exports = { openUpdates, parseName, APPS, MAX_BYTES, MIN_BYTES }
