import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'

// The gateway reuses the intercom engine from the sibling comms-app project.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { alias: { '@engine': path.resolve(__dirname, '../comms-app/src/lib/comms.ts') } },
  server: { fs: { allow: ['..'] } },
})
