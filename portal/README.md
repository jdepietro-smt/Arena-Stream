# Arena Portal

Web side of Arena Link, added next to the existing server services (nothing is replaced):

- **Web links.** Share a live stream as a link that plays in any browser, with an expiry and an optional password. Links can be revoked at any time, and each open is logged.
- **Streams.** Live encoders from the directory: format, codec, bitrate, web viewers, links.
- **Previews.** A thumbnail per stream (and per decoder, showing what it plays) on the Streams and Decoders tabs; click one for live video. Live previews are limited to three at a time because each sends the full stream to the browser.
- **Decoders.** See every decoder PC running the Arena Link app and choose which stream each one plays out to SDI.

## Admin section (owner only)

The Admin tab is for Admin accounts. Anyone else (a User account, or the shared password) has to give a second, owner-only password, and that unlock lasts 15 idle minutes (it slides while you work). It holds:

- **Account and security.** Change the everyday portal password and the owner password (both need the current owner password; either change, and "Sign out everywhere", signs every browser out). Recent sign-ins and failed attempts.
- **Settings.** Link address, relay delay for web viewers, live previews at once, thumbnails on or off and how often, default link expiry, and whether every link needs a password. They apply at once, no restart; a new relay delay is pushed to the mediamtx paths already in use.
- **Server health.** State of mediamtx, the relay, the directory, the share-link check, the portal, Comms, LiveKit and nginx; load, memory, disk (`/` and `/var/recordings`); directory and mediamtx reachability; web viewers. A Restart button per service (with a warning for the ones that carry streams).
- **Capacity test.** Finds how many 10 Mbps streams the server carries, from the server itself (so this site's internet connection is not the limit). `captest.js` makes a 20 s, 10 Mbps sample once, publishes N copies to the relay over loopback as `CT-1`..`CT-N`, and reads each back twice: over SRT through the relay like a decoder PC, and through a mediamtx path (RTSP) like a browser viewer. N ramps by a step; every second it samples system CPU, the load of the test generator (reported separately, so it can be left out), memory, network and the busiest processes. The page shows live tiles and a per-step table with a verdict. It stops by itself when CPU stays above a limit (default 90% for 8 s), free memory drops below 1 GB, readers fall behind or stall, or a live stream is affected; a Stop button and a 25 minute hard limit also apply. It refuses to start while live streams are on air unless you allow it. The result gives the server-side CPU per stream (a least-squares fit over the clean steps) and the stream count at 70% of all cores. It does not exercise WebRTC encryption, which browser viewers add on top. The synthetic streams are not announced to the directory, so decoders and the Streams tab never see them. The runner starts through the root helper as its own transient service (`arena-captest`, low priority, 2 GB memory limit), so the portal's CPU limit does not hold it back. By hand: `node /opt/arena-portal/captest.js --streams 20 --step 2`.
- **Activity and links.** Every sign-in, link created, revoked or opened (with the viewer's address), decoder change, setting change and restart, filterable; and all links with views, distinct viewers and last view.

Restarts: the portal runs as an unprivileged user, so it leaves the service name in `/var/lib/arena-portal/ctl/request`; `arena-portal-ctl.path` runs `ctl.sh` as root, which restarts it only if the name is on a fixed list. Settings, the passwords (hashed with scrypt), the session epoch and the activity log live in `/var/lib/arena-portal/admin.json`.

- **Portal users.** Named accounts, each with its own username and password (letters in any case; at least 10 characters), added, re-passworded, given a role and deleted from Account and security. A role is **Admin** or **User**. An Admin account opens this Admin area straight away, with no second password. A User account, and anyone using the shared portal password, can use the rest of the portal and must give the owner password to open this area. Accounts saved before roles existed count as Admin. Changing a password or deleting an account signs that person out; an Admin account changes passwords with its own password. The shared portal password keeps working until you turn it off (it cannot be turned off while there are no accounts, or when it would remove the last one). Sign-ins and opens in the activity log carry the username. **Profiles:** each account can have a full name and an email address (both optional; the email must look like one). An Admin sets them for anyone with Edit profile, or when adding the account; each signed-in account edits its own by clicking its name (shown top right instead of the username) in the page header. `add-user.js` takes `--name` and `--email`.

Accounts from the server, with no typing of passwords: `node /opt/arena-portal/add-user.js <username>` creates an Admin account (`--role user` for a plain user) with a generated lowercase password it prints once (an existing account is left alone; `--reset` gives a new password). `bash portal/deploy/install.sh <username>` does the same as part of an install or update. Both stop the portal for a moment, because it holds its data in memory.

Lost the owner password? On the server: `node /opt/arena-portal/reset-owner.js` prints a new one, signs everyone out and turns shared sign-in back on.

## How a web link plays

```
encoder --SRT--> relay :8895 --SRT (read)--> mediamtx (path portal_<name>_<tag>, on demand)
                                                 |  WebRTC (WHEP), proxied by the portal
                                                 v
browser  <--- /w/<link id>  (portal checks: link active, not expired, password)
```

The portal creates the mediamtx path on first use and mediamtx closes it 15 s after the last viewer leaves. The browser talks to the portal, never to mediamtx directly; the media path name carries a secret tag so it cannot be guessed. Expect roughly 150 to 300 ms more delay than the SDI path.

Thumbnails: while the admin page is open, the portal runs one `ffmpeg` per stream that reads the SRT relay, decodes key frames only, and writes a 480 px JPEG every few seconds (`lib/thumbs.js`). A worker stops about 25 s after the page stops asking. It needs an `ffmpeg` with SRT support (the Ubuntu package has it; the installer checks). The first picture appears after the first key frame, typically within 10 s.

Browser limits: H.265 streams cannot be played (the portal says so and the Streams tab flags them); use H.264 in the encoder. Interlaced H.264 plays but depends on the browser's decoder.

## Remote decoder control

The Arena Link app (decoder side) sends a heartbeat to the directory every 4 s. The portal asks the directory to tell a decoder to play a stream; the app applies it like a click and saves it as the decoder's stream. The first reply after the app starts is only recorded, so an old request is never replayed. Requests for an offline decoder are kept for 10 minutes. Directory calls:

| Call | Purpose |
|---|---|
| `POST /v1/decoder/heartbeat` | decoder reports `{id, name, host, state, stream}`; reply holds the pending `want` |
| `POST /v1/decoder/want` | `{id, stream}`; `""` disconnects |
| `GET /v1/decoders` | decoders seen in the last 20 s |

## Install on the server

```
cd /opt/arena-stream; git pull; bash portal/deploy/install.sh
```

It updates the directory (adds the decoder calls; the access key is kept), installs the `arena-portal` service on `127.0.0.1:8910`, and adds `/portal/` and `/w/` to the nginx sites that serve the dashboard (backups kept as `*.pre-portal`, rolled back on any nginx error). It prints the portal address and the admin password. Re-running keeps the password, secret and links.

- Admin: `https://<server>/portal/` (https only; plain http is redirected).
- Links: `http://<server>/w/<id>` by default, so viewers do not get a certificate warning. Set `PORTAL_PUBLIC_BASE` in `/etc/arena-portal/env` (for example to `https://stream.example.com`) once there is a domain, then `systemctl restart arena-portal`.
- Open TCP 80 and 443 in the Hetzner Cloud firewall. Browser WebRTC media uses mediamtx's existing UDP 8889.

Settings live in `/etc/arena-portal/env`; links and the view log in `/var/lib/arena-portal/portal.json`.

## Development

```
cd portal; node --test          # 45 tests with stand-ins for the directory and mediamtx
```

Standard library only (Node 18+), no `npm install`.
