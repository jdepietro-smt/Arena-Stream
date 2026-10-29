/* Adds a "Comms" tab to the Arena/DVR dashboard. Injected into every dashboard page by nginx
 * (sub_filter), so the dashboard's own code is untouched. Remove the sub_filter line to undo.
 * It reuses the dashboard's own tab bar when it can find one, otherwise it adds an edge tab. */
(function () {
  if (window.top !== window || window.__arenaCommsTab) return
  window.__arenaCommsTab = true

  var APP = '/comms/app/'
  var ADMIN = '/comms/admin/'
  var panel, frame, go, current = APP

  function build() {
    panel = document.createElement('div')
    panel.id = 'arena-comms-panel'
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;background:#07070d'
    var bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:6px 12px;background:#10101a;border-bottom:1px solid #2a2a3a;color:#e8eaf0;font:600 12px system-ui,sans-serif;letter-spacing:.1em'
    bar.innerHTML = '<span>ARENA COMMS</span>'
    // Two sections: the intercom itself, and the server admin (channels, groups, users).
    var views = [['INTERCOM', APP], ['ADMIN  —  CHANNELS · GROUPS · USERS', ADMIN]]
    var btns = views.map(function (v) {
      var b = document.createElement('button')
      b.textContent = v[0]
      b.dataset.src = v[1]
      b.onclick = function () { go(v[1]) }
      bar.appendChild(b)
      return b
    })
    function paint() {
      btns.forEach(function (b) {
        var on = b.dataset.src === current
        b.style.cssText = 'border:1px solid ' + (on ? '#6366f1' : '#2a2a3a') + ';background:' + (on ? '#6366f1' : '#1c1c2a') +
          ';color:#fff;border-radius:4px;padding:4px 12px;cursor:pointer;font:inherit;letter-spacing:inherit'
      })
    }
    go = function (src) {
      current = src
      if (frame.getAttribute('src') !== src) frame.src = src
      paint()
      try { history.replaceState(null, '', src === ADMIN ? '#comms-admin' : '#comms') } catch (e) { /* ignore */ }
    }
    var spacer = document.createElement('span')
    spacer.style.flex = '1'
    bar.appendChild(spacer)
    var close = document.createElement('button')
    close.textContent = 'CLOSE'
    close.style.cssText = 'background:#1c1c2a;color:#e8eaf0;border:1px solid #2a2a3a;border-radius:4px;padding:4px 10px;cursor:pointer;font:inherit'
    close.onclick = hide
    bar.appendChild(close)
    frame = document.createElement('iframe')
    frame.allow = 'microphone; autoplay; speaker-selection'
    frame.style.cssText = 'flex:1;border:0;width:100%'
    panel.appendChild(bar)
    panel.appendChild(frame)
    document.body.appendChild(panel)
  }

  function show(src) {
    if (!panel) build()
    go(typeof src === 'string' ? src : current) // loads lazily, only when first opened
    panel.style.display = 'flex'
  }
  function hide() {
    if (panel) panel.style.display = 'none'
    try { history.replaceState(null, '', location.pathname + location.search) } catch (e) { /* ignore */ }
  }

  function addTab() {
    // Prefer the dashboard's own tab/nav bar so the new tab looks native.
    var host = document.querySelector('[role=tablist], .tabs, .tab-bar, .tabbar, header nav, nav')
    var sample = host && host.querySelector('button, a')
    if (host && sample) {
      var el = sample.cloneNode(false)
      el.textContent = 'Comms'
      el.removeAttribute('id'); el.removeAttribute('href'); el.removeAttribute('onclick')
      el.classList.remove('active', 'selected', 'current')
      el.setAttribute('aria-selected', 'false')
      el.style.cursor = 'pointer'
      el.addEventListener('click', function (e) { e.preventDefault(); show() })
      host.appendChild(el)
      return
    }
    var tab = document.createElement('button')
    tab.textContent = 'COMMS'
    tab.style.cssText = 'position:fixed;right:0;top:40%;z-index:2147482000;transform-origin:100% 100%;' +
      'writing-mode:vertical-rl;padding:14px 8px;background:#6366f1;color:#fff;border:0;' +
      'border-radius:8px 0 0 8px;font:700 12px system-ui,sans-serif;letter-spacing:.15em;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)'
    tab.onclick = show
    document.body.appendChild(tab)
  }

  function init() {
    addTab()
    if (location.hash === '#comms') show(APP)
    if (location.hash === '#comms-admin') show(ADMIN)
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide() })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init()
})()
