// Small badge in the header while a new version is on its way; an "Install now" button once it is ready.
const chip = document.getElementById('updateChip')
function show(s) {
  if (!chip) return
  if (!s || !s.pending || ['idle', 'checking', 'off'].includes(s.state)) { chip.hidden = true; return }
  chip.hidden = false
  chip.textContent = ''
  const t = document.createElement('span')
  t.textContent = s.state === 'downloading' ? `Updating to ${s.pending}… ${s.pct ?? 0}%` : s.state === 'installing' ? `Installing ${s.pending}…` : s.state === 'error' ? `Update ${s.pending} failed` : `Update ${s.pending} ready`
  chip.title = s.state === 'error' ? (s.error || '') : s.state === 'ready' ? 'Windows will ask for administrator approval' : ''
  chip.appendChild(t)
  if (s.state === 'ready') { const b = document.createElement('button'); b.textContent = 'Install now'; b.onclick = () => window.arena.update.installNow(); chip.appendChild(b) }
}
window.arena.update.status().then(show).catch(() => {})
window.arena.update.onStatus(show)
