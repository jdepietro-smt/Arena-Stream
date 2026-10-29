import test from 'node:test'
import assert from 'node:assert/strict'
import { SampleRing, deinterleave, interleaveFromRings } from '../dist-electron/asio-core.js'

test('ring: FIFO order, silence on underrun, oldest dropped on overflow', () => {
  const r = new SampleRing(4)
  r.push([1, 2, 3])
  const out = new Float32Array(5)
  assert.equal(r.pull(out, 0, 5), 3)
  assert.deepEqual([...out], [1, 2, 3, 0, 0], 'missing samples read as silence')
  r.push([1, 2, 3, 4, 5, 6])
  assert.equal(r.length, 4)
  const o2 = new Float32Array(4)
  r.pull(o2, 0, 4)
  assert.deepEqual([...o2], [3, 4, 5, 6], 'overflow keeps the newest')
})

test('ring: trim keeps only the newest samples', () => {
  const r = new SampleRing(16)
  r.push([1, 2, 3, 4, 5, 6])
  r.trim(2)
  const out = new Float32Array(2)
  r.pull(out, 0, 2)
  assert.deepEqual([...out], [5, 6])
})

test('deinterleave: frame-major device buffer to channel-major, keeping the first N channels', () => {
  // 3 frames x 4 channels; sample value = channel * 10 + frame
  const dev = new Float32Array(12)
  for (let f = 0; f < 3; f++) for (let c = 0; c < 4; c++) dev[f * 4 + c] = c * 10 + f
  assert.deepEqual([...deinterleave(dev, 3, 4)], [0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32])
  assert.deepEqual([...deinterleave(dev, 3, 4, 2)], [0, 1, 2, 10, 11, 12], 'keeps only the channels in use')
})

test('output mix: each channel only from its own ring, trimmed when running ahead', () => {
  const rings = [new SampleRing(64), new SampleRing(64), new SampleRing(64)]
  rings[0].push([1, 1, 1, 1])
  rings[2].push(Array.from({ length: 40 }, (_, i) => i)) // far ahead of the device
  const out = new Float32Array(4 * 3)
  interleaveFromRings(rings, 4, out, 16, 8) // trim a ring above 16 samples back to 8
  assert.deepEqual([...out.filter((_, i) => i % 3 === 0)], [1, 1, 1, 1], 'channel 1')
  assert.deepEqual([...out.filter((_, i) => i % 3 === 1)], [0, 0, 0, 0], 'channel 2 is silent')
  assert.deepEqual([...out.filter((_, i) => i % 3 === 2)], [32, 33, 34, 35], 'channel 3 skipped ahead to the newest 8, then played from there')
})
