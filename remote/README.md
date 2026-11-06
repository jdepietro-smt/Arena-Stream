# Arena Remote

Secure, low-latency remote desktop for the Arena suite. Sign in, pick one of your computers, and operate it
with 60 fps video, system audio, mouse and keyboard.

- `server/` — accounts, host registry and WebRTC signaling (Node, `ws`). It never carries media or input.
- `app/` — Electron app. One build is both the **host** ("Share this computer") and the **viewer** ("Connect to a computer").

## Run it

```bash
cd remote/server && npm i && node server.js add-user alice "a long passphrase"   # 10+ chars
node server.js                                                                    # :8950
cd ../app && npm i && npm start
```

Sign in on both machines, open **Share this computer** on the one to be controlled, register it, pick the screen and
press Start sharing. On the other machine choose it under **Connect to a computer**.
Server env: `REMOTE_PORT`, `REMOTE_TLS_CERT`/`REMOTE_TLS_KEY`, `REMOTE_SECRET`, `REMOTE_DATA`,
`REMOTE_TURN_URLS` + `REMOTE_TURN_SECRET` (coturn `use-auth-secret`, ephemeral credentials are issued per login).
Outside a trusted LAN put TLS in front (the app refuses plain `http://` to non-LAN servers).

## How it gets 60 fps at low latency

Chromium WebRTC end to end: hardware H.264 encode/decode, `contentHint=motion` plus `maintain-framerate` (drop
resolution before frames), encoder start-bitrate hints in the SDP (no slow ramp from 300 kbps), viewer jitter buffer
and playout delay forced to 0, input on an unordered no-retransmit data channel, mouse moves coalesced per frame.
The viewer's **Stats** overlay shows fps, bitrate, RTT, jitter buffer, decode time. Loopback measurement on the RTX 4000 Ada
box: 1920x1080 at about 57 fps, jitter buffer 8 ms, decode 1.1 ms.

## Security model

- **Media and input are end to end** (DTLS-SRTP / DTLS data channels). The server only relays SDP/ICE.
- **The server cannot MITM a session.** Every host has an Ed25519 key (encrypted at rest with Windows DPAPI, never
  leaves the main process). The host id is the hash of that key. The host signs both DTLS fingerprints of each session;
  the viewer verifies that signature and aborts otherwise. Viewers pin each host's key on first use, show its
  Computer ID to compare out of band, and warn loudly if it changes.
- **Host authentication** is a signed server challenge; viewers use a signed 12 h token. Passwords are scrypt, logins are throttled.
- **Consent by default:** the host person approves every connection (view only / control / deny). Optional
  unattended mode instead requires a passcode (scrypt, throttled) verified over the encrypted channel; until then the
  capture tracks stay disabled.
- **Host kill switch** `Ctrl+Alt+Shift+End` ends any session and releases held keys; "Revoke control" does the same live.
- **Sandboxed UI:** renderer has no Node, strict CSP, context isolation; the only privileged calls are a narrow
  preload API, accepted only from our own window. Input events are validated, rate-limited (2000/s) and dropped
  unless control was granted. Remote users can only reach computers owned by their account.

## Elevated access: UAC, admin windows, sign-in screen (`service/`)

A user-session app cannot capture or type into the secure desktop. `service/` (C#, .NET 9) is a Windows service that keeps a
SYSTEM helper alive in the console session. The helper attaches to whichever desktop has input (Default, Winlogon, screensaver),
so it injects input into UAC prompts and elevated windows, and streams JPEG frames of the secure desktop (about 20 fps, a fallback
only) that the host app swaps into the same video sender, then switches back to the 60 fps screen track. The host app uses it
automatically when present (the status line shows "elevated access on") and falls back to local injection when not.

Easiest: run the installer (below), which installs the app to Program Files and registers this service. Manual install from an elevated PowerShell: `service\install.ps1 -ClientExe "C:\Program Files\Arena Remote\Arena Remote.exe"`; remove with `-Uninstall`.
Because the helper is SYSTEM, only the installed app may talk to it: the pipe client's executable must equal the registered path under
Program Files and run in the same session. Residual risk: malware running as the same user could inject into the app itself,
so sign the installer and keep per-session consent and `Ctrl+Alt+Shift+End` as the safety net.
Development: `ArenaRemoteService.exe helper --dev` runs unelevated and skips the path check (the service never uses it);
`cd app && node --test` exercises the pipe protocol, frame capture and input against a dev helper.

## Installer

`cd app && npm run dist` publishes the helper and builds `app/dist-installer/Arena Remote Setup <version>.exe` (NSIS, per-machine, asks for admin).
It installs to `C:\Program Files\Arena Remote`, registers the `ArenaRemoteHelper` service pointing at that exact executable, and the uninstaller removes both.
If a build fails with "cannot access app.asar", a previous run still holds it open: change `directories.output` or reboot.

## Known gaps (next)

1. **Signing and icon:** the installer is unsigned (Windows SmartScreen will warn) and uses the default Electron icon; add a code-signing certificate and an icon, and slim the 73 MB self-contained helper (trim/AOT).
2. Control input is covered by the helper test (moves the real cursor); the full viewer-to-host control path across two machines is not yet exercised.
3. Clipboard sync and file transfer (off by design until we add per-session toggles), multi-monitor switching mid-session,
   viewer-side local cursor rendering, HEVC/AV1 and 10-bit, a gamepad channel, and mac/Linux hosts.
4. Sharing a computer with other accounts (currently owner only), audit log with retention, signed installers (electron-builder).
