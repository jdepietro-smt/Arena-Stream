import { contextBridge, ipcRenderer, webFrame } from 'electron'

// "Send audio over TCP": the page's WebRTC may only use TCP candidates. The browser policy alone did not stop UDP, so the
// UDP candidates are also dropped from the server's answer before the connection is set up.
if (ipcRenderer.sendSync('gw:forceTcp')) {
  void webFrame.executeJavaScript(`(() => {
    const P = RTCPeerConnection.prototype
    const udp = l => /^a=candidate:/.test(l) && / udp /i.test(l)
    const srd = P.setRemoteDescription
    P.setRemoteDescription = function (d, ...r) {
      if (d && d.sdp) d = new RTCSessionDescription({ type: d.type, sdp: d.sdp.split(/?
/).filter(l => !udp(l)).join('
') })
      return srd.call(this, d, ...r)
    }
    const aic = P.addIceCandidate
    P.addIceCandidate = function (c, ...r) {
      if (c && c.candidate && udp('a=' + c.candidate.replace(/^a=/, ''))) return Promise.resolve()
      return aic.call(this, c, ...r)
    }
  })()`)
}

// One 'asio:rx' listener for the page's lifetime; the current graph registers the function that receives the blocks.
let asioRx: ((slot: string, planar: Float32Array, peaks?: Float32Array) => void) | null = null
ipcRenderer.on('asio:rx', (_e, slot: string, planar: Float32Array, peaks?: Float32Array) => asioRx?.(slot, planar, peaks))

contextBridge.exposeInMainWorld('gw', {
  asioList: () => ipcRenderer.invoke('asio:list'),
  asioOpen: (slot: string, cfg: unknown) => ipcRenderer.invoke('asio:open', slot, cfg),
  asioClose: (slot?: string) => ipcRenderer.invoke('asio:close', slot),
  asioTx: (slot: string, planar: Float32Array, first = 0) => ipcRenderer.send('asio:tx', slot, planar, first),
  onAsioRx: (cb: ((slot: string, planar: Float32Array, peaks?: Float32Array) => void) | null) => { asioRx = cb },
  getConfig: () => ipcRenderer.invoke('config:get'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
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
