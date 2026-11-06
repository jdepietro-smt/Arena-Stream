// Copies this machine's Node binary into build/ so the installer can ship it for the audio helper process.
// Windows: build/node.exe. macOS: build/node (the build machine's own architecture, matching the Electron build it makes).
import fs from 'fs'
const name = process.platform === 'win32' ? 'node.exe' : 'node'
fs.mkdirSync('build', { recursive: true })
fs.copyFileSync(process.execPath, `build/${name}`)
if (process.platform !== 'win32') fs.chmodSync(`build/${name}`, 0o755)
console.log(`copied ${process.execPath} (${process.version}) to build/${name}`)
