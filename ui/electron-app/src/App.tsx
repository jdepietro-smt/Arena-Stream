import { useEffect, useRef, useState, useCallback } from 'react'
import './App.css'

// ─── Types ───────────────────────────────────────────────────────────────────
interface Device {
  id:   string
  name: string
  type: 'decklink' | 'aja' | 'webcam' | 'ndi'
}

interface StreamOpts {
  codec:            string
  bitrateKbps:      number
  latencyMs:        number
  destIp:           string
  destPort:         number
  protocol:         'srt' | 'udp' | 'rtp' | 'ndi'
  relayUrl:         string
  streamName:       string
  srtPassphrase:    string    // must match the receiving server's srtPublishPassphrase
  abrEnabled?:      boolean   // adaptive bitrate — bitrateKbps becomes a ceiling
  audioCodec:       string
  audioBitrateKbps: number
  audioEnabled:     boolean
  width?:           number
  height?:          number
  fps?:             number
  ndiName:          string    // NDI source name visible to other devices on the LAN
}

const sdi = (window as any).sdi

type FrameData = { w: number; h: number; data: Uint8Array }

// One WebGL canvas + render loop per device, reading from a frames map shared
// across all tiles (framesRef). Extracted from what used to be a single
// canvas driven by a single "latest frame" ref — multi-channel capture needs
// one of these per active channel so all of them can be visible at once
// instead of only whichever one was most recently selected.
function VideoTile({
  deviceId, framesRef, label, isLive, onClick, isSelected,
}: {
  deviceId:  string
  framesRef: React.MutableRefObject<Record<string, FrameData>>
  label?:    string
  isLive?:   boolean
  onClick?:  () => void
  isSelected?: boolean
}) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const glStateRef = useRef<{
    gl: WebGLRenderingContext
    yTex: WebGLTexture; uTex: WebGLTexture; vTex: WebGLTexture
    w: number; h: number
  } | null>(null)
  const rafRef = useRef(0)

  useEffect(() => {
    let glState: typeof glStateRef.current = null

    const initGl = (canvas: HTMLCanvasElement, w: number, h: number) => {
      canvas.width = w; canvas.height = h
      const gl = canvas.getContext('webgl', { alpha: false, antialias: false, desynchronized: false })
      if (!gl) return null

      const mkShader = (type: number, src: string) => {
        const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s
      }
      const vert = mkShader(gl.VERTEX_SHADER, `
        attribute vec2 aPos; attribute vec2 aTex; varying vec2 vTex;
        void main() { gl_Position = vec4(aPos,0.0,1.0); vTex = aTex; }
      `)
      const frag = mkShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform sampler2D uY, uCb, uCr; uniform vec2 uTexel; varying vec2 vTex;
        void main() {
          /* Source is native-resolution SDI (720p/1080), but the preview
             canvas is almost always displayed larger than that (it fills
             the app's main panel) — plain bilinear upscaling alone reads
             visibly soft next to the actual broadcast output (confirmed:
             a frame pulled directly from the live relay was pin-sharp,
             while the app's own preview of the same moment looked notably
             blurred). A small unsharp mask on luma only — chroma is already
             subsampled and doesn't carry edge detail — recovers perceived
             sharpness without amplifying color noise. */
          float yC = texture2D(uY, vTex).r;
          float yN = texture2D(uY, vTex + vec2(0.0,  uTexel.y)).r;
          float yS = texture2D(uY, vTex - vec2(0.0,  uTexel.y)).r;
          float yE = texture2D(uY, vTex + vec2(uTexel.x, 0.0)).r;
          float yW = texture2D(uY, vTex - vec2(uTexel.x, 0.0)).r;
          float y  = clamp(yC + 0.6 * (yC * 4.0 - yN - yS - yE - yW), 0.0, 1.0) - 0.0627;
          /* BT.709 limited-range — correct for all HD SDI (1080i/p, 720p). */
          float cb = texture2D(uCb, vTex).r - 0.5;
          float cr = texture2D(uCr, vTex).r - 0.5;
          gl_FragColor = vec4(
            clamp(1.164*y + 1.793*cr,              0.0, 1.0),
            clamp(1.164*y - 0.213*cb - 0.533*cr,   0.0, 1.0),
            clamp(1.164*y + 2.112*cb,               0.0, 1.0),
            1.0);
        }
      `)
      const prog = gl.createProgram()!
      gl.attachShader(prog, vert); gl.attachShader(prog, frag); gl.linkProgram(prog); gl.useProgram(prog)
      gl.uniform2f(gl.getUniformLocation(prog, 'uTexel'), 1.0 / w, 1.0 / h)

      const vbuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,1, 1,-1,1,1, -1,1,0,0, 1,1,1,0]), gl.STATIC_DRAW)
      const aPos = gl.getAttribLocation(prog, 'aPos'); const aTex = gl.getAttribLocation(prog, 'aTex')
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(aTex); gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8)

      const mkTex = (unit: number, name: string) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.uniform1i(gl.getUniformLocation(prog, name), unit); return t
      }
      return { gl, yTex: mkTex(0,'uY'), uTex: mkTex(1,'uCb'), vTex: mkTex(2,'uCr'), w, h }
    }

    let diagCount = 0
    const render = () => {
      rafRef.current = requestAnimationFrame(render)
      const frame = framesRef.current[deviceId]
      if (!frame) return
      if (++diagCount % 120 === 1) {
        console.log('[diag] tile', deviceId, 'drawing frame', frame.w, 'x', frame.h,
          'keys in framesRef:', Object.keys(framesRef.current))
      }
      const canvas = canvasRef.current
      if (!canvas) return

      if (!glState || glState.w !== frame.w || glState.h !== frame.h) {
        glState = initGl(canvas, frame.w, frame.h)
        glStateRef.current = glState
      }
      if (!glState) return

      const { gl, yTex, uTex, vTex } = glState
      const { w, h, data } = frame
      const ySz = w * h, uvSz = (w >> 1) * (h >> 1)

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, yTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data.subarray(0, ySz))
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, uTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w>>1, h>>1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data.subarray(ySz, ySz+uvSz))
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, vTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w>>1, h>>1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data.subarray(ySz+uvSz))

      gl.viewport(0, 0, w, h)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    rafRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafRef.current)
  }, [deviceId, framesRef])

  return (
    <div className={`video-tile ${isSelected ? 'selected' : ''}`} onClick={onClick}>
      <canvas ref={canvasRef} className="preview-canvas" />
      {label && (
        <div className="preview-overlay">
          <span className="preview-name">{label}</span>
          {isLive && <span className="live-dot" />}
        </div>
      )}
    </div>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Encoder state ───────────────────────────────────────────────────────────
  const [devices,        setDevices]        = useState<Device[]>([])
  const [selected,       setSelected]       = useState<Device | null>(null)
  const [activeIds,      setActiveIds]      = useState<Set<string>>(new Set())
  // Which channels are independently live (publishing out), keyed by device
  // id — previously a single global boolean, which meant only one channel
  // could ever be streaming: starting a second always killed the first.
  const [liveIds,        setLiveIds]        = useState<Set<string>>(new Set())
  const [togglingIds,    setTogglingIds]    = useState<Set<string>>(new Set())
  const [viewerUrls,     setViewerUrls]      = useState<Record<string, string>>({})
  const [logs,           setLogs]           = useState<string[]>([])
  const [urlCopied,      setUrlCopied]      = useState(false)
  // list-codecs output: every concrete encoder, plus "gpu" and "cpu" entries
  // that say what each would resolve to on this machine.
  const [availableCodecs, setAvailableCodecs] = useState<{
    name: string; label: string; available: boolean
    resolves_to?: string; resolves_label?: string
  }[]>([])
  // The encoder each channel's arena_stream process actually opened — can
  // differ from what was asked for if the first choice failed to open.
  const [encoderUsed, setEncoderUsed] = useState<Record<string, string>>({})
  // GPU vs CPU is the only choice the user makes. It's sent to arena_stream
  // as-is ("gpu" / "cpu") and arena_stream picks the actual encoder (NVENC,
  // QSV, AMF, Media Foundation, or libx264) — the UI never names one.
  const [hwMode, setHwMode] = useState<'gpu' | 'cpu'>(
    (localStorage.getItem('arenaStream.hwMode') as 'gpu' | 'cpu') || 'gpu')
  const [opts, setOpts] = useState<StreamOpts>({
    codec: hwMode, bitrateKbps: 15000, latencyMs: 20,
    destIp: '', destPort: 4200, protocol: 'srt', relayUrl: '5.78.236.254:8890', streamName: '',
    srtPassphrase: localStorage.getItem('arenaStream.srtPassphrase') || '',
    audioCodec: 'aac', audioBitrateKbps: 192, audioEnabled: true,
    ndiName: 'Arena Stream',
  })
  const [rttInfo, setRttInfo] = useState<{rttMs?: number; recommendedMs?: number; error?: string} | null>(null)
  const [measuringRtt, setMeasuringRtt] = useState(false)
  const [formats, setFormats] = useState<Array<{width:number,height:number,fps:number}>>([])
  const [selFormat, setSelFormat] = useState('')

  const [previewSrc,     setPreviewSrc]     = useState('')   // fallback MJPEG (unused now)
  // Keyed by device.id so each source's own format/audio badge persists
  // independently — previously these were single shared values that got
  // overwritten by whichever channel's stats arrived most recently, making
  // a channel's badges disappear/show stale data as soon as you selected a
  // different channel and came back.
  const [captureFormats, setCaptureFormats] = useState<Record<string, string>>({})
  const [audioCaptures,  setAudioCaptures]  = useState<Record<string, number | null>>({})

  // Custom per-device display names (e.g. "Corvid44 #0 SDI 1" -> "Main Camera"),
  // set via right-click rename on the source card. Persisted to localStorage
  // so they survive app restarts without needing a backend settings store.
  const [customNames, setCustomNames] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('arenaStream.customDeviceNames') || '{}') }
    catch { return {} }
  })
  // Renaming a channel that's already live doesn't touch its running
  // process — the publish name it's actually using out on the wire stays
  // whatever it was when Go Live was clicked. Left alone, clicking Go Live
  // again to "apply" the new name just starts a SECOND process alongside
  // the still-running old one (same physical SDI input published twice at
  // once, under two different names) rather than replacing it. Restarting
  // under the new name here closes that gap at the source — shared by both
  // the sidebar rename and the STREAM NAME field below the preview.
  async function applyLiveRename(id: string, trimmed: string) {
    if (!trimmed || !liveIds.has(id)) return
    const dev = devices.find(d => d.id === id)
    if (!dev) return
    await sdi.stopStream(id)
    const res = await sdi.startStream(dev, { ...opts, streamName: trimmed })
    if (!res.ok) setLiveIds(prev => { const s = new Set(prev); s.delete(id); return s })
  }
  async function renameDevice(id: string, name: string) {
    setCustomNames(prev => {
      const next = { ...prev }
      if (name.trim()) next[id] = name.trim()
      else delete next[id]   // empty name clears the override, reverting to the raw device name
      localStorage.setItem('arenaStream.customDeviceNames', JSON.stringify(next))
      return next
    })
    // Renaming the source you're currently viewing also updates the stream
    // name field — otherwise the rename is purely cosmetic in the sidebar and
    // the dashboard still shows the generic auto-generated name (e.g. "sdi-0")
    // until the stream name field is separately typed in below the preview.
    const trimmed = name.trim()
    if (id === selected?.id && trimmed) {
      setOpts(o => ({ ...o, streamName: trimmed }))
    }
    await applyLiveRename(id, trimmed)
  }
  // Electron's renderer doesn't implement window.prompt() (only alert/confirm
  // have native support), so renaming uses an inline text input instead of a
  // prompt() dialog. renamingId tracks which source card is mid-rename.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const logRef    = useRef<HTMLDivElement>(null)
  // Latest frame per device id — each active channel gets its own VideoTile
  // (defined above) reading from this shared map, instead of a single ref
  // for whichever one channel used to be "the" preview.
  const framesRef = useRef<Record<string, FrameData>>({})
  const capturingRef = useRef(false)

  // ── IPC listeners ──────────────────────────────────────────────────────────
  useEffect(() => {
    sdi.onLog((line: string) => {
      setLogs(prev => [...prev.slice(-200), line])
    })
    sdi.onStreamUrl((d: {id: string, url: string}) => {
      if (!d?.id) return
      setViewerUrls(prev => ({ ...prev, [d.id]: d.url }))
    })
    sdi.onStreamStopped((d: {id?: string}) => {
      if (!d?.id) return
      setLiveIds(prev => { const s = new Set(prev); s.delete(d.id!); return s })
      setViewerUrls(prev => { const next = { ...prev }; delete next[d.id!]; return next })
    })

    // Raw YUV420P preview — IPC just stores the latest frame per device id.
    // Each VideoTile's own requestAnimationFrame loop renders it, synced to
    // display VBlank = no tearing.
    sdi.onPreviewYuv((id: string, w: number, h: number, yuv: Buffer) => {
      framesRef.current[id] = { w, h, data: new Uint8Array(yuv.buffer ?? yuv) }
    })

    sdi.onCaptureFormat((d: {id: string, format: string}) => {
      if (!d?.id) return
      setCaptureFormats(prev => ({ ...prev, [d.id]: d.format }))
    })
    sdi.onAudioStats((d: {id: string, captured: number}) => {
      if (!d?.id) return
      setAudioCaptures(prev => ({ ...prev, [d.id]: d.captured }))
    })
    // Arrives with every stats line, so only update state when it changes.
    sdi.onEncoderUsed((d: {id: string, encoder: string}) => {
      if (!d?.id) return
      setEncoderUsed(prev => prev[d.id] === d.encoder ? prev : { ...prev, [d.id]: d.encoder })
    })
    // Without this, a channel whose capture process dies (crashed encoder,
    // killed externally, etc.) stays in activeIds forever — clicking it
    // again then takes the "already active, just switch preview" branch in
    // selectDevice() and re-attaches to a process that no longer exists,
    // instead of actually restarting it. Confirmed live: a channel that
    // crashed on an interlaced source with the CPU encoder stayed stuck
    // showing black no matter how many times it was re-clicked, until the
    // whole app was relaunched.
    sdi.onCaptureStopped((d: {id?: string, code?: number|null}) => {
      if (!d?.id) return
      setActiveIds(prev => { const s = new Set(prev); s.delete(d.id!); return s })
      setCaptureFormats(prev => { const next = { ...prev }; delete next[d.id!]; return next })
      setAudioCaptures(prev => { const next = { ...prev }; delete next[d.id!]; return next })
      setEncoderUsed(prev => { const next = { ...prev }; delete next[d.id!]; return next })
    })
    return () => {
      ['log','stream-url','stream-stopped','preview-frame','preview-yuv','capture-format',
       'audio-stats','encoder-used','capture-stopped'].forEach(c =>
        sdi.removeAllListeners(c))
    }
  }, [])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])


  // ── Actions ────────────────────────────────────────────────────────────────
  const scan = useCallback(async () => {
    const devs = await sdi.scanDevices()
    setDevices(devs)
    if (devs.length > 0 && !selected) selectDevice(devs[0])
  }, [selected])

  useEffect(() => {
    scan()
    // Probe available codecs from arena_stream.exe --list-codecs.
    ;(window as any).sdi.listCodecs().then((codecs: {name:string;label:string;available:boolean}[]) => {
      setAvailableCodecs(codecs)
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function setHwModePersist(mode: 'gpu' | 'cpu') {
    setHwMode(mode)
    setOpts(o => ({ ...o, codec: mode }))
    localStorage.setItem('arenaStream.hwMode', mode)
  }

  // What to show under the ENCODER selector: the encoder the selected channel
  // actually opened if it's running, otherwise what the request would resolve
  // to on this machine (GPU falls back to the CPU encoder when no hardware
  // encoder opened, which is what arena_stream will do).
  function encoderLabel(): string {
    const label = (name: string) => availableCodecs.find(c => c.name === name)?.label || name
    const used = selected ? encoderUsed[selected.id] : undefined
    if (used) return label(used)
    const entry = availableCodecs.find(c => c.name === hwMode)
    if (entry?.resolves_label) return entry.resolves_label
    return availableCodecs.find(c => c.name === 'cpu')?.resolves_label || ''
  }

  async function selectDevice(dev: Device) {
    // Previously gated on the single global `streaming` flag, which froze
    // the entire sidebar while ANY channel was live — you couldn't even
    // select a different channel, let alone start it, without stopping the
    // one already running. Liveness is now per-channel, so only an
    // in-flight start/stop on THIS click needs guarding against.
    if (capturingRef.current) return

    const wasActive   = activeIds.has(dev.id)
    const wasSelected = selected?.id === dev.id

    // Clicking the channel you're currently viewing stops it.
    if (wasActive && wasSelected) {
      capturingRef.current = true
      try {
        await sdi.stopCapture(dev.id)
        setActiveIds(prev => { const s = new Set(prev); s.delete(dev.id); return s })
        setSelected(null)
      } finally {
        capturingRef.current = false
      }
      return
    }

    // Clicking a DIFFERENT channel that's already running in the background —
    // just switch the preview to it. No restart, so its capture never drops
    // a frame and other viewers of it (e.g. if it's also live) see no glitch.
    if (wasActive && !wasSelected) {
      setSelected(dev)
      setOpts(o => ({ ...o, streamName: customNames[dev.id] || dev.name }))
      await sdi.selectPreview(dev.id)
      return
    }

    // Not active yet — start it fresh (it becomes the preview automatically).
    capturingRef.current = true
    setSelected(dev)
    const baseOpts = { ...opts, streamName: customNames[dev.id] || dev.name }
    try {
      const fmts = await sdi.queryFormats(dev.name)
      setFormats(fmts)
      if (fmts.length > 0) {
        const best = fmts[0]
        setSelFormat(`${best.width}x${best.height}@${best.fps}`)
        const newOpts = { ...baseOpts, width: best.width, height: best.height, fps: best.fps }
        setOpts(newOpts)
        await sdi.startCapture(dev, newOpts)
      } else {
        setOpts(baseOpts)
        await sdi.startCapture(dev, baseOpts)
      }
      setActiveIds(prev => new Set([...prev, dev.id]))
    } finally {
      capturingRef.current = false
    }
  }

  function applyFormat(key: string) {
    setSelFormat(key)
    const fmt = formats.find(f => `${f.width}x${f.height}@${f.fps}` === key)
    if (fmt) setOpts(o => ({...o, width: fmt.width, height: fmt.height, fps: fmt.fps}))
  }

  async function toggleStream() {
    if (!selected) return
    const id = selected.id
    // The backend now serializes concurrent start/stop calls for the same
    // device, but blocking re-clicks here too avoids the confusing UX that
    // triggered it in the first place: renaming doesn't restart an
    // already-live stream, so clicking Go Live again looked like a no-op and
    // invited a second, overlapping click before the first had resolved.
    if (togglingIds.has(id)) return
    setTogglingIds(prev => new Set([...prev, id]))
    try {
      if (liveIds.has(id)) {
        await sdi.stopStream(id)
        setLiveIds(prev => { const s = new Set(prev); s.delete(id); return s })
        setViewerUrls(prev => { const next = { ...prev }; delete next[id]; return next })
      } else {
        const res = await sdi.startStream(selected, opts)
        if (res.ok) {
          setLiveIds(prev => new Set([...prev, id]))
        } else {
          // Previously silent on failure — the button just reset back to
          // "GO LIVE" with zero indication of why, which read as the click
          // doing nothing at all. Surface whatever main.ts's handler
          // returned so a bad config (missing exe, missing dest IP, etc.)
          // is visible instead of a no-op.
          setLogs(prev => [...prev.slice(-200), `[error] Go Live failed: ${res.error || 'unknown error'}`])
        }
      }
    } catch (e) {
      // A thrown/rejected IPC call (e.g. main.ts's handler throwing) hit the
      // same silent-failure gap — caught here now instead of propagating as
      // an unhandled rejection with no user-visible trace.
      setLogs(prev => [...prev.slice(-200), `[error] Go Live failed: ${e instanceof Error ? e.message : String(e)}`])
    } finally {
      setTogglingIds(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }

  async function autoLatency() {
    const ip = opts.destIp?.trim() || getLocalIp()
    setMeasuringRtt(true)
    setRttInfo(null)
    try {
      const result = await sdi.measureRtt(ip || '127.0.0.1')
      setRttInfo(result)
      if (result.recommendedMs) setOpts(o => ({ ...o, latencyMs: result.recommendedMs }))
    } finally {
      setMeasuringRtt(false)
    }
  }

  // rough client-side local IP placeholder — actual IP resolved server-side
  function getLocalIp() { return '' }

  function copyUrl() {
    if (!selected) return
    const url = viewerUrls[selected.id]
    if (!url) return
    navigator.clipboard.writeText(url)
    setUrlCopied(true)
    setTimeout(() => setUrlCopied(false), 2000)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* ── Title bar region ─────────────────────────── */}
      <div className="titlebar">
        <div className="titlebar-left">
          <img className="app-logo" src="/logo.png" alt="" />
          <span className="app-name">ARENA ENCODER</span>
          <span className={`live-badge ${liveIds.size > 0 ? 'live' : ''}`}>
            {liveIds.size > 0 ? `● LIVE (${liveIds.size})` : '○ OFFLINE'}
          </span>
        </div>
        <div className="titlebar-right">
          {selected && viewerUrls[selected.id] && (
            <button className="url-pill" onClick={copyUrl}>
              {urlCopied ? '✓ Copied' : viewerUrls[selected.id]}
            </button>
          )}
        </div>
      </div>

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-header">
            <span>SOURCES</span>
            <button className="icon-btn" onClick={scan} title="Scan">⟳</button>
          </div>

          <div className="source-list">
            {devices.length === 0 && (
              <div className="no-devices">No devices found.<br/>Click ⟳ to scan.</div>
            )}
            {devices.map(dev => {
              const isActive   = activeIds.has(dev.id)
              const isSelected = selected?.id === dev.id
              const isLive     = liveIds.has(dev.id)
              const dotState   = isActive && isLive ? 'live' : isActive ? 'preview' : ''
              return (
                <button
                  key={dev.id}
                  className={`source-card ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''} ${dev.type}`}
                  onClick={() => selectDevice(dev)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setRenamingId(dev.id)
                    setRenameDraft(customNames[dev.id] || dev.name)
                  }}
                  title={isActive ? 'Click to stop this channel' : 'Click to start this channel — right-click to rename'}
                >
                  <span className={`dot ${dotState}`} />
                  <div className="source-info">
                    {renamingId === dev.id ? (
                      <input
                        autoFocus
                        className="source-name-input"
                        value={renameDraft}
                        onChange={e => setRenameDraft(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onMouseDown={e => e.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { renameDevice(dev.id, renameDraft); setRenamingId(null) }
                          else if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => { renameDevice(dev.id, renameDraft); setRenamingId(null) }}
                      />
                    ) : (
                      <div className="source-name">{customNames[dev.id] || dev.name}</div>
                    )}
                    <div className="source-type">
                      <span className={`type-badge type-badge--${dev.type}`}>
                        {dev.type.toUpperCase()}
                      </span>
                      {isActive && captureFormats[dev.id] && (
                        <span className="source-format">{captureFormats[dev.id]}</span>
                      )}
                      {isActive && (
                        <span className={`audio-badge${audioCaptures[dev.id] == null ? '' : audioCaptures[dev.id]! > 0 ? ' audio-badge--active' : ' audio-badge--silent'}`}>
                          {audioCaptures[dev.id] == null ? '◎ AUD' : audioCaptures[dev.id]! > 0 ? `● AUD ${audioCaptures[dev.id]}f` : '○ AUD –'}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        {/* ── Main area ────────────────────────────── */}
        <main className="main">
          {/* Preview — WebGL canvas(es) render raw YUV420P, zero compression
              artifacts. One tile per active channel, all running concurrently. */}
          <div className={`preview-wrap ${liveIds.size > 0 ? 'live' : ''}`}>
            {activeIds.size === 0 && (
              <div className="preview-placeholder">
                <div className="placeholder-icon">▶</div>
                <div>Select a source to preview</div>
              </div>
            )}
            {activeIds.size > 0 && (
              <div className={`video-grid video-grid--${Math.min(activeIds.size, 4)}`}>
                {Array.from(activeIds).map(id => {
                  const dev = devices.find(d => d.id === id)
                  console.log('[diag] rendering tile for', id, '-> matched device:', dev?.id, dev?.name)
                  if (!dev) return null
                  return (
                    <VideoTile
                      key={id}
                      deviceId={id}
                      framesRef={framesRef}
                      label={customNames[id] || dev.name}
                      isLive={liveIds.has(id)}
                      isSelected={selected?.id === id}
                      onClick={() => selectDevice(dev)}
                    />
                  )
                })}
              </div>
            )}
          </div>

          <div className="controls">
            <div className="config-row">
              {opts.protocol !== 'ndi' && <>
                <label>RELAY
                  <span className="relay-preset">West</span>
                </label>
                <label>STREAM NAME
                  <input
                    type="text" placeholder="auto"
                    value={opts.streamName}
                    onChange={e => setOpts(o => ({...o, streamName: e.target.value}))}
                    onBlur={e => { if (selected) renameDevice(selected.id, e.target.value.trim()) }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    style={{width: 100}}
                  />
                </label>
                <label>DEST IP
                  <input
                    type="text" placeholder="blank = listener"
                    value={opts.destIp}
                    onChange={e => { setOpts(o => ({...o, destIp: e.target.value})); setRttInfo(null) }}
                    style={{width: 120}}
                  />
                </label>
                <label>DEST PORT
                  <input type="number" value={opts.destPort}
                    onChange={e => setOpts(o => ({...o, destPort: +e.target.value}))} />
                </label>
                {opts.protocol === 'srt' && (
                  <label>SRT PASSPHRASE
                    <input
                      type="password" placeholder="must match server"
                      value={opts.srtPassphrase}
                      onChange={e => {
                        const v = e.target.value
                        setOpts(o => ({...o, srtPassphrase: v}))
                        localStorage.setItem('arenaStream.srtPassphrase', v)
                      }}
                      style={{width: 140}}
                    />
                  </label>
                )}
              </>}
              <label>PROTOCOL
                <select value={opts.protocol}
                  onChange={e => setOpts(o => ({...o, protocol: e.target.value as StreamOpts['protocol']}))}>
                  <option value="srt">SRT</option>
                  <option value="udp">UDP / MPEG-TS</option>
                  <option value="rtp">RTP / H.264 (Optics PRO)</option>
                  <option value="ndi">NDI (LAN)</option>
                </select>
              </label>
              {opts.protocol === 'ndi' && (
                <label>NDI NAME
                  <input
                    type="text" placeholder="SDI Stream"
                    value={opts.ndiName}
                    onChange={e => setOpts(o => ({...o, ndiName: e.target.value}))}
                    style={{width: 140}}
                    title="Name visible to NDI receivers on the LAN"
                  />
                </label>
              )}
              {opts.protocol !== 'ndi' && (
              <label className="latency-label">
                <span>LATENCY ms</span>
                {rttInfo && !rttInfo.error && (
                  <span className="rtt-badge" title="Measured round-trip time">
                    RTT {rttInfo.rttMs}ms
                  </span>
                )}
                {rttInfo?.error && <span className="rtt-error">{rttInfo.error}</span>}
                <div className="latency-row">
                  <input type="number" value={opts.latencyMs}
                    onChange={e => setOpts(o => ({...o, latencyMs: +e.target.value}))} />
                  <button
                    className="auto-btn"
                    onClick={autoLatency}
                    disabled={measuringRtt || (!!selected && liveIds.has(selected.id))}
                    title="Ping destination and set 4× RTT"
                  >
                    {measuringRtt ? '…' : 'Auto'}
                  </button>
                </div>
              </label>
              )}
              {formats.length > 0 && (
                <label>FORMAT
                  <select value={selFormat} onChange={e => applyFormat(e.target.value)}>
                    {formats.map(f => {
                      const k = `${f.width}x${f.height}@${f.fps}`
                      return <option key={k} value={k}>{f.width}×{f.height} @ {f.fps}fps</option>
                    })}
                  </select>
                </label>
              )}
              <label>ENCODER
                <select value={hwMode} onChange={e => setHwModePersist(e.target.value as 'gpu' | 'cpu')}>
                  <option value="gpu" disabled={availableCodecs.length > 0 && !availableCodecs.find(c => c.name === 'gpu')?.available}>
                    GPU (hardware)
                  </option>
                  <option value="cpu">CPU (software)</option>
                </select>
                {encoderLabel() && (
                  <span className="encoder-resolved">Using: {encoderLabel()}</span>
                )}
              </label>
              <label>BITRATE
                <select value={opts.bitrateKbps}
                  onChange={e => setOpts(o => ({...o, bitrateKbps: +e.target.value}))}>
                  <option value={2500}>2.5 Mbps</option>
                  <option value={5000}>5 Mbps</option>
                  <option value={7500}>7.5 Mbps</option>
                  <option value={10000}>10 Mbps</option>
                  <option value={15000}>15 Mbps</option>
                  <option value={20000}>20 Mbps</option>
                  <option value={30000}>30 Mbps</option>
                  <option value={40000}>40 Mbps</option>
                </select>
              </label>
              <label className="abr-toggle" title="When on, the bitrate above becomes a ceiling — the encoder steps down under real network congestion and back up once conditions are clean, instead of holding a fixed bitrate regardless of the network.">
                <input
                  type="checkbox"
                  checked={!!opts.abrEnabled}
                  onChange={e => setOpts(o => ({...o, abrEnabled: e.target.checked}))}
                />
                ADAPTIVE BITRATE
              </label>
              <label>AUDIO
                <select value={opts.audioEnabled ? 'on' : 'off'}
                  onChange={e => setOpts(o => ({...o, audioEnabled: e.target.value === 'on'}))}>
                  <option value="on">Enabled (AAC)</option>
                  <option value="off">Disabled</option>
                </select>
              </label>
            </div>

            {/* Receive command — shown for UDP and RTP protocols */}
            {(opts.protocol === 'udp' || opts.protocol === 'rtp') && opts.destIp && (() => {
              const cmd = opts.protocol === 'rtp'
                ? `gst-launch-1.0 udpsrc port=${opts.destPort} buffer-size=4194304 caps="application/x-rtp,clock-rate=90000,encoding-name=H264,payload=96" ! rtph264depay ! decodebin ! videoconvert ! autovideosink sync=false`
                : `gst-launch-1.0 udpsrc port=${opts.destPort} buffer-size=4194304 ! "video/mpegts,systemstream=true" ! decodebin name=d d. ! queue ! videoconvert ! autovideosink sync=false`
                  + (opts.audioEnabled ? ` d. ! queue ! audioconvert ! autoaudiosink sync=false` : '')
              return (
                <div className="gst-cmd">
                  <span className="gst-label">{opts.protocol === 'rtp' ? 'RTP:' : 'RECEIVE:'}</span>
                  <code className="gst-code">{cmd}</code>
                  <button className="gst-copy" onClick={() => navigator.clipboard.writeText(cmd)}>Copy</button>
                </div>
              )
            })()}

            <button
              className={`go-live-btn ${selected && liveIds.has(selected.id) ? 'stop' : ''}`}
              onClick={toggleStream}
              disabled={!selected || togglingIds.has(selected.id)}
            >
              {selected && togglingIds.has(selected.id)
                ? '…'
                : selected && liveIds.has(selected.id) ? '■  STOP STREAM' : '▶  GO LIVE'}
            </button>
            {opts.relayUrl && (
              <button
                className="dvr-monitor-btn"
                onClick={() => {
                  const raw  = opts.relayUrl.replace(/^(https?|srt):\/\//, '')
                  const host = raw.includes('@') ? raw.split('@')[1].split(':')[0] : raw.split(':')[0]
                  sdi.openDvr({ host, streamName: opts.streamName || 'stream' })
                }}
              >
                DVR Monitor
              </button>
            )}
          </div>

          {/* Log */}
          <div className="log-panel" ref={logRef}>
            {logs.map((line, i) => (
              <div key={i} className="log-line">{line}</div>
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}
