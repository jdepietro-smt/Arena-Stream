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
  const [captureFormat,  setCaptureFormat]  = useState('')
  const [audioCapture,   setAudioCapture]   = useState<number | null>(null)
  const logRef    = useRef<HTMLDivElement>(null)
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const glStateRef   = useRef<{
    gl: WebGLRenderingContext
    prog: WebGLProgram
    yTex: WebGLTexture; uTex: WebGLTexture; vTex: WebGLTexture
    w: number; h: number
  } | null>(null)
  // Latest YUV frame — IPC writes here, requestAnimationFrame reads it
  const pendingYuvRef = useRef<{ w: number; h: number; data: Uint8Array } | null>(null)
  const rafRef        = useRef<number>(0)
  const capturingRef = useRef(false)

  // ── IPC listeners ──────────────────────────────────────────────────────────
  useEffect(() => {
    sdi.onLog((line: string) => {
      setLogs(prev => [...prev.slice(-200), line])
    })
    sdi.onStreamUrl((url: string) => setViewerUrl(url))
    sdi.onStreamStopped(() => setStreaming(false))

    // Raw YUV420P preview — IPC just stores the latest frame.
    // requestAnimationFrame (below) renders it, synced to display VBlank = no tearing.
    sdi.onPreviewYuv((w: number, h: number, yuv: Buffer) => {
      pendingYuvRef.current = { w, h, data: new Uint8Array(yuv.buffer ?? yuv) }
    })

    sdi.onCaptureFormat((fmt: string) => {
      setCaptureFormat(fmt)
    })
    sdi.onAudioStats((d: {captured: number}) => {
      setAudioCapture(d.captured)
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

  // WebGL render loop — driven by requestAnimationFrame so every draw is
  // VSync-aligned and tearing is eliminated.
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
          /* BT.709 limited-range — correct for all HD SDI (1080i/p, 720p).
             BT.601 was producing muted reds and a flat/shadowy look on HD content. */
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
      return { gl, prog, yTex: mkTex(0,'uY'), uTex: mkTex(1,'uCb'), vTex: mkTex(2,'uCr'), w, h }
    }

    const render = () => {
      rafRef.current = requestAnimationFrame(render)
      const frame = pendingYuvRef.current
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
  }, [])   // runs once on mount, loop continues for app lifetime

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
    capturingRef.current = true
    setSelected(dev)   // this channel becomes the preview source
    try {
      // Toggle: clicking an active channel stops it; clicking an inactive one starts it
      const wasActive = activeIds.has(dev.id)
      if (wasActive) {
        await sdi.stopCapture()
        setActiveIds(prev => { const s = new Set(prev); s.delete(dev.id); return s })
      } else {
        const fmts = await sdi.queryFormats(dev.name)
        setFormats(fmts)
        if (fmts.length > 0) {
          const best = fmts[0]
          setSelFormat(`${best.width}x${best.height}@${best.fps}`)
          const newOpts = { ...opts, width: best.width, height: best.height, fps: best.fps }
          setOpts(newOpts)
          await sdi.startCapture(dev, newOpts)
        } else {
          await sdi.startCapture(dev, opts)
        }
        setActiveIds(prev => new Set([...prev, dev.id]))
      }
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
                  disabled={streaming}
                  title={isActive ? 'Click to stop this channel' : 'Click to start this channel'}
                >
                  <span className={`dot ${dotState}`} />
                  <div className="source-info">
                    <div className="source-name">{dev.name}</div>
                    <div className="source-type">
                      <span className={`type-badge type-badge--${dev.type}`}>
                        {dev.type.toUpperCase()}
                      </span>
                      {isActive && captureFormat && isSelected && (
                        <span className="source-format">{captureFormat}</span>
                      )}
                      {isActive && isSelected && (
                        <span className={`audio-badge${audioCapture == null ? '' : audioCapture > 0 ? ' audio-badge--active' : ' audio-badge--silent'}`}>
                          {audioCapture == null ? '◎ AUD' : audioCapture > 0 ? `● AUD ${audioCapture}f` : '○ AUD –'}
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
          {/* Preview — WebGL canvas renders raw YUV420P, zero compression artifacts */}
          <div className={`preview-wrap ${streaming || receiving ? 'live' : ''}`}>
            <canvas ref={canvasRef} className="preview-canvas"
              style={{ display: glStateRef.current ? 'block' : 'none' }} />
            {appMode === 'encode' && !selected && (
              <div className="preview-placeholder">
                <div className="placeholder-icon">▶</div>
                <div>Select a source to preview</div>
              </div>
            )}
            {appMode === 'receive' && !connectedFeed && (
              <div className="preview-placeholder">
                <div className="placeholder-icon">◉</div>
                <div>Select a stream to receive</div>
              </div>
            )}
            {appMode === 'encode' && selected && (
              <div className="preview-overlay">
                <span className="preview-name">{selected.name}</span>
              </div>
            )}
            {appMode === 'receive' && connectedFeed && (
              <div className="preview-overlay">
                <span className="preview-name">{connectedFeed.name}  {connectedFeed.ip}:{connectedFeed.port}</span>
              </div>
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
