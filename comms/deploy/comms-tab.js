/* Adds a "Comms" tab to the Arena/DVR dashboard. Injected into every dashboard page by nginx
 * (sub_filter), so the dashboard's own code is untouched. Remove the sub_filter line to undo.
 * It reuses the dashboard's own tab bar when it can find one, otherwise it adds an edge tab. */
(function () {
  if (window.top !== window || window.__arenaCommsTab) return
  window.__arenaCommsTab = true

  var APP = '/comms/app/'
  var panel, frame

  function build() {
    panel = document.createElement('div')
    panel.id = 'arena-comms-panel'
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;background:#07070d'
    var bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:6px 12px;background:#10101a;border-bottom:1px solid #2a2a3a;color:#e8eaf0;font:600 12px system-ui,sans-serif;letter-spacing:.1em'
    bar.innerHTML = '<span>ARENA COMMS</span><span style="flex:1"></span>' +
      '<a href="' + APP + '" target="_blank" style="color:#9aa0b4;text-decoration:none">OPEN IN NEW TAB</a>' +
      '<a href="/comms/admin" target="_blank" style="color:#9aa0b4;text-decoration:none">ADMIN</a>'
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

  function show() {
    if (!panel) build()
    if (!frame.src) frame.src = APP // load lazily, only when first opened
    panel.style.display = 'flex'
    try { history.replaceState(null, '', '#comms') } catch (e) { /* ignore */ }
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
    if (location.hash === '#comms') show()
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide() })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init()
})()
