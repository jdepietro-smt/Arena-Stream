# Arena Portal

Web side of Arena Link, added next to the existing server services (nothing is replaced):

- **Web links.** Share a live stream as a link that plays in any browser, with an expiry and an optional password. Links can be revoked at any time, and each open is logged.
- **Streams.** Live encoders from the directory: format, codec, bitrate, web viewers, links.
- **Previews.** A thumbnail per stream (and per decoder, showing what it plays) on the Streams and Decoders tabs; click one for live video. Live previews are limited to three at a time because each sends the full stream to the browser.
- **Decoders.** See every decoder PC running the Arena Link app and choose which stream each one plays out to SDI.

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
cd portal; node --test          # 12 tests with stand-ins for the directory and mediamtx
```

Standard library only (Node 18+), no `npm install`.
