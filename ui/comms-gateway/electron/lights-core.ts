// Fires one "hardware call light" action: an HTTP request, or a raw TCP / UDP message, at a network relay, a Companion
// button, a lighting controller or anything else that can switch a light. Plain Node, so it can be tested without Electron.
import * as net from 'net'
import * as dgram from 'dgram'

export interface LightAction { kind: 'http' | 'tcp' | 'udp'; target: string; data: string }
export type LightResult = { ok: true } | { ok: false; error: string }

/** "\r", "\n", "\t" and "\xNN" in a typed payload become the real bytes (relay protocols are full of them). */
export function unescapePayload(s: string): Buffer {
  const text = String(s ?? '')
    .replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
  return Buffer.from(text, 'latin1')
}

export function parseHostPort(target: string): { host: string; port: number } | null {
  const m = /^\s*([^\s:]+):(\d{1,5})\s*$/.exec(String(target ?? ''))
  if (!m) return null
  const port = Number(m[2])
  return port >= 1 && port <= 65535 ? { host: m[1], port } : null
}

const TIMEOUT_MS = 3000

export async function fireAction(a: LightAction): Promise<LightResult> {
  if (!a || !String(a.target ?? '').trim()) return { ok: true } // nothing to do
  try {
    if (a.kind === 'http') {
      let url: URL
      try { url = new URL(a.target.trim()) } catch { return { ok: false, error: 'That is not a web address (it should start with http://)' } }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'The address must start with http:// or https://' }
      const body = a.data ? String(a.data) : undefined
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET', body, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: body ? { 'content-type': body.trim().startsWith('{') ? 'application/json' : 'text/plain' } : undefined,
      })
      return res.ok ? { ok: true } : { ok: false, error: `The device answered ${res.status}` }
    }
    const hp = parseHostPort(a.target)
    if (!hp) return { ok: false, error: 'Use host:port, for example 192.168.1.50:5000' }
    const payload = unescapePayload(a.data)
    if (a.kind === 'udp') {
      return await new Promise<LightResult>(resolve => {
        const sock = dgram.createSocket('udp4')
        sock.send(payload, hp.port, hp.host, err => { sock.close(); resolve(err ? { ok: false, error: err.message } : { ok: true }) })
      })
    }
    return await new Promise<LightResult>(resolve => {
      const sock = net.createConnection({ host: hp.host, port: hp.port })
      let done = false
      const finish = (r: LightResult) => { if (done) return; done = true; sock.destroy(); resolve(r) }
      sock.setTimeout(TIMEOUT_MS, () => finish({ ok: false, error: 'No answer from the device (timed out)' }))
      sock.on('error', e => finish({ ok: false, error: e.message }))
      sock.on('connect', () => sock.end(payload, () => finish({ ok: true })))
    })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
