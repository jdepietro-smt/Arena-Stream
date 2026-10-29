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

## Users, groups and channels (admin)

Who can talk or listen where is managed in the server's directory, not in the client or the config file.

- **Channels** have a name, colour and optional IFB flag. Their order is the order on every intercom.
- **Groups** grant `talk` and/or `listen` per channel. A user's rights are the union of their groups' grants,
  then optional per-user overrides (allow / deny) are applied on top.
- **Users** have a login, display name, title, groups, and an admin flag. Passwords are stored as scrypt hashes.

Open **`http://<server>:8900/admin`** and sign in as an administrator to manage all of it. Changes apply live:
connected clients get their new channel list immediately, rights that were removed stop working at once (the server
enforces them on every talk/listen change and, in SFU mode, on every media subscription), and a disabled or deleted
user is disconnected. Signing in on a second device signs the first one out. Failed logins are throttled.

First start: if no administrator exists the server creates `admin` and prints its password **once** (or uses
`COMMS_ADMIN_PASSWORD`). Change it in the admin page. Users, groups and channels are stored in
`server/data/directory.json` (back this file up; it is git-ignored). The channels/roles in `comms.config.json` are
only used to seed that file on first run.

`auth.mode` (or `COMMS_AUTH`): `accounts` (default; sign in with username + password) or `open` (anyone picks a name
and a self-join group, optional shared PIN; for trusted LANs and quick tests). Use TLS (wss/https) in front of the server for
anything beyond a trusted network, since passwords travel over the connection.

## Gateway (broadcast comms system ⇄ Arena channels)

`ui/comms-gateway` is a headless-style Electron app that joins Arena Comms as a normal user and bridges each
**port** between your comms system (Clear-Com, RTS, …) and one Arena channel:

- **Comms system → Arena:** a partyline has no push-to-talk, so each port keys its Arena channel with a voice
  detector (VOX: threshold, hang time, 30 ms look-ahead so first syllables aren't clipped). Everyone on the
  channel sees the gateway "talking" while it is keyed.
- **Arena → comms system:** everything said on the channel is mixed and sent out of the port.
- **Echo guard:** while Arena audio is going out, the port ignores what comes back in, to prevent loops when the
  matrix port isn't mix-minus.
- **Audio paths per port:**
  - *Audio interface:* any multichannel device the OS offers (analog/AES3 4-wire interfaces, **Dante Virtual
    Soundcard**, ASIO-to-WASAPI bridges). Map device input channel → Arena, Arena → device output channel.
  - *Network audio:* AES67-style RTP (L24/L16, 48 kHz, multicast or unicast, packet time 1 ms default) to and from
    a Dante-in-AES67-mode device or an IP card on the matrix. No PTP needed; clock drift is absorbed by a small
    receive buffer. Configure addresses/ports/payload type by hand (no SAP/SDP discovery yet).
  - *Test only:* 1 kHz test tone in, meters out, for commissioning.

Setup: in the admin page create a user for the gateway (e.g. `gateway-1`) and put it in groups that can **talk and
listen** on every channel it bridges (no access shows as a warning on the port). Run the server in **SFU** media
mode: the gateway needs each channel as its own track. Then start the gateway, enter server + credentials, add ports,
and tick *connect automatically*. One port per Arena channel per gateway.

Run: `npm run electron --prefix ui/comms-gateway`. Tests: `npm test --prefix ui/comms-gateway` (RTP codec + UDP loopback).
