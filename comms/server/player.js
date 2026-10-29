// Server-side music player. Started and stopped from the admin's channel settings; nobody's computer or browser is involved.
//
// ffmpeg pulls a direct audio stream or file (internet radio, Icecast, an MP3/AAC/Ogg URL, ...), decodes it to 48 kHz stereo
// PCM, and this module publishes that into the SFU room as its own participant on the channel's `music:<channel>` track, the
// same track a person playing music would use. The comms server then routes it to listeners like any other sender.
//
// It plays only what the channel's saved stream URL points at (http/https). A music service's web page (YouTube, Spotify...)
// is not an audio stream and is never fetched here.

import { spawn } from 'node:child_process'

const RATE = 48000
const CHANNELS = 2
const SAMPLES = RATE / 100 // 10 ms per frame
const FRAME_BYTES = SAMPLES * CHANNELS * 2
const MAX_QUICK_FAILS = 5 // consecutive runs shorter than STABLE_MS before giving up
const STABLE_MS = 10_000
const RESTART_MS = 2_000

let rtcLib = null
const loadRtc = async () => (rtcLib ??= await import('@livekit/rtc-node'))

export function createPlayers({ livekit, onChange = () => {}, ffmpeg = process.env.COMMS_FFMPEG || 'ffmpeg', spawnFn = spawn, loadRtcFn = loadRtc, restartMs = RESTART_MS }) {
  /** @type {Map<string, any>} channel id -> player */
  const players = new Map()

  const view = p => ({ state: p.state, error: p.error, since: p.since })
  const set = (p, state, error = '') => {
    if (p.state === state && p.error === error) return
    p.state = state
    p.error = error
    p.since = Date.now()
    onChange(p.ch, view(p))
  }

  async function teardown(p) {
    p.stopped = true
    if (p.timer) clearTimeout(p.timer)
    try { p.proc?.kill('SIGKILL') } catch { /* already gone */ }
    p.proc = null
    const room = p.room
    p.room = null
    try { await p.source?.close?.() } catch { /* ignore */ }
    try { await room?.disconnect() } catch { /* ignore */ }
  }

  function fail(p, e) {
    const message = e?.code === 'ENOENT' ? 'ffmpeg is not installed on the server' : String(e?.message ?? e).slice(0, 300)
    console.warn(`[arena-comms] server player "${p.ch}": ${message}`)
    return teardown(p).then(() => { if (players.get(p.ch) === p) set(p, 'error', message) })
  }

  function run(p, lib) {
    if (p.stopped) return
    const startedAt = Date.now()
    const args = [
      '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-re', '-probesize', '262144', '-analyzeduration', '1500000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-user_agent', 'ArenaComms/1',
      '-i', p.url, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', String(CHANNELS), '-ar', String(RATE), 'pipe:1',
    ]
    let proc
    try { proc = spawnFn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return fail(p, e) }
    p.proc = proc
    let errTail = ''
    proc.stderr?.on('data', d => { errTail = (errTail + d).slice(-400) })
    let spawnFailed = false
    proc.on('error', e => { spawnFailed = true; fail(p, e) })

    void (async () => {
      let carry = Buffer.alloc(0)
      for await (const chunk of proc.stdout) {
        carry = carry.length ? Buffer.concat([carry, chunk]) : chunk
        while (carry.length >= FRAME_BYTES && !p.stopped) {
          const samples = new Int16Array(SAMPLES * CHANNELS)
          Buffer.from(samples.buffer).set(carry.subarray(0, FRAME_BYTES))
          carry = carry.subarray(FRAME_BYTES)
          await p.source.captureFrame(new lib.AudioFrame(samples, RATE, CHANNELS, SAMPLES))
          if (p.state !== 'playing') set(p, 'playing')
        }
      }
    })().catch(() => { /* the close handler reports it */ })

    proc.on('close', code => {
      if (p.stopped || spawnFailed || p.proc !== proc) return
      // A live stream that drops, or a file that finishes, starts again; a stream that keeps failing quickly gives up.
      p.fails = Date.now() - startedAt >= STABLE_MS ? 0 : p.fails + 1
      if (p.fails >= MAX_QUICK_FAILS) return fail(p, new Error(errTail.trim() || `the stream keeps stopping (ffmpeg exit ${code})`))
      set(p, 'starting')
      p.timer = setTimeout(() => run(p, lib), restartMs)
    })
  }

  async function stop(ch) {
    const p = players.get(ch)
    if (!p) return
    players.delete(ch)
    await teardown(p)
    onChange(ch, { state: 'idle', error: '', since: Date.now() })
  }

  async function start(ch, url) {
    await stop(ch)
    const p = { ch, url, state: 'starting', error: '', since: Date.now(), stopped: false, sid: '', room: null, source: null, proc: null, fails: 0, timer: null }
    players.set(ch, p)
    onChange(ch, view(p))
    try {
      const lib = await loadRtcFn()
      const { url: wsUrl, token } = await livekit.connectInfo(`player-${ch}`, 'Server player')
      const room = new lib.Room()
      await room.connect(wsUrl, token, { autoSubscribe: false, dynacast: false })
      if (p.stopped) { await room.disconnect().catch(() => {}); return }
      p.room = room
      p.source = new lib.AudioSource(RATE, CHANNELS)
      const track = lib.LocalAudioTrack.createAudioTrack(`music:${ch}`, p.source)
      const opts = new lib.TrackPublishOptions()
      opts.source = lib.TrackSource.SOURCE_UNKNOWN
      opts.dtx = false // music must not be gated like speech
      opts.red = false
      const pub = await room.localParticipant.publishTrack(track, opts)
      p.sid = pub.sid
      run(p, lib)
    } catch (e) {
      if (players.get(ch) === p) await fail(p, e)
    }
  }

  return {
    start,
    stop,
    stopAll: () => Promise.all([...players.keys()].map(stop)),
    status: ch => (players.has(ch) ? view(players.get(ch)) : { state: 'idle', error: '', since: 0 }),
    urlOf: ch => players.get(ch)?.url,
    channels: () => [...players.keys()],
    /** Players that are on air, with the published track to route to listeners. */
    playing: () => [...players.values()].filter(p => p.state === 'playing' && p.sid).map(p => ({ channel: p.ch, sid: p.sid })),
  }
}
