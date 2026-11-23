import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('comms', {
  platform: process.platform,
  setLive:           (live: boolean)                => ipcRenderer.send('comms-live', live),
  updaterStatus:     ()                             => ipcRenderer.invoke('updater-status'),
  updaterInstallNow: ()                             => ipcRenderer.invoke('updater-install-now'),
  updaterCheckNow:   ()                             => ipcRenderer.invoke('updater-check-now'),
  onUpdaterStatus:   (cb: (s: unknown) => void)     => { ipcRenderer.on('updater-status', (_, s) => cb(s)) },
})
