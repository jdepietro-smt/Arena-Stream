'use strict'
// Sets a new owner password when the old one is lost. Run on the server as root:
//   node /opt/arena-portal/reset-owner.js [data dir]
// Prints the new password once. Everyone is signed out, and the shared portal password signs in again.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const auth = require('./lib/auth')
const { openAdmin } = require('./lib/admin')

const dir = process.argv[2] || '/var/lib/arena-portal'
const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
let pw = ''
for (const b of crypto.randomBytes(14)) pw += abc[b % abc.length]

const admin = openAdmin(dir)
admin.ownerPwHash = auth.hashPassword(pw)
admin.patchSettings({ sharedLogin: true })   // so there is always a way to sign in again
admin.bumpEpoch()
admin.audit('system', 'owner.reset', 'owner password reset from the server')
admin.flush()
try { const st = fs.statSync(dir); fs.chownSync(path.join(dir, 'admin.json'), st.uid, st.gid) } catch { /* keep root ownership if chown is not allowed */ }
console.log('New owner password: ' + pw)
