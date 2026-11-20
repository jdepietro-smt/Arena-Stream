#!/usr/bin/env python3
"""Arena Link directory: live list of encoders. Standard library only.

  POST /v1/announce   encoder heartbeat (JSON body), needs X-Arena-Key
  GET  /v1/encoders   live encoders + the caller's public IP, needs X-Arena-Key

Remote decoder control (used by the web portal and the Arena Link app):
  POST /v1/decoder/heartbeat  a decoder reports {id, name, host, state, stream}; the reply carries the
                              stream someone asked it to play: {"want": {"stream": "...", "seq": N} | null}
  POST /v1/decoder/want       {id, stream} asks decoder `id` to play `stream` ("" = disconnect)
  GET  /v1/decoders           decoders seen in the last DEC_TTL seconds, with their pending request

Remote encoder control (used by the web portal and the Arena Link app on an encoder PC):
  POST /v1/host/heartbeat   an encoder PC reports {id, name, host, streams:[{sid,name,state,bitrate,...}], ack, results};
                            the reply carries commands nobody has acknowledged yet:
                            {"commands": [{"seq": N, "stream": sid, "action": "start|stop|restart|bitrate", "value": .., "ageMs": ..}]}
  POST /v1/host/command     {host, stream, action, value} queues a command for that PC (it must be connected now)
  GET  /v1/hosts            encoder PCs seen in the last HOST_TTL seconds: their streams, pending commands, recent results
A command is dropped once the PC acknowledges it (ack = highest seq it handled) or after CMD_KEEP seconds. The app ignores
commands older than two minutes, so a PC that comes back late never starts something nobody wants any more.

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
HOST_TTL = float(os.environ.get("LINK_HOST_TTL", "20"))
CMD_KEEP = 180.0
ACTIONS = ("start", "stop", "restart", "bitrate")
MAX_BODY = 16384
FIELDS = ("id", "name", "format", "source", "codec", "kbps", "lanIps", "directPort", "relay", "relays", "version")

_lock = threading.Lock()
_encoders = {}   # id -> {announce fields..., pubIp, seen}
_decoders = {}   # id -> {name, host, state, stream, pubIp, seen}
_wants = {}      # decoder id -> {stream, seq, at}
_want_seq = 0
_hosts = {}      # host id -> {name, host, streams, pubIp, seen, results}
_cmds = {}       # host id -> [{seq, stream, action, value, at}]


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
                    "paths": v.get("paths"), "pubIp": v["pubIp"], "ageMs": int((now - v["seen"]) * 1000),
                    "want": {"stream": w["stream"], "seq": w["seq"]} if w else None})
    return out


def _small(obj, limit=1500):
    """Health details a client attaches (per-relay state and so on): kept only if it is a dict and small."""
    if not isinstance(obj, dict):
        return None
    try:
        return obj if len(json.dumps(obj)) <= limit else None
    except (TypeError, ValueError):
        return None


def _live_hosts(now):
    for k in [k for k, v in _hosts.items() if now - v["seen"] > HOST_TTL]:
        del _hosts[k]
    for k in list(_cmds):
        _cmds[k] = [c for c in _cmds[k] if now - c["at"] <= CMD_KEEP]
        if not _cmds[k]:
            del _cmds[k]
    return [{"id": k, "name": v["name"], "host": v["host"], "streams": v["streams"], "pubIp": v["pubIp"],
             "ageMs": int((now - v["seen"]) * 1000), "pending": len(_cmds.get(k, [])), "results": v["results"][-20:]}
            for k, v in _hosts.items()]


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
        if self.path not in ("/v1/announce", "/v1/decoder/heartbeat", "/v1/decoder/want", "/v1/host/heartbeat", "/v1/host/command"):
            return self._send(404, {"error": "not found"})
        if not self._authed():
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(400, {"error": "bad body"})
        if self.path.startswith("/v1/host/"):
            return self._host_post(n)
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

    def _host_post(self, n):
        global _want_seq
        try:
            msg = json.loads(self.rfile.read(n))
            hid = str(msg.get("id") if self.path.endswith("heartbeat") else msg.get("host"))[:64]
            if not hid or hid == "None":
                raise ValueError("id required")
        except (ValueError, KeyError, TypeError, AttributeError) as e:
            return self._send(400, {"error": str(e)})
        now = time.time()
        if self.path == "/v1/host/command":
            action = str(msg.get("action", ""))
            stream = str(msg.get("stream", ""))[:64]
            if action not in ACTIONS or not stream:
                return self._send(400, {"error": "action must be one of " + ", ".join(ACTIONS) + " and stream is required"})
            value = msg.get("value")
            if action == "bitrate":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    return self._send(400, {"error": "bitrate needs a number (kbps)"})
                if not 500 <= value <= 100000:
                    return self._send(400, {"error": "bitrate must be between 500 and 100000 kbps"})
            else:
                value = None
            with _lock:
                _live_hosts(now)
                if hid not in _hosts:
                    return self._send(404, {"error": "that encoder PC is not connected"})
                _want_seq += 1
                _cmds.setdefault(hid, []).append({"seq": _want_seq, "stream": stream, "action": action, "value": value, "at": now})
                seq = _want_seq
            return self._send(200, {"ok": True, "seq": seq})
        streams = []
        for x in (msg.get("streams") or [])[:32]:
            if isinstance(x, dict):
                st = {k: x.get(k) for k in ("sid", "name", "state", "bitrate", "device", "remote", "error") if k in x}
                p = _small(x.get("paths"))
                if p is not None:
                    st["paths"] = p
                streams.append(st)
        with _lock:
            old = _hosts.get(hid)
            results = (old["results"] if old else [])
            for r in (msg.get("results") or [])[:20]:
                if isinstance(r, dict) and "seq" in r:
                    results.append({"seq": r.get("seq"), "ok": bool(r.get("ok")), "error": str(r.get("error") or "")[:200], "at": int(now * 1000)})
            _hosts[hid] = {"name": str(msg.get("name", hid))[:80], "host": str(msg.get("host", ""))[:80], "streams": streams,
                           "pubIp": _client_ip(self), "seen": now, "results": results[-50:]}
            try:
                ack = int(msg.get("ack") or 0)
            except (TypeError, ValueError):
                ack = 0
            if hid in _cmds:
                _cmds[hid] = [c for c in _cmds[hid] if c["seq"] > ack and now - c["at"] <= CMD_KEEP]
            out = [{"seq": c["seq"], "stream": c["stream"], "action": c["action"], "value": c["value"], "ageMs": int((now - c["at"]) * 1000)}
                   for c in _cmds.get(hid, [])]
        self._send(200, {"ok": True, "commands": out})

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
                              "paths": _small(msg.get("paths")), "pubIp": _client_ip(self), "seen": now}
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
        if self.path == "/v1/hosts":
            if not self._authed():
                return
            with _lock:
                live = _live_hosts(time.time())
            return self._send(200, {"hosts": live})
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
