# Arena Link — design

Goal: any encoder instance, anywhere, shows up in any decoder automatically.
Encoder → decoder delay (capture to decoded frame) ≤ 300–350 ms, on a LAN or
across the internet.

## Parts

1. **Directory** (`link/directory/`, runs on the server). Encoders announce
   themselves every second; decoders read the live list. Entries expire 4 s
   after the last announce. No stream data passes through it.
2. **Encoder** (capture → NVENC → SRT). Always listens for a direct SRT
   connection. Also publishes to the relay when remote viewers are allowed.
3. **Relay** (`cpp/relay/srt_relay.cpp`, already built). Pass-through SRT fan-out:
   no demux or remux, so it adds only its own SRT window. Used when decoder and
   encoder are not on the same network.
4. **Decoder** (SRT → hardware decode → SDI/preview). Polls the directory, lists
   encoders, picks the best path per encoder automatically.

## Discovery and path choice

- Encoder announces `{id, name, format, codec, kbps, lanIps[], directPort,
  relay{port,name}}`. The directory records the announcer's public IP.
- Decoder asks the directory for the list and learns its own public IP.
  - Same public IP as the encoder → LAN path: SRT caller to `lanIp:directPort`
    (window ~20–40 ms, expected total 100–150 ms).
  - Different public IP → relay path: `read:<name>` on the lane.
- If the chosen path fails to connect within 2 s, the decoder tries the other.

## Latency budget (internet path, 72 ms RTT to server)

| Stage | ms |
|---|---|
| Capture + convert + NVENC | 25 |
| Encoder → relay (one-way + window) | ~36 + window |
| Relay → decoder (one-way + window) | ~36 + window |
| Hardware decode + output | 15 |

With windows of 80 ms each the total is about 270 ms plus the SRT receive-side
holdback, i.e. 330–350 ms. Windows below ~RTT×1.5 lose packets on a lossy link,
so the real fix for lower delay is a relay closer to both ends, not smaller
windows. Window is a setting, not a constant.

## Rules for the build

- One wire format everywhere: MPEG-TS, H.264/HEVC no B-frames, Opus audio,
  latency stamp SEI (already in `latency_stamp.h`).
- Progressive and interlaced sources are carried at their native rate. No
  silent halving of frame rate.
- Every stage reports its own timing; the decoder shows the breakdown and has a
  one-click "copy report".
- Nothing ships without a measured test against a reference.

## Redundancy and error protection

Two independent protections for the internet path, used together or alone:

- **Two relays at once (hitless).** An encoder given two relays (`--relay A,B`) sends the stream to both. A decoder that finds two
  relays in the announce reads both and merges them first-copy-wins (`path_dedupe.h`): a healthy pair costs no extra delay (measured
  identical to one path), and if either relay or its network path fails the picture carries on from the other with no gap while the
  failed one reconnects in the background. If the first relay is down when the decoder starts, it starts on the second. Costs a full
  second copy of the encoder's uplink and of the decoder's download.
- **Forward error correction (FEC) per hop.** SRT's packet filter adds parity packets so a receiver rebuilds lost packets instead of
  waiting a round trip for a resend. `light` (cols 10, rows 1, about 10% extra) repairs scattered single losses; `standard` (10 x 5,
  about 30% extra) also repairs bursts. Measured at 3% random loss, retransmissions fell from 2.7% to 0.9% (light) and 0.0%
  (standard); with bursts of 5 lost packets, light does nothing and standard repairs them all. Each hop is protected on its own
  (encoder to relay: `--relay-fec`; relay to decoder: `--fec`). The setting rides in the SRT stream id (`read:NAME~fec=light`), so
  programs that do not send it get no FEC and keep working; the relay must be the new build to accept it.
  The encoder's send-rate cap is raised to leave room for the parity packets, otherwise the queue backs up (measured +900 ms).
