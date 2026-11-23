'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const S = require('../lib/segments')

const T0 = Date.UTC(2026, 10, 22, 15, 40, 0)

test('piece names are UTC start times and round trip', () => {
  assert.equal(S.segName(T0), '20261122T154000.ts')
  assert.equal(S.parseSeg('20261122T154000.ts'), T0)
  assert.equal(S.parseSeg(S.segName(T0 + 70000)), T0 + 70000)
  for (const bad of ['', 'x.ts', '20261122T154000.mp4', '20261322T154000.ts', '../20261122T154000.ts', 'latest.json']) assert.equal(S.parseSeg(bad), null, bad)
})

test('folder names are safe', () => {
  assert.equal(S.dirNameFor('Rangers - MSG'), 'Rangers-MSG')
  assert.ok(!/[\/\\:.]/.test(S.dirNameFor('../../etc/passwd')))
  assert.ok(!/[\/\\:]/.test(S.dirNameFor('a/b\\c:d')))
  assert.equal(S.dirNameFor('***'), 'stream')
})

const segs = (...starts) => starts.map(ms => ({ ms, file: S.segName(ms) }))

test('coverage joins consecutive pieces and shows a gap when the stream went away', () => {
  const s = segs(T0, T0 + 10000, T0 + 20000, T0 + 120000, T0 + 130000)          // a 30 s run, a gap, a 20 s run
  assert.deepEqual(S.coverage(s, T0 - 1e6, T0 + 1e6), [{ start: T0, end: T0 + 30000 }, { start: T0 + 120000, end: T0 + 140000 }])
  assert.deepEqual(S.coverage(s, T0 + 5000, T0 + 25000), [{ start: T0 + 5000, end: T0 + 25000 }])     // clipped to the window asked for
  assert.deepEqual(S.coverage(s, T0 + 40000, T0 + 100000), [])
  assert.deepEqual(S.coverage([], 0, 1e12), [])
})

test('a long hole splits a run; pieces that follow on do not', () => {
  assert.equal(S.coverage(segs(T0, T0 + 10000, T0 + 30000), 0, 1e15).length, 2)    // one piece missing: two runs
  assert.equal(S.coverage(segs(T0, T0 + 10000, T0 + 20000), 0, 1e15).length, 1)
})

test('a cut picks the pieces that overlap it and says how far into the first one to start', () => {
  const s = segs(T0, T0 + 10000, T0 + 20000, T0 + 30000)
  const p = S.pieceFor(s, T0 + 14000, T0 + 33000)
  assert.deepEqual(p.files.map(f => f.ms), [T0 + 10000, T0 + 20000, T0 + 30000])
  assert.equal(p.offsetSec, 4)
  assert.equal(p.durationSec, 19)
  assert.equal(S.pieceFor(s, T0 + 100000, T0 + 110000), null)
  assert.equal(S.pieceFor(s, T0 + 10000, T0 + 20000).files.length, 1)                // ends exactly at the next piece: that one is not needed
})

test('seven day retention keeps what is recent and drops what is not', () => {
  const now = T0 + 8 * 86400000
  const keep = 7 * 86400000
  const s = segs(T0, T0 + 86400000 - 60000, now - keep + 60000, now - 1000)
  assert.deepEqual(S.expired(s, now, keep).map(x => x.ms), [T0, T0 + 86400000 - 60000])
})

test('the disk guard frees the oldest pieces first, across streams', () => {
  const by = { a: [{ ms: 100, file: 'a1', size: 10 }, { ms: 300, file: 'a2', size: 10 }], b: [{ ms: 200, file: 'b1', size: 10 }, { ms: 400, file: 'b2', size: 10 }] }
  const r = S.oldestFirst(by, 25)
  assert.deepEqual(r.pieces.map(p => p.stream + p.ms), ['a100', 'b200', 'a300'])
  assert.equal(r.freed, 30)
  assert.deepEqual(S.oldestFirst(by, 0).pieces, [])
})

test('listing a folder reads only pieces, in order', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-'))
  for (const ms of [T0 + 20000, T0, T0 + 10000]) fs.writeFileSync(path.join(d, S.segName(ms)), 'x')
  fs.writeFileSync(path.join(d, 'meta.json'), '{}'); fs.writeFileSync(path.join(d, 'junk.ts'), 'x')
  assert.deepEqual(S.listSegments(d).map(s => s.ms), [T0, T0 + 10000, T0 + 20000])
  assert.deepEqual(S.listSegments(path.join(d, 'nope')), [])
})
