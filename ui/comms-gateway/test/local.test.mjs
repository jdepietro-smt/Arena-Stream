// Runs against the compiled Electron main-process modules (npm test builds them first).
import test from 'node:test'
import assert from 'node:assert/strict'
import { primaryHttpBase, localServerEnv, validLocalCfg } from '../dist-electron/local-core.js'

test('the main server address becomes its http admin address', () => {
  assert.equal(primaryHttpBase('5.161.235.143'), 'https://5.161.235.143/comms')
  assert.equal(primaryHttpBase('wss://comms.example.com/comms'), 'https://comms.example.com/comms')
  assert.equal(primaryHttpBase('ws://10.0.0.5:8900/'), 'http://10.0.0.5:8900')
  assert.equal(primaryHttpBase('  '), '')
})

test('the local server is a LAN-wide standby of the main one', () => {
  const env = localServerEnv({ enabled: true, port: 8900, username: 'sync', password: 'pw', primary: '5.161.235.143' }, 'C:/x/directory.json')
  assert.equal(env.COMMS_STANDBY_URL, 'https://5.161.235.143/comms')
  assert.equal(env.COMMS_HOST, '0.0.0.0')
  assert.equal(env.COMMS_ICE, '[]')
  assert.equal(env.COMMS_DATA, 'C:/x/directory.json')
})

test('a local server configuration is checked before starting', () => {
  const ok = { enabled: true, port: 8900, username: 'sync', password: 'pw', primary: '5.161.235.143' }
  assert.equal(validLocalCfg(ok), '')
  assert.match(validLocalCfg({ ...ok, port: 80 }), /port/)
  assert.match(validLocalCfg({ ...ok, primary: '' }), /main server/)
  assert.match(validLocalCfg({ ...ok, password: '' }), /administrator/)
  assert.match(validLocalCfg(null), /Not set up/)
})
