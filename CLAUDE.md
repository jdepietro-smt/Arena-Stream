# CLAUDE.md — Context Brief for Claude Code

This file is read automatically by Claude Code when run from this directory.
It hands off the context of the prior Cowork session that created this
scaffold, so you (Claude Code) can continue the work without the user
having to re-explain everything.

---

## What this project is

End-to-end SDI → SRT → SDI streaming system. Ingests video+audio from
either a Blackmagic DeckLink or AJA Kona/Corvid/Io PCIe capture card,
encodes H.264 or HEVC with low-latency settings, transports over SRT,
and plays back to SDI on the receiver side.

## User's hard requirements

- **Both capture vendors supported** — Blackmagic AND AJA. Not one or the other.
- **Glass-to-glass latency target: 300–350ms**, hard ceiling 500ms.
- **Transport: SRT** (not RTMP, not NDI, not RIST).
- **Audio must stay attached** — embedded SDI audio carries through the pipeline with correct lip sync.
- **Production-track.** Scaffold exists today; needs to become a deployable product.

## Current state (as of handoff)

A Cowork session produced the scaffold you see in this directory. Two
parallel build paths exist:

**Path A — GStreamer pipelines (`pipelines/`).** Working shell scripts:
`send-blackmagic.sh`, `send-aja.sh`, `receive.sh`, `srt-stats.sh`, shared
config in `common.env` and helpers in `_lib.sh`. These pass `bash -n`
syntax checks but have **not yet been executed against real hardware**.

**Path B — Native C++ skeleton (`cpp/`).** Structured abstraction with a
`CaptureDevice` interface implemented by `DeckLinkDevice` and `AJADevice`
stubs, libavcodec-based encoder, libsrt-based output, bounded MPSC frame
queue, CMake build. **Will not compile as-is** — vendor SDK call sites
are marked `// TODO: real SDK call` and need Blackmagic DeckLink SDK +
AJA NTV2 SDK to be installed and the SDK calls written in.

Containerized deploy (`docker/`) and docs (`docs/architecture.md`,
`docs/latency-tuning.md`, `IMPLEMENTATION_PLAN.md`) are in place.

## What to do when the user says "keep going"

Work through the phases in `IMPLEMENTATION_PLAN.md` in order. The most
likely next step is Phase 0/1 — get a loopback running on real hardware.
That means:

