#!/usr/bin/env python3
"""Arena Link directory: live list of encoders. Standard library only.

  POST /v1/announce   encoder heartbeat (JSON body), needs X-Arena-Key
  GET  /v1/encoders   live encoders + the caller's public IP, needs X-Arena-Key

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
MAX_BODY = 8192
FIELDS = ("id", "name", "format", "source", "codec", "kbps", "lanIps", "directPort", "relay", "version")

_lock = threading.Lock()
_encoders = {}   # id -> {announce fields..., pubIp, seen}


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
        if self.path != "/v1/announce":
            return self._send(404, {"error": "not found"})
        if not self._authed():
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(400, {"error": "bad body"})
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

    def do_GET(self):
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
