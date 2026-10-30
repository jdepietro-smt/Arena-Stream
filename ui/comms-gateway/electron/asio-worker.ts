// ASIO helper process. Runs in a plain Node process (the installer ships one), NOT inside Electron: audify's prebuilt
// binary is linked to node.exe and cannot be loaded by Electron. The gateway's main process starts this with fork() and
// talks to it over IPC (see asio.ts):
//
//   main -> worker:  {id, type: 'list' | 'open' | 'close'}   (answered with {id, result})
//                    {type: 'tx', planar}                      (output block, channel-major)
//   worker -> main:  {type: 'rx', planar}                      (one device input buffer, channel-major)
//
// Audio moves through a single duplex ASIO stream: output is written from the input callback, so the interface clock
// drives everything.

import { SampleRing, deinterleave, interleaveFromRings } from './asio-core'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const audify: any = require('audify')
const RATE = 48000

interface AsioDevice { id: number; name: string; inputChannels: number; outputChannels: number; sampleRates: number[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Open { api: any; nOut: number; rings: SampleRing[] }
let current: Open | null = null

const reply = (id: number, result: unknown) => process.send?.({ id, result })

function list() {
  try {
    const devices = new audify.RtAudio(audify.RtAudioApi.WINDOWS_ASIO).getDevices().map((d: AsioDevice) => ({
      id: d.id, name: d.name, inputChannels: d.inputChannels, outputChannels: d.outputChannels, sampleRates: d.sampleRates,
    }))
    return { ok: true, devices }
  } catch (e) {
    return { ok: false, error: `ASIO is not available: ${(e as Error).message}` }
  }
}

function close() {
  const cur = current
  current = null
  if (!cur) return
  try { if (cur.api.isStreamRunning()) cur.api.stop() } catch { /* already stopped */ }
  try { if (cur.api.isStreamOpen()) cur.api.closeStream() } catch { /* already closed */ }
}

function open(cfg: { deviceId: number; inputs: number; outputs: number; frames?: number }) {
  close()
  try {
    const api = new audify.RtAudio(audify.RtAudioApi.WINDOWS_ASIO)
    const dev: AsioDevice | undefined = api.getDevices().find((d: AsioDevice) => d.id === cfg.deviceId)
    if (!dev) return { ok: false, error: 'That ASIO driver is not available. Is the interface plugged in and switched on?' }
    const nIn = Math.max(0, Math.min(cfg.inputs, dev.inputChannels))
    const nOut = Math.max(0, Math.min(cfg.outputs, dev.outputChannels))
    // Output is written from the input callback, so always open at least one of each.
    const openIn = Math.max(1, Math.min(nIn || 1, dev.inputChannels))
    const openOut = Math.max(1, Math.min(nOut || 1, dev.outputChannels))
    const frames = Math.max(64, Math.min(2048, cfg.frames ?? 256))
    const rings = Array.from({ length: openOut }, () => new SampleRing(8192))
    const high = frames * 6 // a channel this far ahead of the device is trimmed back to `target`
    const target = frames * 2

    api.openStream(
      { deviceId: dev.id, nChannels: openOut, firstChannel: 0 },
      { deviceId: dev.id, nChannels: openIn, firstChannel: 0 },
      audify.RtAudioFormat.RTAUDIO_FLOAT32, RATE, frames, 'Arena Comms Gateway',
      (pcm: Buffer) => {
        const f32 = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
        const fr = f32.length / openIn
        if (nIn > 0) process.send?.({ type: 'rx', planar: deinterleave(f32, fr, openIn, nIn) })
        const out = new Float32Array(fr * openOut)
        interleaveFromRings(rings, fr, out, high, target)
        api.write(Buffer.from(out.buffer))
      },
      null, 0,
      (type: number, msg: string) => console.warn(`[gateway] ASIO error ${type}: ${msg}`),
    )
    api.start()
    current = { api, nOut: nOut ? openOut : 0, rings }
    return {
      ok: true, driver: dev.name, inputChannels: dev.inputChannels, outputChannels: dev.outputChannels,
      openedIn: nIn, openedOut: nOut ? openOut : 0, frames, sampleRate: api.getStreamSampleRate?.() || RATE,
      latencyFrames: api.getStreamLatency?.() || 0,
    }
  } catch (e) {
    close()
    return { ok: false, error: (e as Error).message }
  }
}

process.on('message', (m: { id?: number; type: string; cfg?: never; planar?: Float32Array; first?: number }) => {
  if (m.type === 'tx') {
    // A block carries a group of channels starting at `first` (the window sends wide interfaces in groups of 32).
    const cur = current
    if (!cur || !cur.nOut || !(m.planar instanceof Float32Array)) return
    const first = m.first ?? 0
    const count = Math.min(cur.nOut - first, Math.round(m.planar.length / 128))
    const blk = Math.floor(m.planar.length / Math.max(1, count))
    for (let k = 0; k < count; k++) cur.rings[first + k].push(m.planar.subarray(k * blk, (k + 1) * blk))
    return
  }
  if (m.id == null) return
  if (m.type === 'list') reply(m.id, list())
  else if (m.type === 'open') reply(m.id, open(m.cfg as unknown as Parameters<typeof open>[0]))
  else if (m.type === 'close') { close(); reply(m.id, { ok: true }) }
})

// If the gateway goes away, release the interface.
process.on('disconnect', () => { close(); process.exit(0) })
