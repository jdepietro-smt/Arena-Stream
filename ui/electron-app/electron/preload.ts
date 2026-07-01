import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('sdi', {
  scanDevices:      ()                         => ipcRenderer.invoke('scan-devices'),
  listCodecs:       ()                         => ipcRenderer.invoke('list-codecs'),
  measureRtt:       (ip: string)               => ipcRenderer.invoke('measure-rtt', ip),
  startDiscovery:   ()                         => ipcRenderer.invoke('start-discovery'),
  stopDiscovery:    ()                         => ipcRenderer.invoke('stop-discovery'),
  connectFeed:      (f: unknown)               => ipcRenderer.invoke('connect-feed', f),
  disconnectFeed:   ()                         => ipcRenderer.invoke('disconnect-feed'),
  queryFormats:  (name: string)          => ipcRenderer.invoke('query-formats', name),
  startCapture:  (d: unknown, o: unknown)=> ipcRenderer.invoke('start-capture', d, o),
  stopCapture:   ()                      => ipcRenderer.invoke('stop-capture'),
  startStream:   (o: unknown)            => ipcRenderer.invoke('start-stream', o),
  stopStream:    ()                      => ipcRenderer.invoke('stop-stream'),
  openDvr:       (o: unknown)            => ipcRenderer.invoke('open-dvr', o),

  onPreviewFrame:   (cb: (d: string) => void)                       => ipcRenderer.on('preview-frame',   (_, d) => cb(d)),
  onPreviewYuv:     (cb: (w: number, h: number, d: Buffer) => void) => ipcRenderer.on('preview-yuv',     (_, w, h, d) => cb(w, h, d)),
  onCaptureStopped: (cb: (d: unknown) => void)=> ipcRenderer.on('capture-stopped', (_, d) => cb(d)),
  onStreamStopped:  (cb: (d: unknown) => void)=> ipcRenderer.on('stream-stopped',  (_, d) => cb(d)),
  onStreamUrl:      (cb: (d: string) => void) => ipcRenderer.on('stream-url',      (_, d) => cb(d)),
  onLog:            (cb: (d: string) => void) => ipcRenderer.on('log',             (_, d) => cb(d)),
  onCaptureFormat:  (cb: (d: {id: string, format: string}) => void)  => ipcRenderer.on('capture-format',   (_, d) => cb(d)),
  onAudioStats:     (cb: (d: {id: string, captured: number}) => void) => ipcRenderer.on('audio-stats', (_, d) => cb(d)),
  onDiscoveredFeed: (cb: (d: unknown) => void) => ipcRenderer.on('discovered-feed',  (_, d) => cb(d)),
  onFeedExpired:    (cb: (d: unknown) => void) => ipcRenderer.on('feed-expired',     (_, d) => cb(d)),
  onReceiveStopped: (cb: (d: unknown) => void) => ipcRenderer.on('receive-stopped',  (_, d) => cb(d)),

  removeAllListeners: (ch: string) => ipcRenderer.removeAllListeners(ch),
})
