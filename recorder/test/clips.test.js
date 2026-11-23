'use strict'
// Cutting clips, with the real ffmpeg when it is installed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createClips } = require('../lib/clips')
const S = require('../lib/segments')

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0
const probe = f => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', f], { encoding: 'utf8' }).stdout || '{}')

// 35 seconds of test picture and tone in 10 s pieces. (A real stream arrives in real time, so the recorder splits on the clock; this
// test source runs faster than real time, so it splits on stream time and the pieces are then given the names the recorder would.)
function makeRecording() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-rec-'))
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '35', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k',
    '-f', 'segment', '-segment_time', '10', '-segment_format', 'mpegts', '-reset_timestamps', '1', path.join(dir, 'p%03d.ts')])
  assert.equal(r.status, 0, String(r.stderr))
  const base = Date.UTC(2026, 10, 22, 15, 40, 0)
  fs.readdirSync(dir).filter(f => /^p\d+\.ts$/.test(f)).sort().forEach((f, i) => fs.renameSync(path.join(dir, f), path.join(dir, S.segName(base + i * 10000))))
  return dir
}

test('concat list lines are quoted safely', () => {
  const c = createClips({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'clips-')) })
  assert.equal(c.concatLine('C:\\rec\\a b\\x.ts'), "file 'C:/rec/a b/x.ts'")
  assert.equal(c.concatLine("/rec/it's/x.ts"), "file '/rec/it'\\''s/x.ts'")
})

test('limits, empty ranges and nothing-recorded are refused before ffmpeg is started', async () => {
  const c = createClips({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'clips-')), spawn: () => { throw new Error('should not run') } })
  const segs = [{ ms: 1000000, file: S.segName(1000000) }]
  await assert.rejects(c.create({ stream: 'a', segs, segDir: '/x', inMs: 5, outMs: 5 }), /end must be after/)
  await assert.rejects(c.create({ stream: 'a', segs, segDir: '/x', inMs: 0, outMs: 11 * 60000 }), /at most 10 minutes/)
  await assert.rejects(c.create({ stream: 'a', segs, segDir: '/x', inMs: 0, outMs: 121 * 60000, kind: 'saved' }), /at most 120 minutes/)
  await assert.rejects(c.create({ stream: 'a', segs, segDir: '/x', inMs: 0, outMs: 5000 }), /nothing was recorded/)
})

test('a clip is cut from the middle of a recording, plays in a browser format, and keeps picture and sound', { skip: !HAVE_FFMPEG && 'ffmpeg is not installed' }, async () => {
  const rec = makeRecording()
  const segs = S.listSegments(rec)
  assert.ok(segs.length >= 3, 'the recording should be in several pieces: ' + segs.length)
  const t0 = segs[0].ms
  const c = createClips({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'clips-')) })
  const e = await c.create({ stream: 'Test', segs, segDir: rec, inMs: t0 + 3000, outMs: t0 + 27000, name: 'goal', kind: 'saved' })
  assert.equal(e.kind, 'saved'); assert.ok(e.size > 5000)
  const info = probe(c.path(e))
  const types = (info.streams || []).map(s => s.codec_type).sort()
  assert.deepEqual(types, ['audio', 'video'])
  const dur = Number(info.format.duration)
  assert.ok(dur > 21 && dur < 27, 'duration was ' + dur)                              // 24 s asked for; the start snaps to a keyframe
  const check = spawnSync('ffmpeg', ['-v', 'error', '-i', c.path(e), '-f', 'null', '-'], { encoding: 'utf8' })
  assert.equal(check.status, 0); assert.equal(String(check.stderr).trim(), '')        // decodes cleanly end to end
  assert.equal(path.extname(c.path(e)), '.mp4')
})

test('a clip that starts and ends inside one piece, and the same preview twice', { skip: !HAVE_FFMPEG && 'ffmpeg is not installed' }, async () => {
  const rec = makeRecording()
  const segs = S.listSegments(rec)
  const t0 = segs[0].ms
  const c = createClips({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'clips-')) })
  const a = await c.create({ stream: 'T', segs, segDir: rec, inMs: t0 + 12000, outMs: t0 + 17000 })
  assert.equal(a.kind, 'preview')
  const d = Number(probe(c.path(a)).format.duration)
  assert.ok(d > 3.5 && d < 6.5, 'duration was ' + d)
  const b = await c.create({ stream: 'T', segs, segDir: rec, inMs: t0 + 12000, outMs: t0 + 17000 })
  assert.equal(b.id, a.id)                                                            // not cut again
  const kept = c.keep(a.id, 'penalty')
  assert.deepEqual([kept.kind, kept.name], ['saved', 'penalty'])
})

test('previews expire after an hour and saved clips after thirty days; stray files are cleared', async () => {
  if (!HAVE_FFMPEG) return
  const rec = makeRecording()
  const segs = S.listSegments(rec), t0 = segs[0].ms
  let t = 1_000_000
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'))
  const c = createClips({ dir, now: () => t })
  const p = await c.create({ stream: 'T', segs, segDir: rec, inMs: t0, outMs: t0 + 5000 })
  const s = await c.create({ stream: 'T', segs, segDir: rec, inMs: t0 + 10000, outMs: t0 + 15000, kind: 'saved', name: 'keep' })
  fs.writeFileSync(path.join(dir, 'orphan.mp4'), 'x')
  t += 2 * 3600 * 1000
  assert.equal(c.sweep(), 1)
  assert.equal(c.get(p.id), null); assert.ok(c.get(s.id))
  assert.ok(!fs.existsSync(path.join(dir, p.file))); assert.ok(!fs.existsSync(path.join(dir, 'orphan.mp4')))
  t += 31 * 86400 * 1000
  assert.equal(c.sweep(), 1)
  assert.deepEqual(c.list(), [])
  assert.equal(c.remove('nope'), false)
})
