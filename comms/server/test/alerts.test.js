import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAlerter } from '../alerts.js'

test('alerts: nothing is sent until a URL is set; repeats are throttled; bad URLs rejected', async () => {
  const sent = []
  const a = createAlerter(null, async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true } })
  assert.equal(await a.notify('hello'), false)
  assert.equal(sent.length, 0)
  assert.throws(() => a.set('ftp://x'), /web address/)
  a.set('https://hooks.example.com/secret/path')
  assert.equal(a.host(), 'hooks.example.com')
  assert.equal(await a.notify('gateway A is offline', 'off:a', 60_000), true)
  assert.equal(await a.notify('gateway A is offline', 'off:a', 60_000), false)
  assert.equal(await a.notify('gateway B is offline', 'off:b', 60_000), true)
  assert.equal(sent.length, 2)
  assert.match(sent[0].body.text, /gateway A is offline/)
  a.set('')
  assert.equal(a.configured(), false)
})

test('alerts: a failing webhook is reported as not delivered, not thrown', async () => {
  const a = createAlerter(null, async () => { throw new Error('down') })
  a.set('https://hooks.example.com/x')
  assert.equal(await a.notify('x'), false)
})