1. Detect what capture hardware is installed (`lspci | grep -i -E 'blackmagic|aja'`).
2. Confirm drivers are loaded (`lsmod | grep -E 'blackmagic|ajantv2'`, check `/dev/blackmagic` or `/dev/ajantv2`).
3. If drivers are missing, install them (Blackmagic: download Desktop Video .deb from blackmagicdesign.com; AJA: clone and build https://github.com/aja-video/libajantv2 and load the kernel module).
4. Install GStreamer 1.22+ with `gst-plugins-bad`, `-good`, `-ugly`, `libav`, plus `libsrt` and `srt-tools`. Stock Ubuntu 22.04 packages 1.20 which is too old for some SRT props — use the GStreamer PPA.
5. For AJA: `ajantv2src` is NOT in stock packages. Build `gst-plugins-bad` from source with `-Daja=enabled` against libajantv2. ~15 min build.
6. Verify with `gst-inspect-1.0 decklinkvideosrc` and `gst-inspect-1.0 ajantv2src`.
7. Run `./pipelines/send-blackmagic.sh` (or `send-aja.sh`) and iterate on errors.

If the user provides access to hardware, the work is entirely software
installs + running the pipelines + reading errors + tuning. You can do
all of that.

## What to do when the user says "fill in the C++ SDK stubs"

The two files that need work are:

- `cpp/src/decklink_device.cpp` — replace `// TODO: real SDK call` sections with actual DeckLink API calls. The comments inside already sketch the correct API call sequence (`CreateDeckLinkIteratorInstance` → `QueryInterface IDeckLinkInput` → install callback → `EnableVideoInput` → `EnableAudioInput` → `StartStreams`). The input callback class needs to implement `IDeckLinkInputCallback::VideoInputFrameArrived` and `VideoInputFormatChanged`. See the reference implementation comment block at the bottom of that file.

- `cpp/src/aja_device.cpp` — replace TODOs with CNTV2Card calls. Unlike DeckLink, AJA has no SDK callback; a thread runs a loop with `WaitForInputVerticalInterrupt` + `AutoCirculateTransfer`. The reference call sequence is in the comments.

To build after filling in stubs:
```bash
cmake -S cpp -B cpp/build \
  -DDECKLINK_SDK_DIR=/opt/blackmagic/include \
  -DAJA_NTV2_DIR=/opt/aja/ntv2
cmake --build cpp/build -j$(nproc)
```

You'll also need `libsrt-openssl-dev`, `libavcodec-dev`, `libavformat-dev`,
`libswscale-dev`, `libswresample-dev`, and a compiler with C++20 support
(GCC 11+ or Clang 14+).

## Latency budget (for reference when tuning)

| Stage                  | Budget    |
|------------------------|-----------|
| Capture + convert      | 20–30ms   |
| Encoder (NVENC ll)     | 15–25ms   |
| SRT latency window     | 120–200ms |
| Decoder                | 15–25ms   |
| Output buffer          | 20–30ms   |

SRT latency window is the big knob. Rule: ≥ 4× measured RTT. Use
`./pipelines/srt-stats.sh` to read live RTT.

## Known gotchas (will bite you if you're not watching)

1. **SRT latency units** — `srtsink latency` property is milliseconds; URI form `?latency=` is microseconds. Off-by-1000 is common.
2. **NVENC session cap** — consumer cards (GTX/RTX non-Ada) cap at 3 concurrent sessions. Quadro/RTX Ada has no cap.
3. **10-bit** — NVENC only supports 10-bit in HEVC Main10, not H.264. If the user wants 10-bit end-to-end, `CODEC=h265` in common.env.
4. **AAC audio adds 60–120ms** — user wants low latency, so default is `AUDIO_MODE=opus`. For contribution-grade, `AUDIO_MODE=pcm` (SMPTE 302M).
5. **Format change mid-stream** — current scripts don't handle this. Phase 2 work. Needs a supervisor process that detects format-changed signal and restarts the pipeline.
6. **Firewalls eat SRT** — SRT is UDP. Corporate firewalls often rate-limit it. If connect fails intermittently, check that before suspecting code.

## Don't do these without asking

- Don't `apt install` Blackmagic drivers without confirming the user wants a specific version — they ship new ones quarterly and broadcast shops often pin versions.
- Don't modify `IMPLEMENTATION_PLAN.md` or `docs/*` unless the user asks — those are reference artifacts, not work products.
- Don't commit anything. There's no git repo here yet; if the user wants one, ask whether they want an existing remote or a fresh one.

## Style notes from the prior session

- The prior session wrote prose-heavy docs with minimal bullet points in user-facing messages. Match that tone in chat replies unless the user prefers bullets.
- The user tends to be direct (one memorable message: "NO. YOU DO IT ALL"). They value action over caveats. Do the work, then report; don't ask permission for obviously-needed steps like `apt update`.
- They are explicitly uninterested in the limitations of the assistant — "here is what I cannot do" is not a useful answer. When you truly cannot do something (physical hardware), state it once, then pivot to what you CAN do.

## Repo structure at handoff

```
sdi-streaming/
├── CLAUDE.md                    ← this file
├── README.md                    Orientation doc for humans
├── IMPLEMENTATION_PLAN.md       5 phases, exit criteria, estimates
├── pipelines/                   Path A — GStreamer (works, untested on hw)
│   ├── _lib.sh
│   ├── common.env
│   ├── send-blackmagic.sh
│   ├── send-aja.sh
│   ├── receive.sh
│   └── srt-stats.sh
├── cpp/                         Path B — native SDK (skeleton, TODOs)
│   ├── CMakeLists.txt
│   ├── include/
│   │   ├── frame.h
│   │   ├── frame_queue.h
│   │   ├── capture_device.h
│   │   ├── decklink_device.h
│   │   └── aja_device.h
│   └── src/
│       ├── capture_device.cpp   (backend factory)
│       ├── frame_queue.cpp
│       ├── decklink_device.cpp  ← fill in SDK calls
│       ├── aja_device.cpp       ← fill in SDK calls
│       ├── encoder.cpp          (libavcodec NVENC wrapper)
│       ├── srt_output.cpp       (libavformat SRT wrapper)
│       └── main.cpp             (harness — worker threads are TODO)
├── docker/
│   ├── docker-compose.yml
│   ├── Dockerfile.sender
│   └── Dockerfile.receiver
└── docs/
    ├── architecture.md
    └── latency-tuning.md
```
