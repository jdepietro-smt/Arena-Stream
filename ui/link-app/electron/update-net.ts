// Software updates, the network part: ask the Link directory what to install, and download it safely (resumable, checked
// against the published size and SHA-256 before it is ever run). No Electron here, so it can be tested with plain node.
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { Offer, safeFileName } from './update-core'

function base(directory: string): URL { return new URL(directory.includes('://') ? directory : `http://${directory}`) }

function request(directory: string, key: string, urlPath: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = base(directory)
    const req = http.request({ method: 'GET', host: u.hostname, port: Number(u.port) || 80, path: urlPath, agent: false, timeout: timeoutMs, headers: { 'X-Arena-Key': key, ...headers } }, resolve)
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

export async function checkOffer(o: { directory: string; key: string; app: string; host: string; version: string }): Promise<Offer> {
  const res = await request(o.directory, o.key, `/v1/update/${encodeURIComponent(o.app)}/latest?host=${encodeURIComponent(o.host)}&version=${encodeURIComponent(o.version)}`)
  let data = ''
  res.setEncoding('utf8')
  for await (const c of res) data += c
  if (res.statusCode !== 200) throw new Error(`directory answered ${res.statusCode}`)
  return JSON.parse(data) as Offer
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

// Downloads the offered installer into `dir` and returns its path. Resumes a partial download, refuses a file whose size or
// hash differs from what was published, and never leaves a half-written file under the final name.
export async function downloadRelease(o: { directory: string; key: string; app: string; offer: Offer; dir: string; onProgress?: (pct: number) => void }): Promise<string> {
  if (!o.offer.update || !safeFileName(o.offer.file) || !/^[0-9a-f]{64}$/i.test(String(o.offer.sha256 || '')) || !(Number(o.offer.size) > 0)) throw new Error('the offer is not usable')
  const offer = o.offer as Offer & { file: string; sha256: string; size: number }
  fs.mkdirSync(o.dir, { recursive: true })
  const final = path.join(o.dir, offer.file), part = final + '.part'

  // Already downloaded and intact (for example after a restart): nothing to do.
  if (fs.existsSync(final) && fs.statSync(final).size === offer.size && (await sha256File(final)) === offer.sha256.toLowerCase()) { o.onProgress?.(100); return final }
  try { fs.rmSync(final, { force: true }) } catch { /* in use: the rename below will say */ }

  let have = fs.existsSync(part) ? fs.statSync(part).size : 0
  if (have > offer.size) { fs.rmSync(part, { force: true }); have = 0 }
  while (have < offer.size) {
    const res = await request(o.directory, o.key, `/v1/update/${encodeURIComponent(o.app)}/file/${encodeURIComponent(offer.file)}`, have ? { Range: `bytes=${have}-` } : {}, 15000)
    if (res.statusCode === 416) { fs.rmSync(part, { force: true }); have = 0; continue }
    if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); throw new Error(`download refused (${res.statusCode})`) }
    if (res.statusCode === 200 && have) { fs.rmSync(part, { force: true }); have = 0 }     // the server ignored the range: start over
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' })
    let got = have
    try {
      for await (const chunk of res) {
        if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()))
        got += (chunk as Buffer).length
        o.onProgress?.(Math.min(99, Math.floor(got / offer.size * 100)))
        if (got > offer.size) throw new Error('the download is larger than published')
      }
    } finally { await new Promise<void>(r => out.end(r)) }
    have = fs.statSync(part).size
    if (have < offer.size && res.complete) throw new Error('the download ended early')
  }
  if (have !== offer.size) { fs.rmSync(part, { force: true }); throw new Error('size does not match what was published') }
  if ((await sha256File(part)) !== offer.sha256.toLowerCase()) { fs.rmSync(part, { force: true }); throw new Error('the download failed its integrity check')  }
  fs.renameSync(part, final)
  o.onProgress?.(100)
  return final
}

// Removes installers (and half downloads) other than the one in use.
export function cleanOld(dir: string, keepFile: string | null) {
  try { for (const f of fs.readdirSync(dir)) if (f !== keepFile && f !== keepFile + '.part') fs.rmSync(path.join(dir, f), { force: true }) } catch { /* nothing there */ }
}
