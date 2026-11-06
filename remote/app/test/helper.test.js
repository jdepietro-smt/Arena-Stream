// Exercises the service helper in --dev mode (unelevated, current desktop): pipe protocol, desktop reporting,
// frame capture and input injection. Skipped when the helper has not been built (dotnet build in remote/service).
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const exe = path.join(__dirname, '..', '..', 'service', 'bin', 'Debug', 'net9.0-windows', 'ArenaRemoteService.exe')
const pipe = `arena-remote-test-${process.pid}`

test('helper pipe: desktop, frames, input', { skip: !fs.existsSync(exe) && 'helper not built' }, async () => {
  process.env.ARENA_HELPER_PIPE = ['', '', '.', 'pipe', pipe].join(String.fromCharCode(92))
  const { SecureHelper } = require('../secure')
  const input = require('../input')
  const proc = spawn(exe, ['helper', '--dev', '--pipe', pipe], { stdio: 'ignore' })
  let h
  try {
    h = new SecureHelper()
    let ok = false
    for (let i = 0; i < 30 && !ok; i++) { ok = await h.connect(); if (!ok) await new Promise(r => setTimeout(r, 200)) }
    assert.ok(ok, 'connected')
    const once = ev => new Promise((r, j) => { const t = setTimeout(() => j(new Error('timeout waiting for ' + ev)), 5000); h.once(ev, v => { clearTimeout(t); r(v) }) })

    const desktop = once('desktop')
    h.send({ t: 'hello', x: 0, y: 0, w: 1920, h: 1080 })
    assert.equal(await desktop, 'Default')

    const frame = once('frame')
    h.send({ t: 'frames', on: true })
    const jpg = await frame
    assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic')
    assert.ok(jpg.length > 2000)
    h.send({ t: 'frames', on: false })

    const before = input.cursor()
    h.send({ t: 'in', k: 'mm', x: 0.25, y: 0.25 }) // ignored: control not granted
    await new Promise(r => setTimeout(r, 200))
    assert.deepEqual(input.cursor(), before, 'input ignored without control')
    h.send({ t: 'control', on: true })
    h.send({ t: 'in', k: 'mm', x: 0.25, y: 0.25 })
    await new Promise(r => setTimeout(r, 300))
    const [x, y] = input.cursor()
    assert.ok(Math.abs(x - 479) <= 2 && Math.abs(y - 269) <= 2, `cursor moved to ${x},${y}`)
    h.send({ t: 'control', on: false })
    h.close()
    input.inject({ k: 'mm', x: before[0] / 1919, y: before[1] / 1079 }, { x: 0, y: 0, width: 1920, height: 1080 })
  } finally { h?.close(); proc.kill() }
})
