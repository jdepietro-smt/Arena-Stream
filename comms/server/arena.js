// Arena stream awareness: polls the Arena stream server's mediamtx control API and turns
// feed health into events the intercom can speak and show ("Camera 2 feed lost").
//
// A stream is `live` while its path is ready and bytes keep arriving, `stalled` when it
// is ready but nothing has arrived for `stallPolls` polls (a frozen encoder), and `down`
// when it is gone. A new state must be seen on `confirmPolls` consecutive polls before it
// is reported, so a one-poll blip doesn't page the whole crew. The first reading of each
// stream is a silent baseline, never an alert.

export function createArenaWatcher({
  apiUrl, streams, pollMs = 1000, confirmPolls = 2, stallPolls = 4, fetchImpl = fetch, onChange = () => {},
}) {
  const items = streams.map(s => ({
    id: s.id ?? s.path, path: s.path, name: s.name ?? s.path, channel: s.channel ?? null,
    state: 'unknown', pending: null, pendingCount: 0, lastBytes: null, stalledFor: 0,
  }))
  let timer = null
  let failures = 0
  let monitorDown = false

  const snapshot = () => items.map(({ id, name, channel, state }) => ({ id, name, channel, state }))
  const text = (s, kind) => ({
    lost: `${s.name} feed lost`, restored: `${s.name} feed restored`, stalled: `${s.name} feed frozen`,
  })[kind]

  async function poll() {
    let list
    try {
      const r = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/v3/paths/list?itemsPerPage=1000`, { signal: AbortSignal.timeout(2000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      list = (await r.json()).items ?? []
    } catch {
      failures++
      // The monitor can't see the stream server: say so once, then keep quiet until it is back.
      if (failures === 5 && !monitorDown) {
        monitorDown = true
        onChange(snapshot(), [{ kind: 'monitor-offline', channel: null, text: 'Stream monitor offline' }])
      }
      return
    }
    const wasDown = monitorDown
    failures = 0
    monitorDown = false

    const byName = new Map(list.map(p => [p.name, p]))
    const events = []
    let changed = false
    for (const s of items) {
      const p = byName.get(s.path)
      let raw
      if (!p || !p.ready) {
        raw = 'down'; s.lastBytes = null; s.stalledFor = 0
      } else {
        const bytes = p.inboundBytes ?? p.bytesReceived ?? null
        if (bytes != null) {
          s.stalledFor = s.lastBytes != null && bytes <= s.lastBytes ? s.stalledFor + 1 : 0
          s.lastBytes = bytes
        }
        raw = s.stalledFor >= stallPolls ? 'stalled' : 'live'
      }
      if (raw === s.state) { s.pending = null; s.pendingCount = 0; continue }
      if (s.state === 'unknown') { s.state = raw; changed = true; continue } // silent baseline
      s.pendingCount = raw === s.pending ? s.pendingCount + 1 : 1
      s.pending = raw
      if (s.pendingCount < confirmPolls) continue
      const kind = raw === 'live' ? 'restored' : raw === 'down' ? 'lost' : 'stalled'
      s.state = raw; s.pending = null; s.pendingCount = 0; changed = true
      events.push({ kind, stream: s.id, channel: s.channel, text: text(s, kind) })
    }
    if (wasDown) events.unshift({ kind: 'monitor-online', channel: null, text: 'Stream monitor back online' })
    if (changed || events.length) onChange(snapshot(), events)
  }

  return {
    snapshot,
    poll,
    start() { if (!timer) { void poll(); timer = setInterval(() => void poll(), pollMs); timer.unref?.() } },
    stop() { if (timer) clearInterval(timer); timer = null },
  }
}
