import { useEffect, useRef, useState } from 'react'

export type FrameData = { w: number; h: number; data: Uint8Array }

// WebGL YUV420P preview tile, ported from the encoder app's VideoTile
// (ui/electron-app/src/App.tsx) — same shader/texture setup and the same
// shared-framesRef-keyed-by-id pattern, so multiple tiles (the multiviewer
// grid) can each read their own stream's latest frame out of one shared map
// without needing a fresh ref object per tile per render.
export function VideoTile({ id, framesRef }: { id: string; framesRef: React.MutableRefObject<Record<string, FrameData>> }) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const glStateRef = useRef<{
    gl: WebGLRenderingContext
    yTex: WebGLTexture; uTex: WebGLTexture; vTex: WebGLTexture
    w: number; h: number
  } | null>(null)
  const rafRef = useRef(0)

  useEffect(() => {
    let glState: typeof glStateRef.current = null

    const initGl = (canvas: HTMLCanvasElement, w: number, h: number) => {
      canvas.width = w; canvas.height = h
      const gl = canvas.getContext('webgl', { alpha: false, antialias: false, desynchronized: false })
      if (!gl) return null

      const mkShader = (type: number, src: string) => {
        const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s
      }
      const vert = mkShader(gl.VERTEX_SHADER, `
        attribute vec2 aPos; attribute vec2 aTex; varying vec2 vTex;
        void main() { gl_Position = vec4(aPos,0.0,1.0); vTex = aTex; }
      `)
      const frag = mkShader(gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform sampler2D uY, uCb, uCr; varying vec2 vTex;
        void main() {
          /* BT.709 limited-range — correct for all HD SDI (1080i/p, 720p). */
          float y  = texture2D(uY,  vTex).r - 0.0627;
          float cb = texture2D(uCb, vTex).r - 0.5;
          float cr = texture2D(uCr, vTex).r - 0.5;
          gl_FragColor = vec4(
            clamp(1.164*y + 1.793*cr,              0.0, 1.0),
            clamp(1.164*y - 0.213*cb - 0.533*cr,   0.0, 1.0),
            clamp(1.164*y + 2.112*cb,               0.0, 1.0),
            1.0);
        }
      `)
      const prog = gl.createProgram()!
      gl.attachShader(prog, vert); gl.attachShader(prog, frag); gl.linkProgram(prog); gl.useProgram(prog)

      const vbuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,1, 1,-1,1,1, -1,1,0,0, 1,1,1,0]), gl.STATIC_DRAW)
      const aPos = gl.getAttribLocation(prog, 'aPos'); const aTex = gl.getAttribLocation(prog, 'aTex')
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(aTex); gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8)

      const mkTex = (unit: number, name: string) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.uniform1i(gl.getUniformLocation(prog, name), unit); return t
      }
      return { gl, yTex: mkTex(0,'uY'), uTex: mkTex(1,'uCb'), vTex: mkTex(2,'uCr'), w, h }
    }

    const render = () => {
      rafRef.current = requestAnimationFrame(render)
      const frame = framesRef.current[id]
      if (!frame) {
        // Frame feed stopped (source went away) — actively blank the canvas
        // instead of leaving the last decoded picture frozen in the
        // framebuffer, which WebGL never clears on its own.
        if (glState) { glState.gl.clear(glState.gl.COLOR_BUFFER_BIT); glState = null; glStateRef.current = null }
        return
      }
      const canvas = canvasRef.current
      if (!canvas) return

      if (!glState || glState.w !== frame.w || glState.h !== frame.h) {
        glState = initGl(canvas, frame.w, frame.h)
        glStateRef.current = glState
      }
      if (!glState) return

      const { gl, yTex, uTex, vTex } = glState
      const { w, h, data } = frame
      const ySz = w * h, uvSz = (w >> 1) * (h >> 1)

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, yTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data.subarray(0, ySz))
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, uTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w>>1, h>>1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data.subarray(ySz, ySz+uvSz))
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, vTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w>>1, h>>1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data.subarray(ySz+uvSz))

      gl.viewport(0, 0, w, h)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    rafRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafRef.current)
  }, [id, framesRef])

  return <canvas ref={canvasRef} className="preview-canvas" />
}

