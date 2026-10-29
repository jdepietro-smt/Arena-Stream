import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('gw', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg: unknown) => ipcRenderer.invoke('config:set', cfg),
  rtpOpen: (id: string, cfg: unknown) => ipcRenderer.invoke('rtp:open', id, cfg),
  rtpClose: (id: string) => ipcRenderer.invoke('rtp:close', id),
  rtpTx: (id: string, samples: Float32Array) => ipcRenderer.send('rtp:tx', id, samples),
  onRtpRx: (cb: (id: string, samples: Float32Array) => void) => {
    ipcRenderer.on('rtp:rx', (_e, id, samples) => cb(id, samples))
  },
  onRtpStats: (cb: (id: string, stats: { packets: number; lost: number; late: number }) => void) => {
    ipcRenderer.on('rtp:stats', (_e, id, stats) => cb(id, stats))
  },
})
