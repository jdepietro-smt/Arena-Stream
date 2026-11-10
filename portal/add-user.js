'use strict'
// Creates a portal account from the server, with a generated password that is printed once.
//   node /opt/arena-portal/add-user.js <username> [--reset] [--role user] [--name "Full Name"] [--email a@b.c] [data dir]
// An account made here is an admin (the Admin area opens with no second password) unless --role user.
// An existing account is left alone unless --reset is given (which also signs that user out).
// The password is random lowercase letters and digits, easy to read off a console, and can be
// changed afterwards from the Admin page. Nothing is stored in clear text.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const auth = require('./lib/auth')
const { openAdmin, USERNAME, ROLES, cleanProfile } = require('./lib/admin')
const { withServiceStopped } = require('./lib/svc')

const argv = process.argv.slice(2)
let reset = false, role = 'admin', pname = '', pemail = ''
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--reset') reset = true
  else if (argv[i] === '--role') role = argv[++i] || ''
  else if (argv[i] === '--name') pname = argv[++i] || ''
  else if (argv[i] === '--email') pemail = argv[++i] || ''
  else positional.push(argv[i])
}
const name = positional[0] || ''
const dir = positional[1] || '/var/lib/arena-portal'
if (!USERNAME.test(name) || !ROLES.includes(role)) {
  console.error('usage: node add-user.js <username> [--reset] [--role admin|user] [data dir]   (username: 2 to 40 letters, digits, . _ - @)')
  process.exit(2)
}

let prof
try { prof = cleanProfile({ name: pname, email: pemail }) } catch (e) { console.error(e.message); process.exit(2) }

const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
let pw = ''
for (const b of crypto.randomBytes(14)) pw += abc[b % abc.length]

const result = withServiceStopped(() => {
  const admin = openAdmin(dir)
  const had = admin.user(name)
  if (had && !reset) return { what: 'exists', role: had.role || 'admin' }
  const u = admin.setUser(had ? had.username : name, auth.hashPassword(pw), had ? undefined : role)
  if (pname || pemail) admin.setProfile(u.username, prof)
  admin.audit('system', had ? 'account.user.password' : 'account.user.create', `${name} (from the server)`)
  admin.flush()
  try { const st = fs.statSync(dir); fs.chownSync(path.join(dir, 'admin.json'), st.uid, st.gid) } catch { /* keep root ownership if chown is not allowed */ }
  return { what: had ? 'reset' : 'created', role: u.role || 'admin' }
})

if (result.what === 'exists') console.log(`Account ${name} already exists (${result.role}); use --reset for a new password.`)
else console.log(`Account ${name} ${result.what} (${result.role}).\nUsername: ${name}\nPassword: ${pw}`)
