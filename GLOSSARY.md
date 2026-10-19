# Arena Stream

Captures SDI video and audio from broadcast cards, encodes it, and sends it to a relay server over SRT, with a local preview alongside.

## Language

**Channel**:
One SDI input on a capture card, handled as its own capture and its own stream.
_Avoid_: Port, source, device

**Preview**:
The local, uncompressed view of a channel shown in the app. Never what viewers receive.
_Avoid_: Monitor, thumbnail

**Stream**:
A channel's encoded output while it is live to a destination.
_Avoid_: Feed, broadcast

**Relay**:
The server that receives published streams and redistributes them.
_Avoid_: Server (alone), hub

## Encoding

**Encoder**:
A concrete video encoder implementation, such as `h264_nvenc` or `libx264`. Use "encoder" for the thing that does the work and "codec" only for the video format.
_Avoid_: Codec (when you mean the implementation)

**Encoder request**:
What the user asks for: GPU, CPU, or a specific encoder by name. GPU and CPU are intents, not encoders.
_Avoid_: Codec choice, codec setting

**Candidate chain**:
The ordered list of encoders tried for an encoder request, always ending in an encoder that needs no special hardware.
_Avoid_: Fallback list, priority list

**Destination kind**:
Which transport family a stream is going to (MPEG-TS over SRT or UDP, or RTP/RTSP). It decides which encoders can be used at all.
_Avoid_: Output type, protocol

**Codec policy**:
The single rule set that turns an encoder request and a destination kind into a candidate chain.
_Avoid_: Codec selection, codec logic
