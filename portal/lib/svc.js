'use strict'
// The portal keeps its data in memory and writes it back on every change, so a script that edits
// admin.json while the service runs would be overwritten. This stops the service around the edit
// (when systemd has it running) and starts it again afterwards.
const { execFileSync } = require('node:child_process')

function sh(args) { try { execFileSync('systemctl', args, { stdio: 'ignore' }); return true } catch { return false } }

function withServiceStopped(fn, name = 'arena-portal.service') {
  const wasRunning = sh(['is-active', '--quiet', name])
  if (wasRunning) sh(['stop', name])
  try { return fn() } finally { if (wasRunning) sh(['start', name]) }
}

module.exports = { withServiceStopped }
