// Windows input injection via SendInput (koffi, no native build step).
// Keys are sent as hardware scancodes so games and apps that read raw input see them like a real keyboard.

const koffi = require('koffi')

const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT }) })
const user32 = koffi.load('user32.dll')
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)')
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ int32 *pt)')
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int idx)')

const F = { MOVE: 0x1, LDOWN: 0x2, LUP: 0x4, RDOWN: 0x8, RUP: 0x10, MDOWN: 0x20, MUP: 0x40, XDOWN: 0x80, XUP: 0x100, WHEEL: 0x800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000 }
const K = { KEYUP: 0x2, EXTENDED: 0x1, SCANCODE: 0x8 }
const BUTTONS = [[F.LDOWN, F.LUP, 0], [F.MDOWN, F.MUP, 0], [F.RDOWN, F.RUP, 0], [F.XDOWN, F.XUP, 1], [F.XDOWN, F.XUP, 2]] // DOM button index -> flags

// KeyboardEvent.code -> [scancode, extended]
const SC = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06], Digit6: [0x07], Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b],
  Minus: [0x0c], Equal: [0x0d], Backspace: [0x0e], Tab: [0x0f], KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14], KeyY: [0x15], KeyU: [0x16], KeyI: [0x17], KeyO: [0x18], KeyP: [0x19],
  BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c], ControlLeft: [0x1d], KeyA: [0x1e], KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22], KeyH: [0x23], KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26],
  Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2a], Backslash: [0x2b], KeyZ: [0x2c], KeyX: [0x2d], KeyC: [0x2e], KeyV: [0x2f], KeyB: [0x30], KeyN: [0x31], KeyM: [0x32],
  Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36], NumpadMultiply: [0x37], AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a],
  F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f], F6: [0x40], F7: [0x41], F8: [0x42], F9: [0x43], F10: [0x44], NumLock: [0x45], ScrollLock: [0x46],
  Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a], Numpad4: [0x4b], Numpad5: [0x4c], Numpad6: [0x4d], NumpadAdd: [0x4e], Numpad1: [0x4f], Numpad2: [0x50], Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53],
  IntlBackslash: [0x56], F11: [0x57], F12: [0x58],
  NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], PrintScreen: [0x37, 1], AltRight: [0x38, 1], Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4b, 1],
  ArrowRight: [0x4d, 1], End: [0x4f, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1], Delete: [0x53, 1], MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
}

const mouse = (dx, dy, data, flags) => ({ type: 0, u: { mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } } })
const key = (sc, ext, up) => ({ type: 1, u: { ki: { wVk: 0, wScan: sc, dwFlags: K.SCANCODE | (ext ? K.EXTENDED : 0) | (up ? K.KEYUP : 0), time: 0, dwExtraInfo: 0 } } })
const send = inputs => SendInput(inputs.length, inputs, koffi.sizeof(INPUT))

const clamp01 = n => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const num = n => (Number.isFinite(n) ? Math.max(-120000, Math.min(120000, Math.round(n))) : 0)

/**
 * Applies one validated input event. `bounds` is the captured display in physical pixels {x,y,width,height},
 * so normalized viewer coordinates land on the right monitor. Returns false for anything malformed.
 */
function inject(e, bounds) {
  if (!e || typeof e !== 'object') return false
  switch (e.k) {
    case 'mm': { // absolute move, x/y in 0..1 of the captured display
      const vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79)
      const px = bounds.x + clamp01(e.x) * (bounds.width - 1), py = bounds.y + clamp01(e.y) * (bounds.height - 1)
      return send([mouse(Math.round(((px - vx) * 65535) / (vw - 1)), Math.round(((py - vy) * 65535) / (vh - 1)), 0, F.MOVE | F.ABSOLUTE | F.VIRTUALDESK)]) === 1
    }
    case 'mr': // relative move (pointer-lock / games)
      return send([mouse(num(e.dx), num(e.dy), 0, F.MOVE)]) === 1
    case 'md': case 'mu': {
      const b = BUTTONS[e.b]
      if (!b) return false
      return send([mouse(0, 0, b[2], e.k === 'md' ? b[0] : b[1])]) === 1
    }
    case 'wh':
      return send([...(e.dy ? [mouse(0, 0, num(-e.dy) >>> 0, F.WHEEL)] : []), ...(e.dx ? [mouse(0, 0, num(e.dx) >>> 0, F.HWHEEL)] : [])]) > 0
    case 'kd': case 'ku': {
      const s = SC[e.c]
      return !!s && send([key(s[0], s[1], e.k === 'ku')]) === 1
    }
    case 'ra':
      releaseAll()
      return true
    default:
      return false
  }
}

/** Releases every key and button that could be left held when a session ends or control is revoked. */
function releaseAll() {
  const inputs = [F.LUP, F.MUP, F.RUP].map(f => mouse(0, 0, 0, f))
  for (const [sc, ext] of Object.values(SC)) inputs.push(key(sc, ext, true))
  send(inputs)
}

function cursor() {
  const p = [0, 0]
  GetCursorPos(p)
  return p
}

module.exports = { inject, releaseAll, cursor, scancode: c => SC[c] }
