import { contextBridge, ipcRenderer } from 'electron'

// One 'asio:rx' listener for the page's lifetime; the current graph registers the function that receives the blocks.
let asioRx: ((planar: Float32Array) => void) | null = null
ipcRenderer.on('asio:rx', (_e, planar: Float32Array) => asioRx?.(planar))

contextBridge.exposeInMainWorld('gw', {
  asioList: () => ipcRenderer.invoke('asio:list'),
  asioOpen: (cfg: unknown) => ipcRenderer.invoke('asio:open', cfg),
  asioClose: () => ipcRenderer.invoke('asio:close'),
  asioTx: (planar: Float32Array) => ipcRenderer.send('asio:tx', planar),
  onAsioRx: (cb: ((planar: Float32Array) => void) | null) => { asioRx = cb },
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
