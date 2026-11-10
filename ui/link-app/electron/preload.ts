import { contextBridge, ipcRenderer } from 'electron'

// Each subscription returns its own unsubscribe, so views can detach when they unmount.
const on = (channel: string) => (cb: (...a: any[]) => void) => {
  const handler = (_: unknown, ...a: any[]) => cb(...a)
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.removeListener(channel, handler) }
}

contextBridge.exposeInMainWorld('link', {
  getConfig:     ()                          => ipcRenderer.invoke('get-config'),
  setConfig:     (c: unknown)                => ipcRenderer.invoke('set-config', c),
  testDirectory: (dir: string, key: string)  => ipcRenderer.invoke('test-directory', dir, key),
  scanCapture:   ()                          => ipcRenderer.invoke('scan-capture'),
  scanOutput:    ()                          => ipcRenderer.invoke('scan-output'),

  // Encoder calls and events are per stream: the first argument is the stream's id.
  encoderStart:   (id: string)                      => ipcRenderer.invoke('encoder-start', id),
  encoderStop:    (id: string)                      => ipcRenderer.invoke('encoder-stop', id),
  encoderRestart: (id: string)                      => ipcRenderer.invoke('encoder-restart', id),
  encoderBitrate: (id: string, kbps: number)        => ipcRenderer.invoke('encoder-bitrate', id, kbps),
  monitorStart:   (id: string, device: string)      => ipcRenderer.invoke('monitor-start', id, device),
  outputNote:     ()                                => ipcRenderer.invoke('output-note'),
  monitorStop:    (id: string)                      => ipcRenderer.invoke('monitor-stop', id),
  qualityTest:    (id: string)                      => ipcRenderer.invoke('quality-test', id),
  qualityTestCancel: ()                             => ipcRenderer.invoke('quality-test-cancel'),
  onQualityTest:  on('quality-test'),

  // Decoder calls and events are per decoder: the first argument is the decoder's id.
  decoderStart:  (id: string, select: string)  => ipcRenderer.invoke('decoder-start', id, select),
  decoderSelect: (id: string, name: string)    => ipcRenderer.invoke('decoder-select', id, name),
  decoderStop:   (id: string)                  => ipcRenderer.invoke('decoder-stop', id),
  decoderSync:   (id: string)                  => ipcRenderer.invoke('decoder-sync', id),

  onLog:           on('log'),
  onDirectory:     on('directory'),
  onEncoderStats:  on('encoder-stats'),
  onEncoderPreview: on('encoder-preview'),
  onEncoderExit:   on('encoder-exit'),
  onDecoderState:  on('decoder-state'),
  onDecoderStats:  on('decoder-stats'),
  onPreviewYuv:    on('preview-yuv'),
  onPreviewAudio:  on('preview-audio'),
})
