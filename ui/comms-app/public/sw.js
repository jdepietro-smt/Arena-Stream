// Arena Comms web app: lets it be installed on a phone and open its screens when the network is poor.
// Network first, so an update is picked up straight away; the saved copy is only used when the network fails.
// Only files of the app itself are saved (never the intercom's own traffic).
const CACHE = 'arena-comms-shell-v1'
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))
self.addEventListener('fetch', e => {
  const r = e.request
  if (r.method !== 'GET' || !r.url.startsWith(self.registration.scope)) return
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)).catch(() => {}) }
    return res
  }).catch(async () => (await caches.match(r)) || (await caches.match(self.registration.scope)) || Response.error()))
})
