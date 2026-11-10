'use strict'
// Share links and the view log, kept in one JSON file (written atomically). The portal holds a few
// hundred links at most, so a database would add a dependency for nothing.
const fs = require('node:fs')
const path = require('node:path')

const MAX_VIEWS = 5000

function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'portal.json')
  let data = { links: {}, views: [] }
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { /* first run */ }

  let pending = null
  function save() {
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, file)
    }, 200)
    pending.unref?.()
  }
  function flush() {
    if (pending) { clearTimeout(pending); pending = null }
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, file)
  }

  return {
    flush,
    links: () => Object.values(data.links),
    link: id => data.links[id] || null,
    putLink(l) { data.links[l.id] = l; save() },
    addView(v) {
      data.views.push(v)
      if (data.views.length > MAX_VIEWS) data.views.splice(0, data.views.length - MAX_VIEWS)
      save()
    },
    views: id => data.views.filter(v => v.id === id),
    viewCount: id => { let n = 0; for (const v of data.views) if (v.id === id) n++; return n },
  }
}

module.exports = { openStore }
