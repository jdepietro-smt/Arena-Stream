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
