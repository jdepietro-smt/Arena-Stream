// Mints signed, expiring SRT read links for a relay stream.
// Same token format as relay/linkd/token.js (the server-side verifier):
//   v1.<base64url {s: stream|"*", e: expiry unix s, 0 = never}>.<Ed25519 signature>
// The private key stays on this machine (userData/link-signing-key.pem); the
// server only holds the matching public key (relay/linkd/public-key.pem).
import * as crypto from 'crypto'
import * as fs from 'fs'

export interface ShareLinkOpts {
  keyPath: string        // PKCS8 PEM Ed25519 private key
  host: string           // relay host
  port: number           // relay SRT port
  streamName: string
  hours: number          // 0 = never expires
  latencyMs: number      // latency hint baked into the link
  nowSec?: number
}

export const relayStreamName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '_')

export function mintToken(privateKeyPem: string, stream: string, expiresAtSec: number): string {
  const payload = Buffer.from(JSON.stringify({ s: stream, e: expiresAtSec })).toString('base64url')
  const sig = crypto.sign(null, Buffer.from('v1.' + payload), privateKeyPem)
  return `v1.${payload}.${sig.toString('base64url')}`
}

export function makeShareLink(o: ShareLinkOpts): { link: string; expiresAt: number } {
  const key = fs.readFileSync(o.keyPath, 'utf8')
  const name = relayStreamName(o.streamName)
  const now = o.nowSec ?? Math.floor(Date.now() / 1000)
  const expiresAt = o.hours > 0 ? now + Math.round(o.hours * 3600) : 0
  const token = mintToken(key, name, expiresAt)
  const link = `srt://${o.host}:${o.port}?streamid=read:${name}:link:${token}`
              + `&mode=caller&latency=${Math.max(40, o.latencyMs) * 1000}`
  return { link, expiresAt }
}
