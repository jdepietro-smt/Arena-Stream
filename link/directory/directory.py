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

Software updates for the Arena Link apps (the portal publishes releases; the apps fetch them):
  GET /v1/update/<app>/latest?host=H&version=V   what this PC should install, if anything:
                              {"update": false} or {"update": true, version, file, sha256, size, notes, exact}
  GET /v1/update/<app>/file/<name>              the installer, with HTTP Range so a download can resume
A release is a folder LINK_UPDATE_DIR/<app>/ holding the installer files and latest.json (written by the portal):
{version, file, sha256, size, notes, publishedAt, exact, paused, allow}. `paused` stops everyone; `allow` (a list of PC names)
limits a release to those PCs first; `exact` means "move to exactly this version" (a roll back), otherwise only newer is offered.

Entries expire TTL seconds after their last announce. No stream data passes
through here.
"""
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TTL = float(os.environ.get("LINK_TTL", "4"))
KEY = os.environ.get("LINK_KEY", "")
PORT = int(os.environ.get("LINK_PORT", "8002"))
RELAY_SECRET = os.environ.get("LINK_RELAY_SECRET", "")
TRUST_PROXY =os.environ.get("LINK_TRUST_PROXY") == "1"
DEC_TTL = float(os.environ.get("LINK_DEC_TTL", "20"))
WANT_KEEP = 600.0   # a request for an offline decoder is kept this long, so it is applied when the decoder returns
HOST_TTL = float(os.environ.get("LINK_HOST_TTL", "20"))
UPDATE_DIR = os.environ.get("LINK_UPDATE_DIR", "/var/lib/arena-updates")
APP_RE = re.compile(r"^[a-z0-9-]{1,32}$")
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
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
                    "paths": v.get("paths"), "version": v.get("version"), "updater": v.get("updater"), "pubIp": v["pubIp"], "ageMs": int((now - v["seen"]) * 1000),
                    "want": {"stream": w["stream"], "seq": w["seq"]} if w else None})
    return out


def _ver(v):
    """'1.2.3' -> (1, 2, 3); anything unreadable sorts as 0."""
    out = []
    for part in str(v).split(".")[:4]:
        m = re.match(r"\d+", part)
        out.append(int(m.group()) if m else 0)
    return tuple(out) + (0,) * (4 - len(out))


def _manifest(app):
    try:
        with open(os.path.join(UPDATE_DIR, app, "latest.json"), encoding="utf-8") as f:
            m = json.load(f)
        return m if isinstance(m, dict) and m.get("version") and m.get("file") and FILE_RE.match(str(m["file"])) else None
    except (OSError, ValueError):
        return None


def update_offer(app, host, current):
    """What the PC `host`, now on version `current`, should install: the manifest fields, or None."""
    m = _manifest(app)
    if not m or m.get("paused"):
        return None
    allow = m.get("allow") or []
    if allow and host not in allow:
        return None
    newer = _ver(m["version"]) > _ver(current)
    if not (newer or (m.get("exact") and str(m["version"]) != str(current))):
        return None
    return {k: m.get(k) for k in ("version", "file", "sha256", "size", "notes", "exact")}


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
             "version": v.get("version"), "updater": v.get("updater"),
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
                           "pubIp": _client_ip(self), "seen": now, "results": results[-50:],
                           "version": str(msg.get("version") or "")[:24] or None, "updater": _small(msg.get("updater"), 400)}
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
                              "paths": _small(msg.get("paths")), "version": str(msg.get("version") or "")[:24] or None,
                              "updater": _small(msg.get("updater"), 400), "pubIp": _client_ip(self), "seen": now}
            w = _wants.get(did)
            want = {"stream": w["stream"], "seq": w["seq"]} if w else None
        self._send(200, {"ok": True, "want": want})

    def _update_get(self):
        parsed = urlparse(self.path)
        parts = parsed.path.split("/")          # ['', 'v1', 'update', app, 'latest' | 'file', name?]
        if len(parts) < 5 or not APP_RE.match(parts[3]):
            return self._send(404, {"error": "not found"})
        app = parts[3]
        if parts[4] == "latest":
            q = parse_qs(parsed.query)
            offer = update_offer(app, (q.get("host") or [""])[0][:80], (q.get("version") or ["0"])[0][:24])
            return self._send(200, {"update": True, **offer} if offer else {"update": False})
        if parts[4] == "file" and len(parts) == 6 and FILE_RE.match(parts[5]):
            path = os.path.join(UPDATE_DIR, app, parts[5])
            try:
                size = os.path.getsize(path)
                f = open(path, "rb")
            except OSError:
                return self._send(404, {"error": "no such file"})
            with f:
                start, end = 0, size - 1
                rng = self.headers.get("Range")
                m = re.match(r"^bytes=(\d*)-(\d*)$", rng or "")
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        start = int(m.group(1))
                        end = int(m.group(2)) if m.group(2) else size - 1
                    else:
                        start = max(0, size - int(m.group(2)))
                    end = min(end, size - 1)
                    if start > end or start >= size:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                else:
                    self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(end - start + 1))
                self.end_headers()
                f.seek(start)
                left = end - start + 1
                try:
                    while left > 0:
                        chunk = f.read(min(262144, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return
        return self._send(404, {"error": "not found"})

    def do_GET(self):
        if self.path.startswith("/v1/update/"):
            if not self._authed():
                return
            return self._update_get()
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
