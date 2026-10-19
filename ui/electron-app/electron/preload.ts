import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('sdi', {
  scanDevices:      ()                         => ipcRenderer.invoke('scan-devices'),
  listCodecs:       ()                         => ipcRenderer.invoke('list-codecs'),
  measureRtt:       (ip: string)               => ipcRenderer.invoke('measure-rtt', ip),
  queryFormats:  (name: string)          => ipcRenderer.invoke('query-formats', name),
  startCapture:  (d: unknown, o: unknown)=> ipcRenderer.invoke('start-capture', d, o),
  stopCapture:   (deviceId?: string)     => ipcRenderer.invoke('stop-capture', deviceId),
  selectPreview: (deviceId: string)      => ipcRenderer.invoke('select-preview', deviceId),
  startStream:   (d: unknown, o: unknown)=> ipcRenderer.invoke('start-stream', d, o),
  stopStream:    (deviceId: string)      => ipcRenderer.invoke('stop-stream', deviceId),
  openDvr:       (o: unknown)            => ipcRenderer.invoke('open-dvr', o),

  onPreviewFrame:   (cb: (d: string) => void)                       => ipcRenderer.on('preview-frame',   (_, d) => cb(d)),
  onPreviewYuv:     (cb: (id: string, w: number, h: number, d: Buffer) => void) => ipcRenderer.on('preview-yuv',     (_, id, w, h, d) => cb(id, w, h, d)),
  onCaptureStopped: (cb: (d: {id?: string, code?: number|null}) => void)=> ipcRenderer.on('capture-stopped', (_, d) => cb(d)),
  onStreamStopped:  (cb: (d: {id?: string, code?: number|null}) => void)=> ipcRenderer.on('stream-stopped',  (_, d) => cb(d)),
  onStreamUrl:      (cb: (d: {id: string, url: string}) => void) => ipcRenderer.on('stream-url',      (_, d) => cb(d)),
  onLog:            (cb: (d: string) => void) => ipcRenderer.on('log',             (_, d) => cb(d)),
  onCaptureFormat:  (cb: (d: {id: string, format: string}) => void)  => ipcRenderer.on('capture-format',   (_, d) => cb(d)),
  onAudioStats:     (cb: (d: {id: string, captured: number}) => void) => ipcRenderer.on('audio-stats', (_, d) => cb(d)),
  onEncoderUsed:    (cb: (d: {id: string, encoder: string}) => void)  => ipcRenderer.on('encoder-used',   (_, d) => cb(d)),

  removeAllListeners: (ch: string) => ipcRenderer.removeAllListeners(ch),
})
