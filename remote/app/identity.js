// Device identity (Ed25519), pinned host keys and the unattended-access passcode.
// The private key never leaves the main process and is encrypted at rest with the OS (DPAPI on Windows).

const { app, safeStorage } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const file = name => path.join(app.getPath('userData'), name)
const readJson = (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) } catch { return fallback } }
const writeJson = (name, v) => fs.writeFileSync(file(name), JSON.stringify(v), { mode: 0o600 })

let key // { privateKey, rawPub }

function load() {
  if (key) return key
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS key storage is unavailable; refusing to keep an identity key unencrypted')
  try {
    const privateKey = crypto.createPrivateKey({ key: safeStorage.decryptString(fs.readFileSync(file('identity.bin'))), format: 'pem' })
    key = { privateKey, rawPub: crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32) }
  } catch {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(file('identity.bin'), safeStorage.encryptString(privateKey.export({ format: 'pem', type: 'pkcs8' })), { mode: 0o600 })
    key = { privateKey, rawPub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32) }
  }
  return key
}

const idForKey = rawPub => crypto.createHash('sha256').update(rawPub).digest('base64url').slice(0, 22)
// Short groups a person can read aloud to confirm a host out of band.
const readable = id => (id.slice(0, 20).match(/.{5}/g) ?? []).join('-')

function info() {
  const { rawPub } = load()
  return { pubKey: rawPub.toString('base64'), hostId: idForKey(rawPub), readable: readable(idForKey(rawPub)) }
}

const sign = msg => crypto.sign(null, Buffer.from(msg), load().privateKey).toString('base64')

const sessionMessage = (sessionId, hostFp, viewerFp) => `arena-remote-session|${sessionId}|${hostFp}|${viewerFp}`

/** Checks the host's signature over both DTLS fingerprints: proves the media path ends at the host's key. */
function verifyHostSignature({ hostId, pubKey, sessionId, hostFp, viewerFp, sig }) {
  try {
    const raw = Buffer.from(pubKey, 'base64')
    if (raw.length !== 32 || idForKey(raw) !== hostId) return false
    const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(sessionMessage(sessionId, hostFp, viewerFp)), pub, Buffer.from(sig, 'base64'))
  } catch { return false }
}

// --- pinned hosts (trust on first use, loud on change) ---
function pinStatus(hostId, pubKey) {
  const pins = readJson('known-hosts.json', {})
  if (idForKey(Buffer.from(pubKey, 'base64')) !== hostId) return { status: 'invalid' }
  if (!pins[hostId]) return { status: 'new', readable: readable(hostId) }
  return pins[hostId] === pubKey ? { status: 'match', readable: readable(hostId) } : { status: 'changed', readable: readable(hostId) }
}
function pinAccept(hostId, pubKey) {
  if (pinStatus(hostId, pubKey).status === 'invalid') return false
  writeJson('known-hosts.json', { ...readJson('known-hosts.json', {}), [hostId]: pubKey })
  return true
}

// --- unattended access passcode (host side) ---
const passFails = { n: 0, until: 0 }
function setPasscode(pw) {
  if (!pw) return writeJson('passcode.json', {}), true
  if (String(pw).length < 8) return false
  const salt = crypto.randomBytes(16)
  writeJson('passcode.json', { salt: salt.toString('base64'), hash: crypto.scryptSync(pw, salt, 64).toString('base64') })
  return true
}
const hasPasscode = () => !!readJson('passcode.json', {}).hash
function checkPasscode(pw) {
  if (passFails.until > Date.now()) return false
  const p = readJson('passcode.json', {})
  if (!p.hash) return false
  const got = crypto.scryptSync(String(pw ?? ''), Buffer.from(p.salt, 'base64'), 64)
  const ok = crypto.timingSafeEqual(got, Buffer.from(p.hash, 'base64'))
  if (ok) passFails.n = 0
  else if (++passFails.n >= 5) { passFails.n = 0; passFails.until = Date.now() + 60_000 }
  return ok
}

module.exports = { info, sign, verifyHostSignature, pinStatus, pinAccept, setPasscode, hasPasscode, checkPasscode }
