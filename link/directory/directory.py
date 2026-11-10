#!/usr/bin/env python3
"""Arena Link directory: live list of encoders. Standard library only.

  POST /v1/announce   encoder heartbeat (JSON body), needs X-Arena-Key
  GET  /v1/encoders   live encoders + the caller's public IP, needs X-Arena-Key

Remote decoder control (used by the web portal and the Arena Link app):
  POST /v1/decoder/heartbeat  a decoder reports {id, name, host, state, stream}; the reply carries the
                              stream someone asked it to play: {"want": {"stream": "...", "seq": N} | null}
  POST /v1/decoder/want       {id, stream} asks decoder `id` to play `stream` ("" = disconnect)
  GET  /v1/decoders           decoders seen in the last DEC_TTL seconds, with their pending request

Entries expire TTL seconds after their last announce. No stream data passes
through here.
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TTL = float(os.environ.get("LINK_TTL", "4"))
KEY = os.environ.get("LINK_KEY", "")
PORT = int(os.environ.get("LINK_PORT", "8002"))
RELAY_SECRET = os.environ.get("LINK_RELAY_SECRET", "")
TRUST_PROXY =os.environ.get("LINK_TRUST_PROXY") == "1"
DEC_TTL = float(os.environ.get("LINK_DEC_TTL", "20"))
WANT_KEEP = 600.0   # a request for an offline decoder is kept this long, so it is applied when the decoder returns
MAX_BODY = 8192
FIELDS = ("id", "name", "format", "source", "codec", "kbps", "lanIps", "directPort", "relay", "version")

_lock = threading.Lock()
_encoders = {}   # id -> {announce fields..., pubIp, seen}
_decoders = {}   # id -> {name, host, state, stream, pubIp, seen}
_wants = {}      # decoder id -> {stream, seq, at}
_want_seq = 0


def _client_ip(h):
    # Only behind a reverse proxy (LINK_TRUST_PROXY=1) is the first X-Forwarded-For hop the
    # caller; exposed directly, that header is client-controlled and must be ignored.
    fwd = h.headers.get("X-Forwarded-For") if TRUST_PROXY else None
    return fwd.split(",")[0].strip() if fwd else h.client_address[0]


def _live(now):
    for k in [k for k, v in _encoders.items() if now - v["seen"] > TTL]:
        del _encoders[k]
    return [{**{f: v.get(f) for f in FIELDS}, "pubIp": v["pubIp"], "ageMs": int((now - v["seen"]) * 1000)}
            for v in _encoders.values()]


def _live_decoders(now):
    for k in [k for k, v in _decoders.items() if now - v["seen"] > DEC_TTL]:
        del _decoders[k]
    for k in [k for k, w in _wants.items() if now - w["at"] > WANT_KEEP]:
        del _wants[k]
    out = []
    for k, v in _decoders.items():
        w = _wants.get(k)
        out.append({"id": k, "name": v["name"], "host": v["host"], "state": v["state"], "stream": v["stream"],
                    "pubIp": v["pubIp"], "ageMs": int((now - v["seen"]) * 1000),
                    "want": {"stream": w["stream"], "seq": w["seq"]} if w else None})
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        if KEY and self.headers.get("X-Arena-Key") != KEY:
            self._send(401, {"error": "bad key"})
            return False
        return True

    def do_POST(self):
        if self.path not in ("/v1/announce", "/v1/decoder/heartbeat", "/v1/decoder/want"):
            return self._send(404, {"error": "not found"})
        if not self._authed():
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(400, {"error": "bad body"})
        if self.path != "/v1/announce":
            return self._decoder_post(n)
        try:
            msg = json.loads(self.rfile.read(n))
            eid = str(msg["id"])[:64]
            if not eid or not str(msg.get("name", "")).strip():
                raise ValueError("id and name required")
        except (ValueError, KeyError, TypeError) as e:
            return self._send(400, {"error": str(e)})
        entry = {f: msg.get(f) for f in FIELDS}
        entry["id"] = eid
        entry["pubIp"] = _client_ip(self)
        entry["seen"] = time.time()
        with _lock:
            _encoders[eid] = entry
        self._send(200, {"ok": True, "yourIp": entry["pubIp"]})

    def _decoder_post(self, n):
        global _want_seq
        try:
            msg = json.loads(self.rfile.read(n))
            did = str(msg["id"])[:64]
            if not did:
                raise ValueError("id required")
        except (ValueError, KeyError, TypeError) as e:
            return self._send(400, {"error": str(e)})
        now = time.time()
        if self.path == "/v1/decoder/want":
            stream = str(msg.get("stream", ""))[:128]
            with _lock:
                _want_seq += 1
                _wants[did] = {"stream": stream, "seq": _want_seq, "at": now}
                w = _wants[did]
            return self._send(200, {"ok": True, "want": {"stream": w["stream"], "seq": w["seq"]}})
        with _lock:
            _decoders[did] = {"name": str(msg.get("name", did))[:80], "host": str(msg.get("host", ""))[:80],
                              "state": str(msg.get("state", ""))[:20], "stream": str(msg.get("stream", ""))[:128],
                              "pubIp": _client_ip(self), "seen": now}
            w = _wants.get(did)
            want = {"stream": w["stream"], "seq": w["seq"]} if w else None
        self._send(200, {"ok": True, "want": want})

    def do_GET(self):
        if self.path == "/v1/decoders":
            if not self._authed():
                return
            with _lock:
                live = _live_decoders(time.time())
            return self._send(200, {"decoders": live})
        if self.path == "/v1/config":
            # Same access key as everything else; lets encoders pick up the relay passphrase
            # without it being baked into the installer.
            if not self._authed():
                return
            return self._send(200, {"relaySecret": RELAY_SECRET})
        if self.path != "/v1/encoders":
            return self._send(404, {"error": "not found"})
        if not self._authed():
            return
        with _lock:
            live = _live(time.time())
        self._send(200, {"yourIp": _client_ip(self), "encoders": live})


if __name__ == "__main__":
    if not KEY:
        print("WARNING: LINK_KEY unset - directory is open to anyone")
    print(f"arena-link directory on :{PORT}, ttl {TTL}s")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
