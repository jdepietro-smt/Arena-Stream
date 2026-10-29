import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('comms', {
  platform: process.platform,
})
