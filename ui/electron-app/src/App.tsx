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
        uniform sampler2D uY, uCb, uCr; varying vec2 vTex;
        void main() {
          /* BT.709 limited-range — correct for all HD SDI (1080i/p, 720p). */
          float y  = texture2D(uY,  vTex).r - 0.0627;
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

    const render = () => {
      rafRef.current = requestAnimationFrame(render)
      const frame = framesRef.current[deviceId]
      if (!frame) return
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
  // ── App mode ────────────────────────────────────────────────────────────────
  const [appMode, setAppMode] = useState<'encode' | 'receive'>('encode')

  // ── Encoder state ───────────────────────────────────────────────────────────
  const [devices,        setDevices]        = useState<Device[]>([])
  const [selected,       setSelected]       = useState<Device | null>(null)
  const [activeIds,      setActiveIds]      = useState<Set<string>>(new Set())
  const [streaming,      setStreaming]       = useState(false)

  // ── Receiver state ──────────────────────────────────────────────────────────
  type Feed = { name: string; ip: string; port: number; format?: string; codec?: string; relay?: string }
  const [feeds,          setFeeds]          = useState<Feed[]>([])
  const [connectedFeed,  setConnectedFeed]  = useState<Feed | null>(null)
  const [receiving,      setReceiving]      = useState(false)
  const [viewerUrl,      setViewerUrl]       = useState('')
  const [logs,           setLogs]           = useState<string[]>([])
  const [urlCopied,      setUrlCopied]      = useState(false)
  const [availableCodecs, setAvailableCodecs] = useState<{name:string;label:string;available:boolean}[]>([])
  const [opts, setOpts] = useState<StreamOpts>({
    codec: 'libx264', bitrateKbps: 15000, latencyMs: 20,
    destIp: '', destPort: 4200, protocol: 'srt', relayUrl: '5.78.236.254:8890', streamName: '',
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
  function renameDevice(id: string, name: string) {
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
    if (id === selected?.id && name.trim()) {
      setOpts(o => ({ ...o, streamName: name.trim() }))
    }
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
    sdi.onStreamUrl((url: string) => setViewerUrl(url))
    sdi.onStreamStopped(() => setStreaming(false))

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
    sdi.onDiscoveredFeed((f: any) => {
      setFeeds(prev => {
        const key = `${f.ip}:${f.port}`
        const exists = prev.find(x => `${x.ip}:${x.port}` === key)
        if (exists) return prev   // already listed
        return [...prev, f as Feed]
      })
    })
    sdi.onFeedExpired((f: any) => {
      setFeeds(prev => prev.filter(x => !(x.ip === f.ip && x.port === f.port)))
      setConnectedFeed(c => (c?.ip === f.ip && c?.port === f.port) ? null : c)
    })
    sdi.onReceiveStopped(() => { setReceiving(false); setConnectedFeed(null) })
    return () => {
      ['log','stream-url','stream-stopped','preview-frame','preview-yuv','capture-format',
       'audio-stats','discovered-feed','feed-expired','receive-stopped'].forEach(c =>
        sdi.removeAllListeners(c))
    }
  }, [])

  // Start/stop discovery listener when switching modes
  useEffect(() => {
    if (appMode === 'receive') {
      setFeeds([])
      sdi.startDiscovery()
    } else {
      sdi.stopDiscovery()
      if (receiving) { sdi.disconnectFeed(); setReceiving(false); setConnectedFeed(null) }
    }
  }, [appMode]) // eslint-disable-line react-hooks/exhaustive-deps

  async function connectToFeed(feed: Feed) {
    if (receiving) { await sdi.disconnectFeed(); setReceiving(false) }
    setConnectedFeed(feed)
    const res = await sdi.connectFeed({ ip: feed.ip, port: feed.port, latencyMs: opts.latencyMs, relay: feed.relay, name: feed.name })
    if (res?.ok) setReceiving(true)
  }

  async function disconnectFromFeed() {
    await sdi.disconnectFeed()
    setReceiving(false)
    setConnectedFeed(null)
  }

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
    // Picks the best available as the default (GPU preferred over CPU).
    ;(window as any).sdi.listCodecs().then((codecs: {name:string;label:string;available:boolean}[]) => {
      setAvailableCodecs(codecs)
      const available = codecs.filter(c => c.available)
      if (available.length > 0)
        setOpts(o => ({ ...o, codec: available[0].name }))
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function selectDevice(dev: Device) {
    if (streaming || capturingRef.current) return

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
      if (customNames[dev.id]) setOpts(o => ({ ...o, streamName: customNames[dev.id] }))
      await sdi.selectPreview(dev.id)
      return
    }

    // Not active yet — start it fresh (it becomes the preview automatically).
    capturingRef.current = true
    setSelected(dev)
    const baseOpts = customNames[dev.id] ? { ...opts, streamName: customNames[dev.id] } : opts
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
    if (streaming) {
      await sdi.stopStream()
      setStreaming(false)
      setViewerUrl('')
    } else {
      const res = await sdi.startStream(opts)
      if (res.ok) setStreaming(true)
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
    navigator.clipboard.writeText(viewerUrl)
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
          <span className="app-name">ARENA STREAM</span>
          {/* Mode toggle */}
          <div className="mode-toggle">
            <button className={appMode === 'encode' ? 'active' : ''}
              onClick={() => setAppMode('encode')}>ENCODE</button>
            <button className={appMode === 'receive' ? 'active' : ''}
              onClick={() => setAppMode('receive')}>RECEIVE</button>
          </div>
          {appMode === 'encode' && (
            <span className={`live-badge ${streaming ? 'live' : ''}`}>
              {streaming ? '● LIVE' : '○ OFFLINE'}
            </span>
          )}
          {appMode === 'receive' && (
            <span className={`live-badge ${receiving ? 'live' : ''}`}>
              {receiving ? '● RECEIVING' : '○ IDLE'}
            </span>
          )}
        </div>
        <div className="titlebar-right">
          {appMode === 'encode' && viewerUrl && (
            <button className="url-pill" onClick={copyUrl}>
              {urlCopied ? '✓ Copied' : viewerUrl}
            </button>
          )}
        </div>
      </div>

      <div className="body">

        {/* ── RECEIVE mode sidebar ──────────────────── */}
        {appMode === 'receive' && (
          <aside className="sidebar">
            <div className="sidebar-header">
              <span>FEEDS</span>
              <span className="scan-pulse" title="Listening for streams…">◉</span>
            </div>
            <div className="source-list">
              {feeds.length === 0 && (
                <div className="no-devices">
                  Listening for streams…<br/>
                  Start streaming on any encoder<br/>on this network.
                </div>
              )}
              {feeds.map(feed => {
                const key = `${feed.ip}:${feed.port}`
                const isConnected = connectedFeed?.ip === feed.ip && connectedFeed?.port === feed.port
                return (
                  <button key={key}
                    className={`source-card ${isConnected ? 'selected' : ''} aja`}
                    onClick={() => isConnected ? disconnectFromFeed() : connectToFeed(feed)}
                    title={isConnected ? 'Click to disconnect' : 'Click to receive'}
                  >
                    <span className={`dot ${isConnected && receiving ? 'live' : isConnected ? 'preview' : ''}`} />
                    <div className="source-info">
                      <div className="source-name">{feed.name}</div>
                      <div className="source-type">
                        {feed.ip}:{feed.port}
                        {feed.format && <span className="source-format">{feed.format}</span>}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </aside>
        )}

        {/* ── ENCODE mode source list ───────────────── */}
        {appMode === 'encode' && (
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
              const dotState   = isActive && streaming ? 'live' : isActive ? 'preview' : ''
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
                  disabled={streaming}
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
        )} {/* end encode sidebar */}

        {/* ── Main area ────────────────────────────── */}
        <main className="main">
          {/* Preview — WebGL canvas(es) render raw YUV420P, zero compression artifacts.
              Encode mode shows one tile per active channel (all running concurrently);
              receive mode shows the single connected feed. */}
          <div className={`preview-wrap ${streaming || receiving ? 'live' : ''}`}>
            {appMode === 'encode' && activeIds.size === 0 && (
              <div className="preview-placeholder">
                <div className="placeholder-icon">▶</div>
                <div>Select a source to preview</div>
              </div>
            )}
            {appMode === 'encode' && activeIds.size > 0 && (
              <div className={`video-grid video-grid--${Math.min(activeIds.size, 4)}`}>
                {Array.from(activeIds).map(id => {
                  const dev = devices.find(d => d.id === id)
                  if (!dev) return null
                  return (
                    <VideoTile
                      key={id}
                      deviceId={id}
                      framesRef={framesRef}
                      label={customNames[id] || dev.name}
                      isLive={streaming}
                      isSelected={selected?.id === id}
                      onClick={() => selectDevice(dev)}
                    />
                  )
                })}
              </div>
            )}
            {appMode === 'receive' && !connectedFeed && (
              <div className="preview-placeholder">
                <div className="placeholder-icon">◉</div>
                <div>Select a stream to receive</div>
              </div>
            )}
            {appMode === 'receive' && connectedFeed && (
              <VideoTile
                deviceId="__receive__"
                framesRef={framesRef}
                label={`${connectedFeed.name}  ${connectedFeed.ip}:${connectedFeed.port}`}
              />
            )}
          </div>

          {/* Config + Go Live — encode mode only */}
          {appMode === 'encode' && <div className="controls">
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
                    disabled={measuringRtt || streaming}
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
              <label>VIDEO CODEC
                <select value={opts.codec}
                  onChange={e => setOpts(o => ({...o, codec: e.target.value}))}>
                  {(availableCodecs.length > 0 ? availableCodecs : [
                    {name:'libx264',    label:'H.264 (CPU)',         available:true},
                    {name:'h264_nvenc', label:'H.264 (NVIDIA GPU)',  available:false},
                    {name:'hevc_nvenc', label:'H.265 (NVIDIA GPU)',  available:false},
                    {name:'libx265',    label:'H.265 (CPU)',         available:false},
                  ]).map(c => (
                    <option key={c.name} value={c.name} disabled={!c.available}>
                      {c.label}{!c.available ? ' (unavailable)' : ''}
                    </option>
                  ))}
                </select>
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
              className={`go-live-btn ${streaming ? 'stop' : ''}`}
              onClick={toggleStream}
              disabled={!selected}
            >
              {streaming ? '■  STOP STREAM' : '▶  GO LIVE'}
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
          </div>}

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
