// LiveKit adapter. The comms server owns *who may hear whom*; LiveKit only
// forwards media. Clients join LiveKit with auto-subscribe off, publish one
// audio track per channel they may talk on (named `ch:<id>`) plus a `direct`
// track, and this server calls updateSubscriptions() so a listener only ever
// receives tracks of channels it listens to (or a direct call aimed at it).

import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'

export function createLiveKit({ url, apiUrl, apiKey, apiSecret, room = 'arena' }) {
  const rooms = new RoomServiceClient(apiUrl || url.replace(/^ws/, 'http'), apiKey, apiSecret)
  return {
    url,
    async token(peer) {
      const at = new AccessToken(apiKey, apiSecret, { identity: peer.id, name: peer.name, ttl: '12h' })
      at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false })
      return at.toJwt()
    },
    /** Authoritative track list for a participant, read from LiveKit (never from the client). */
    async listTracks(identity) {
      const p = await rooms.getParticipant(room, identity)
      return (p.tracks ?? []).map(t => ({ name: t.name, sid: t.sid }))
    },
    updateSubscriptions(identity, trackSids, subscribe) {
      return rooms.updateSubscriptions(room, identity, trackSids, subscribe)
    },
  }
}
