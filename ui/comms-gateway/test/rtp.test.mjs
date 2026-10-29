// Runs against the compiled Electron main-process modules (npm test builds them first).
import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { parseRtp, decodeChannel, encodeMono, buildRtp } from '../dist-electron/rtp-codec.js'
import { RtpReceiver, RtpSender } from '../dist-electron/rtp.js'

test('L24 and L16 encode/decode round-trip, big-endian, signed', () => {
  const src = Float32Array.from([0, 0.5, -0.5, 0.999, -1, 0.123456])
  for (const [fmt, tol] of [['L24', 1e-6], ['L16', 4e-5]]) {
    const back = decodeChannel(encodeMono(src, fmt), fmt, 1, 0)
    src.forEach((v, i) => assert.ok(Math.abs(back[i] - v) <= tol, `${fmt} sample ${i}: ${back[i]} vs ${v}`))
  }
  assert.deepEqual([...encodeMono(Float32Array.from([1, -1]), 'L24')], [0x7f, 0xff, 0xff, 0x80, 0x00, 0x01])
  // Out-of-range input clips instead of wrapping.
  assert.ok(decodeChannel(encodeMono(Float32Array.from([2.5]), 'L16'), 'L16', 1, 0)[0] > 0.99)
})

test('picks the right channel out of an interleaved multichannel payload', () => {
  const a = encodeMono(Float32Array.from([0.1, 0.2]), 'L24')
  const b = encodeMono(Float32Array.from([-0.3, -0.4]), 'L24')
  const inter = new Uint8Array(12) // 2 frames x 2 channels x 3 bytes
  for (let f = 0; f < 2; f++) { inter.set(a.subarray(f * 3, f * 3 + 3), f * 6); inter.set(b.subarray(f * 3, f * 3 + 3), f * 6 + 3) }
  const ch1 = decodeChannel(inter, 'L24', 2, 1)
  assert.ok(Math.abs(ch1[0] + 0.3) < 1e-6 && Math.abs(ch1[1] + 0.4) < 1e-6)
})

test('parseRtp reads the header, skips CSRC/extension, rejects junk', () => {
  const payload = Uint8Array.from([1, 2, 3, 4, 5, 6])
  const pkt = buildRtp({ payloadType: 97, sequence: 65535, timestamp: 4294967295, ssrc: 0xdeadbeef, payload })
  const p = parseRtp(pkt)
  assert.deepEqual([p.payloadType, p.sequence, p.timestamp, p.ssrc], [97, 65535, 4294967295, 0xdeadbeef])
  assert.deepEqual([...p.payload], [...payload])

  // Same packet with 1 CSRC and a 1-word header extension.
  const withExt = new Uint8Array(12 + 4 + 8 + payload.length)
  withExt.set(pkt.subarray(0, 12)); withExt[0] = 0x80 | 0x10 | 0x01
  withExt[16] = 0xbe; withExt[17] = 0xde; withExt[19] = 1 // ext profile + length=1 word
  withExt.set(payload, 24)
  assert.deepEqual([...parseRtp(withExt).payload], [...payload])

  assert.equal(parseRtp(new Uint8Array(5)), null)
  assert.equal(parseRtp(Uint8Array.from([0x40, ...new Array(11).fill(0)])), null, 'version must be 2')
})

test('sender -> receiver over UDP loopback: audio survives, 1 ms packets, no loss', async () => {
  const port = 41000 + Math.floor(Math.random() * 1000)
  const got = []
  const rx = new RtpReceiver({ port, format: 'L24', channels: 1, channel: 0, payloadType: 97, onSamples: s => got.push(s) })
  await rx.start()
  const tx = new RtpSender({ address: '127.0.0.1', port, format: 'L24', payloadType: 97, ptimeMs: 1 })
  // 100 ms of a 1 kHz tone, pushed as 128-sample worklet quanta like the real app does.
  const tone = Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000))
  for (let i = 0; i < tone.length; i += 128) tx.push(tone.slice(i, i + 128))
  await new Promise(r => setTimeout(r, 400))
  tx.stop(); rx.stop()
  const all = Float32Array.from(got.flatMap(s => [...s]))
  assert.ok(all.length >= 4800 - 480, `received ${all.length} samples`)
  assert.ok(tx.sent >= 90, `sent ${tx.sent} packets`)
  const n = Math.min(all.length, tone.length)
  let err = 0
  for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(all[i] - tone[i]))
  assert.ok(err < 1e-5, `max sample error ${err}`)
})

test('receiver counts lost packets and drops reordered ones', async () => {
  const port = 42000 + Math.floor(Math.random() * 1000)
  const got = []
  let stats
  const rx = new RtpReceiver({ port, format: 'L16', channels: 1, channel: 0, onSamples: s => got.push(s), onStats: s => { stats = s } })
  await rx.start()
  const sock = dgram.createSocket('udp4')
  const send = seq => new Promise(r => sock.send(buildRtp({ payloadType: 97, sequence: seq, timestamp: seq * 480, ssrc: 1, payload: encodeMono(new Float32Array(480), 'L16') }), port, '127.0.0.1', r))
  for (const seq of [10, 11, 14, 13, 15]) await send(seq) // 12,13 missing at first; 13 then arrives late
  await new Promise(r => setTimeout(r, 1300))
  sock.close(); rx.stop()
  assert.equal(stats.lost, 2)
  assert.equal(stats.late, 1)
  assert.equal(got.length, 4, 'late packet dropped, others delivered')
})
