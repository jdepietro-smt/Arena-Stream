# Arena Comms

Network-based broadcast intercom for the Arena suite (party lines, direct calls, call signal).

- `server/` — Node signaling + presence + routing-state server (`npm start`, port 8900).
  Copy `comms.config.example.json` to `comms.config.json` to set channels, roles, PIN and ICE/TURN servers.
  Env overrides: `COMMS_PORT`, `COMMS_PIN`, `COMMS_ICE` (JSON), `COMMS_CONFIG`.
- `../ui/comms-app/` — Electron + React client (`npm run electron`).

Audio is Opus over WebRTC in a peer mesh; each sender gates its audio per peer from the shared
talk/listen state. Mesh suits roughly 20 users per production; an SFU is the next step beyond that.
For users across NATs, add a TURN server (coturn) to `iceServers`.

## Program feed + IFB

- **Program feed:** set `program.whepUrl` in the server config (optionally limit with `program.roles`) to a
  WHEP endpoint, e.g. an Arena mediamtx stream at `http://<server>:8889/<stream>/whep`. Each client plays it
  in its headset with its own volume/mute and level meter. A user can override the URL at join time.
- **IFB:** mark a channel `"ifb": true` (optional `"duck"`, linear gain 0–1, default 0.15). While anyone talks on
  an IFB channel a user listens to, that user's program feed ducks (fast attack, 400 ms hold, slow release).

## Media modes: mesh vs SFU (+ TURN)

`media.mode` in the server config picks the transport; the UI is identical.

- `mesh` (default): direct WebRTC between clients. Zero extra services; fine for ~20 users on a LAN/VPN.
- `sfu`: every client joins one LiveKit room. Each publishes one Opus track per channel it may talk on
  (`ch:<id>`, silent and ~10 B/s via DTX unless talking) plus a `direct` track. The **comms server** tells
  LiveKit which tracks each listener may receive (listen set + role access; direct tracks only while a
  direct call targets them), so channel privacy is enforced server-side and uplink stays at one stream per
  active channel. LiveKit's built-in TURN covers clients behind strict NATs/firewalls.

Local test: `livekit-server --dev` (keys `devkey`/`secret`), then set `media.mode` to `sfu` as in the example.
Production: see `deploy/` (LiveKit + TURN template and docker-compose); open the ports listed there.
