// Client for the Arena Remote service helper (SYSTEM, in the console session). When the helper is installed it
// carries input injection, so UAC prompts / elevated windows / the login screen can be operated, and it provides
// screen frames while the secure desktop is up (Chromium's screen capture cannot see it).
// Frames: [type:1][len:4 LE][payload]; 'J' = JSON, 'F' = JPEG frame.

const net = require('node:net')
const { EventEmitter } = require('node:events')

const PIPE = process.env.ARENA_HELPER_PIPE ?? '\\\\.\\pipe\\arena-remote-helper'

class SecureHelper extends EventEmitter {
  constructor() { super(); this.sock = null; this.buf = Buffer.alloc(0); this.desktop = 'Default' }

  get connected() { return !!this.sock && !this.sock.destroyed }

  /** Resolves true when connected; false when the service is not installed/running (callers fall back to local injection). */
  connect() {
    if (this.connected) return Promise.resolve(true)
    return new Promise(resolve => {
      const sock = net.connect(PIPE)
      sock.once('connect', () => { this.sock = sock; this.buf = Buffer.alloc(0); resolve(true) })
      sock.once('error', () => resolve(false))
      sock.on('data', d => this.onData(d))
      sock.on('close', () => { if (this.sock === sock) { this.sock = null; this.desktop = 'Default'; this.emit('close') } })
    })
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d])
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32LE(1)
      if (len < 0 || len > 16 * 1024 * 1024) return this.close()
      if (this.buf.length < 5 + len) break
      const type = String.fromCharCode(this.buf[0]), payload = this.buf.subarray(5, 5 + len)
      this.buf = this.buf.subarray(5 + len)
      if (type === 'F') this.emit('frame', payload)
      else if (type === 'J') {
        try {
          const m = JSON.parse(payload.toString('utf8'))
          if (m.t === 'desktop') { this.desktop = m.name; this.emit('desktop', m.name) }
        } catch {}
      }
    }
  }

  send(obj) {
    if (!this.connected) return false
    const body = Buffer.from(JSON.stringify(obj))
    const head = Buffer.alloc(5)
    head[0] = 0x4a
    head.writeInt32LE(body.length, 1)
    this.sock.write(Buffer.concat([head, body]))
    return true
  }

  close() { this.sock?.destroy(); this.sock = null }
}

module.exports = { SecureHelper }
