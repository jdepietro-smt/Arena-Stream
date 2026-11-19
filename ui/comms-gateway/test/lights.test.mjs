// Runs against the compiled Electron main-process modules (npm test builds them first).
import test from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import net from 'node:net'
import http from 'node:http'
import { fireAction, unescapePayload, parseHostPort } from '../dist-electron/lights-core.js'

test('payload escapes become real bytes', () => {
  assert.deepEqual([...unescapePayload('ON\\r\\n')], [79, 78, 13, 10])
  assert.deepEqual([...unescapePayload('\\xFF\\x01')], [255, 1])
  assert.deepEqual([...unescapePayload('')], [])
})

test('host:port is parsed strictly', () => {
  assert.deepEqual(parseHostPort('192.168.1.50:5000'), { host: '192.168.1.50', port: 5000 })
  assert.equal(parseHostPort('nope'), null)
  assert.equal(parseHostPort('host:0'), null)
  assert.equal(parseHostPort('host:70000'), null)
})

test('an empty target does nothing and succeeds', async () => {
  assert.deepEqual(await fireAction({ kind: 'http', target: '', data: '' }), { ok: true })
})

test('UDP sends the payload', async () => {
  const srv = dgram.createSocket('udp4')
  await new Promise(r => srv.bind(0, '127.0.0.1', r))
  const got = new Promise(r => srv.once('message', m => r(m.toString('latin1'))))
  const r = await fireAction({ kind: 'udp', target: `127.0.0.1:${srv.address().port}`, data: 'RELAY1 ON\\r\\n' })
  assert.deepEqual(r, { ok: true })
  assert.equal(await got, 'RELAY1 ON\r\n')
  srv.close()
})

test('TCP connects, sends and closes; a closed port reports an error', async () => {
  let data = ''
  const srv = net.createServer(s => { s.on('data', d => { data += d.toString('latin1') }) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  assert.deepEqual(await fireAction({ kind: 'tcp', target: `127.0.0.1:${port}`, data: '\\xA0\\x01\\x01\\xA2' }), { ok: true })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(data, '\xA0\x01\x01\xA2')
  srv.close()
  const bad = await fireAction({ kind: 'tcp', target: `127.0.0.1:${port}`, data: 'x' })
  assert.equal(bad.ok, false)
})

test('HTTP: GET without a body, POST with one, and an error status is reported', async () => {
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', d => { b += d })
    req.on('end', () => { seen.push([req.method, req.url, b]); res.statusCode = req.url === '/bad' ? 500 : 200; res.end('ok') })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  assert.deepEqual(await fireAction({ kind: 'http', target: `${base}/relay/0?turn=on`, data: '' }), { ok: true })
  assert.deepEqual(await fireAction({ kind: 'http', target: `${base}/set`, data: '{"on":true}' }), { ok: true })
  assert.equal((await fireAction({ kind: 'http', target: `${base}/bad`, data: '' })).ok, false)
  assert.equal((await fireAction({ kind: 'http', target: 'ftp://x', data: '' })).ok, false)
  assert.deepEqual(seen[0], ['GET', '/relay/0?turn=on', ''])
  assert.deepEqual(seen[1], ['POST', '/set', '{"on":true}'])
  srv.close()
})
