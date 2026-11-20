'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { openSchedules, due, nextRun, clean, validTz, zonedToTs } = require('../lib/schedule')

const NY = 'America/New_York'
const at = (y, m, d, h, mi) => zonedToTs(y, m, d, h, mi, NY)
const entry = o => ({ id: 1, enabled: true, mode: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], start: '19:00', stop: '22:30', fired: {}, ...o })

test('wall-clock times map to the right moment on both sides of daylight saving', () => {
  assert.equal(new Date(at(2026, 3, 7, 19, 0)).toISOString(), '2026-03-08T00:00:00.000Z')    // EST, UTC-5
  assert.equal(new Date(at(2026, 3, 9, 19, 0)).toISOString(), '2026-03-09T23:00:00.000Z')    // EDT, UTC-4
  assert.equal(new Date(at(2026, 10, 31, 19, 0)).toISOString(), '2026-10-31T23:00:00.000Z')  // still EDT
  assert.equal(new Date(at(2026, 11, 1, 19, 0)).toISOString(), '2026-11-02T00:00:00.000Z')   // clocks went back that morning: EST
  assert.ok(validTz(NY) && !validTz('Mars/Olympus'))
})

test('a start fires once its time arrives, not before, and not twice', () => {
  const e = entry({})
  assert.deepEqual(due(e, at(2026, 11, 20, 18, 59), NY), [])
  const d = due(e, at(2026, 11, 20, 19, 0) + 5000, NY)
  assert.deepEqual(d.map(x => [x.action, x.key]), [['start', '2026-11-20:start']])
  e.fired['2026-11-20:start'] = 1
  assert.deepEqual(due(e, at(2026, 11, 20, 19, 1), NY), [])
  assert.deepEqual(due(e, at(2026, 11, 20, 22, 31), NY).map(x => x.action), ['stop'])
})

test('a start that was missed by more than ten minutes is skipped rather than run late', () => {
  assert.deepEqual(due(entry({}), at(2026, 11, 20, 19, 11), NY), [])
  assert.equal(due(entry({}), at(2026, 11, 20, 19, 9), NY).length, 1)
})

test('only the chosen weekdays run (0 = Sunday); 2026-11-20 is a Friday', () => {
  assert.equal(due(entry({ days: [1, 2, 3] }), at(2026, 11, 20, 19, 1), NY).length, 0)
  assert.equal(due(entry({ days: [5] }), at(2026, 11, 20, 19, 1), NY).length, 1)
})

test('a window that crosses midnight stops on the next day', () => {
  const e = entry({ start: '22:00', stop: '01:30', days: [5] })           // Friday night into Saturday
  assert.equal(due(e, at(2026, 11, 20, 22, 1), NY)[0].action, 'start')
  assert.deepEqual(due(e, at(2026, 11, 21, 1, 31), NY).map(x => [x.action, x.key]), [['stop', '2026-11-20:stop']])
  assert.deepEqual(due(entry({ start: '22:00', stop: '01:30', days: [6] }), at(2026, 11, 21, 1, 31), NY), [])   // Saturday's own run has not started
})

test('a one-off schedule runs only on its date; a disabled one never runs', () => {
  const e = entry({ mode: 'once', date: '2026-11-20', days: [] })
  assert.equal(due(e, at(2026, 11, 20, 19, 1), NY).length, 1)
  assert.equal(due(e, at(2026, 11, 21, 19, 1), NY).length, 0)
  assert.equal(due(entry({ enabled: false }), at(2026, 11, 20, 19, 1), NY).length, 0)
})

test('a start with no stop time has no stop', () => {
  assert.deepEqual(due(entry({ stop: '' }), at(2026, 11, 20, 23, 0), NY), [])
})

test('the same wall-clock start holds after daylight saving begins', () => {
  const e = entry({ days: [1], start: '19:00', stop: '' })                 // Mondays 7 pm
  assert.equal(due(e, at(2026, 3, 9, 19, 1), NY).length, 1)                // the Monday after the clocks change
})

test('next run is the nearest unsent moment', () => {
  const e = entry({ days: [5], start: '19:00', stop: '' })
  const n = nextRun(e, at(2026, 11, 20, 20, 0), NY)                        // Friday 8 pm: this week's start is gone
  assert.equal(n.key, '2026-11-27:start')
  assert.equal(nextRun(entry({ enabled: false }), at(2026, 11, 20, 20, 0), NY), null)
})

test('input is checked', () => {
  const ok = { host: 'pc1', sid: 's1', streamName: 'Garden', start: '19:00', stop: '22:30', days: [1, 3], mode: 'weekly' }
  assert.equal(clean(ok, NY).label, 'Garden 19:00-22:30')
  assert.throws(() => clean({ ...ok, host: '' }, NY), /choose an encoder PC/)
  assert.throws(() => clean({ ...ok, start: '7pm' }, NY), /start time/)
  assert.throws(() => clean({ ...ok, stop: '19:00' }, NY), /differ/)
  assert.throws(() => clean({ ...ok, days: [] }, NY), /at least one day/)
  assert.throws(() => clean({ ...ok, mode: 'once' }, NY), /date/)
  assert.deepEqual(clean({ ...ok, days: [3, 1, 1, 9] }, NY).days, [1, 3])
})

test('the store keeps schedules, remembers what fired, and forgets it when the time is edited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
  const s = openSchedules(dir)
  const e = s.add(clean({ host: 'pc1', sid: 's1', streamName: 'Garden', start: '19:00', days: [5], mode: 'weekly' }, NY))
  s.markFired(e.id, '2026-11-20:start', Date.now())
  assert.ok(openSchedules(dir).get(e.id).fired['2026-11-20:start'])                       // survives a restart
  s.update(e.id, { ...clean({ host: 'pc1', sid: 's1', streamName: 'Garden', start: '19:00', days: [5], mode: 'weekly' }, NY), label: 'renamed' })
  assert.ok(s.get(e.id).fired['2026-11-20:start'])                                        // label only: kept
  s.update(e.id, clean({ host: 'pc1', sid: 's1', streamName: 'Garden', start: '20:00', days: [5], mode: 'weekly' }, NY))
  assert.deepEqual(s.get(e.id).fired, {})                                                 // moved: sent again
  assert.equal(s.remove(e.id), true); assert.equal(s.remove(e.id), false)
})
