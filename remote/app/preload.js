const { contextBridge, ipcRenderer } = require('electron')

const call = name => (...a) => ipcRenderer.invoke(name, ...a)

contextBridge.exposeInMainWorld('arena', {
  identity: { info: call('identity:info'), sign: call('identity:sign'), verify: call('identity:verify') },
  pin: { status: call('pin:status'), accept: call('pin:accept') },
  passcode: { set: call('passcode:set'), has: call('passcode:has'), check: call('passcode:check') },
  host: {
    sources: call('host:sources'),
    arm: call('host:arm'),
    begin: call('host:begin'),
    setControl: call('host:setControl'),
    end: call('host:end'),
    frames: call('host:frames'),
    input: ev => ipcRenderer.send('host:input', ev),
  },
  helperStatus: call('helper:status'),
  onDesktop: cb => ipcRenderer.on('desktop', (_e, name) => cb(name)),
  onFrame: cb => ipcRenderer.on('frame', (_e, data) => cb(data)),
  onKill: cb => ipcRenderer.on('kill', () => cb()),
})
