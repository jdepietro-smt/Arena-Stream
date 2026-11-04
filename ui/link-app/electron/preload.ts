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

  encoderStart:   ()                         => ipcRenderer.invoke('encoder-start'),
  encoderStop:    ()                         => ipcRenderer.invoke('encoder-stop'),
  encoderBitrate: (kbps: number)             => ipcRenderer.invoke('encoder-bitrate', kbps),

  decoderStart:  (select: string)            => ipcRenderer.invoke('decoder-start', select),
  decoderSelect: (name: string)              => ipcRenderer.invoke('decoder-select', name),
  decoderStop:   ()                          => ipcRenderer.invoke('decoder-stop'),

  onLog:           on('log'),
  onDirectory:     on('directory'),
  onEncoderStats:  on('encoder-stats'),
  onEncoderExit:   on('encoder-exit'),
  onDecoderState:  on('decoder-state'),
  onDecoderStats:  on('decoder-stats'),
  onPreviewYuv:    on('preview-yuv'),
  onPreviewAudio:  on('preview-audio'),
})
