// Copies this machine's node.exe into build/ so the installer can ship it for the ASIO helper process.
import fs from 'fs'
fs.mkdirSync('build', { recursive: true })
fs.copyFileSync(process.execPath, 'build/node.exe')
console.log(`copied ${process.execPath} (${process.version}) to build/node.exe`)
