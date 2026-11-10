'use strict'
// Creates a portal account from the server, with a generated password that is printed once.
//   node /opt/arena-portal/add-user.js <username> [--reset] [data dir]
// An existing account is left alone unless --reset is given (which also signs that user out).
// Nothing is typed or stored in clear text: the password is random lowercase letters and digits,
// easy to read off a console, and can be changed afterwards in the Admin page.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const auth = require('./lib/auth')
const { openAdmin, USERNAME } = require('./lib/admin')
const { withServiceStopped } = require('./lib/svc')

const args = process.argv.slice(2)
const reset = args.includes('--reset')
const rest = args.filter(a => a !== '--reset')
const name = rest[0] || ''
const dir = rest[1] || '/var/lib/arena-portal'
if (!USERNAME.test(name)) { console.error('usage: node add-user.js <username> [--reset] [data dir]   (username: 2 to 40 letters, digits, . _ - @)'); process.exit(2) }

const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
let pw = ''
for (const b of crypto.randomBytes(14)) pw += abc[b % abc.length]

const result = withServiceStopped(() => {
  const admin = openAdmin(dir)
  const had = admin.user(name)
  if (had && !reset) return 'exists'
  admin.setUser(had ? had.username : name, auth.hashPassword(pw))
  admin.audit('system', had ? 'account.user.password' : 'account.user.create', `${name} (from the server)`)
  admin.flush()
  try { const st = fs.statSync(dir); fs.chownSync(path.join(dir, 'admin.json'), st.uid, st.gid) } catch { /* keep root ownership if chown is not allowed */ }
  return had ? 'reset' : 'created'
})

if (result === 'exists') console.log(`Account ${name} already exists (use --reset for a new password).`)
else console.log(`Account ${name} ${result}.\nUsername: ${name}\nPassword: ${pw}`)
