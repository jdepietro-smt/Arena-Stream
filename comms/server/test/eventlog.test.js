import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEventLog } from '../eventlog.js'

test('link reports fold into per-minute records; loss episodes are logged once each way', () => {
  let t = 60_000 * 1000
  const log = createEventLog(null, () => t)
  const agg = {}
  log.link('Ann', agg, { tx: 0, rx: 0 })
  log.link('Ann', agg, { tx: 8, rx: 1 })   // loss starts
  log.link('Ann', agg, { tx: 9, rx: 0 })   // still lossy: no second event
  t += 60_000
  log.link('Ann', agg, { tx: 0, rx: 0 })   // new minute flushes the first; clears the episode
  log.flush('Ann', agg)
  const ev = log.recent().map(e => e.k)
  assert.deepEqual(ev, ['recovered', 'loss'])
  const h = log.history(24)
  assert.equal(h.length, 1)
  assert.equal(h[0].minutes, 2)
  assert.equal(h[0].lossyMinutes, 1)
  assert.equal(h[0].worstTx, 9)
})

test('history is per person, worst first, and old data falls out of the window', () => {
  let t = 1_000_000_000_000
  const log = createEventLog(null, () => t)
  const a = {}, b = {}
  log.link('Old', a, { tx: 50, rx: 0 }); log.flush('Old', a)
  t += 30 * 3600 * 1000
  log.link('Ann', a, { tx: 0, rx: 0 }); log.flush('Ann', a)
  log.link('Bob', b, { tx: 4, rx: 0 }); log.flush('Bob', b)
  const h = log.history(24)
  assert.deepEqual(h.map(x => x.name), ['Bob', 'Ann'])
})
