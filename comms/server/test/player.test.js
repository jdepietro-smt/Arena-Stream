import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createPlayers } from '../player.js'

const FRAME_BYTES = 480 * 2 * 2 // 10 ms of 48 kHz stereo 16-bit

function fakeRtc(log) {
  class Room {
    async connect(url, token, opts) { log.connect = { url, token, opts } }
    get localParticipant() { return { publishTrack: async (track, opts) => { log.track = track.name; log.opts = opts; return { sid: 'TR_fake' } } } }
    async disconnect() { log.disconnected = true }
  }
  class AudioSource { constructor(rate, channels) { log.rate = rate; log.channels = channels; log.frames = [] } async captureFrame(f) { log.frames.push(f) } async close() {} }
  class AudioFrame { constructor(data, rate, channels, samples) { Object.assign(this, { data, rate, channels, samples }) } }
  return { Room, AudioSource, AudioFrame, LocalAudioTrack: { createAudioTrack: (name, source) => ({ name, source }) }, TrackPublishOptions: class {}, TrackSource: { SOURCE_UNKNOWN: 0 } }
}

/** A fake ffmpeg: a process whose stdout the test feeds, and which the test can end. */
function fakeSpawner() {
  const runs = []
  const spawnFn = (cmd, args) => {
    const proc = new EventEmitter()
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough()
    proc.killed = false
    proc.kill = () => { proc.killed = true; proc.stdout.end() }
    runs.push({ cmd, args, proc })
    return proc
  }
  return { runs, spawnFn }
}

const until = async (fn, what) => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } assert.fail('timed out: ' + what) }
const mk = (extra = {}) => {
  const log = {}; const sp = fakeSpawner(); const events = []
  const players = createPlayers({
    livekit: { connectInfo: async (id, name) => ({ url: 'ws://lk', token: `tok-${id}-${name}` }) },
    onChange: (ch, st) => events.push([ch, st.state]), spawnFn: sp.spawnFn, loadRtcFn: async () => fakeRtc(log), restartMs: 10, ...extra,
  })
  return { players, log, sp, events }
}

test('start publishes the channel music track and feeds decoded 10 ms frames; stop cleans up', async () => {
  const { players, log, sp, events } = mk()
  await players.start('program', 'https://radio.example.com/live.mp3')
  assert.equal(log.track, 'music:program')
  assert.deepEqual([log.connect.url, log.connect.opts.autoSubscribe, log.opts.dtx], ['ws://lk', false, false])
  assert.equal(log.connect.token, 'tok-player-program-Server player')
  assert.deepEqual(players.status('program').state, 'starting')
  const { args, cmd } = sp.runs[0]
  assert.equal(cmd, 'ffmpeg')
  assert.ok(args.includes('-re') && args.includes('https://radio.example.com/live.mp3'), 'reads the saved URL in real time')
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,https,tcp,tls,crypto', 'only network protocols, never local files')
  sp.runs[0].proc.stdout.write(Buffer.alloc(FRAME_BYTES * 3 + 100))
  await until(() => players.status('program').state === 'playing', 'playing after the first frame')
  await until(() => log.frames.length === 3, 'three whole frames')
  assert.deepEqual([log.frames[0].rate, log.frames[0].channels, log.frames[0].samples, log.frames[0].data.length], [48000, 2, 480, 960])
  assert.deepEqual(players.playing(), [{ channel: 'program', sid: 'TR_fake' }])
  assert.deepEqual(events.map(e => e[1]), ['starting', 'playing'])
  await players.stop('program')
  assert.equal(sp.runs[0].proc.killed, true)
  assert.equal(log.disconnected, true)
  assert.deepEqual([players.status('program').state, players.playing()], ['idle', []])
})

test('a missing ffmpeg is reported plainly', async () => {
  const { players, sp } = mk()
  await players.start('program', 'https://radio.example.com/live.mp3')
  sp.runs[0].proc.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }))
  await until(() => players.status('program').state === 'error', 'error state')
  assert.equal(players.status('program').error, 'ffmpeg is not installed on the server')
})

test('a stream that drops restarts; one that keeps failing quickly gives up with a message', async () => {
  const { players, sp } = mk()
  await players.start('program', 'https://radio.example.com/live.mp3')
  sp.runs[0].proc.stderr.write('Connection refused')
  sp.runs[0].proc.emit('close', 1)
  await until(() => sp.runs.length === 2, 'restarted after the first drop')
  for (let i = 1; i < 5; i++) {
    sp.runs[i].proc.stderr.write('Connection refused')
    sp.runs[i].proc.emit('close', 1)
    if (i < 4) await until(() => sp.runs.length === i + 2, 'restart ' + (i + 1))
  }
  await until(() => players.status('program').state === 'error', 'gives up after repeated quick failures')
  assert.match(players.status('program').error, /Connection refused/)
})

test('connection failures surface as an error, and starting again replaces the old player', async () => {
  const sp = fakeSpawner(); const log = {}
  const bad = createPlayers({ livekit: { connectInfo: async () => { throw new Error('LiveKit unreachable') } }, spawnFn: sp.spawnFn, loadRtcFn: async () => fakeRtc(log) })
  await bad.start('program', 'https://radio.example.com/live.mp3')
  assert.deepEqual([bad.status('program').state, bad.status('program').error], ['error', 'LiveKit unreachable'])
  const { players, sp: sp2 } = mk()
  await players.start('program', 'https://a.example.com/1.mp3')
  await players.start('program', 'https://b.example.com/2.mp3')
  assert.equal(sp2.runs.length, 2)
  assert.equal(sp2.runs[0].proc.killed, true, 'the first run was stopped')
  assert.equal(players.urlOf('program'), 'https://b.example.com/2.mp3')
  await players.stopAll()
})
