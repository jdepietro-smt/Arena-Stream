"""Black-box test: start the directory, announce, list, expire, reject bad input."""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

PORT = "18002"
BASE = f"http://127.0.0.1:{PORT}"
KEY = "testkey"


def call(path, body=None, key=KEY):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-Arena-Key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


import tempfile
UPD = tempfile.mkdtemp(prefix="upd-")
os.makedirs(os.path.join(UPD, "link"))
PAYLOAD = bytes(range(256)) * 40                     # 10240 bytes
open(os.path.join(UPD, "link", "Arena-Link-Setup-0.2.0.exe"), "wb").write(PAYLOAD)


def write_manifest(**kw):
    m = {"version": "0.2.0", "file": "Arena-Link-Setup-0.2.0.exe", "sha256": "ab" * 32, "size": len(PAYLOAD), "notes": "n"}
    m.update(kw)
    with open(os.path.join(UPD, "link", "latest.json"), "w") as f:
        json.dump(m, f)


def raw(path, headers=None, key=KEY):
    req = urllib.request.Request(BASE + path, headers=dict({"X-Arena-Key": key}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


env = dict(os.environ, LINK_PORT=PORT, LINK_KEY=KEY, LINK_TTL="1.5", LINK_UPDATE_DIR=UPD)
srv = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__), "directory.py")], env=env,
                       stdout=subprocess.DEVNULL)
try:
    time.sleep(0.8)
    ann = {"id": "enc-a", "name": "ESPN", "format": "1920x1080p@59.94", "codec": "h264", "kbps": 10000,
           "lanIps": ["10.0.0.5"], "directPort": 4200, "relay": {"port": 8895, "name": "ESPN"}}
    assert call("/v1/announce", ann, key="wrong")[0] == 401
    st, r = call("/v1/announce", ann)
    assert st == 200 and r["yourIp"] == "127.0.0.1", (st, r)
    assert call("/v1/announce", {"id": "x"})[0] == 400          # name required
    st, r = call("/v1/encoders")
    assert st == 200 and len(r["encoders"]) == 1 and r["encoders"][0]["name"] == "ESPN", r
    assert r["encoders"][0]["lanIps"] == ["10.0.0.5"] and r["yourIp"] == "127.0.0.1"
    call("/v1/announce", dict(ann, id="enc-b", name="CBS"))      # a second encoder instance
    assert len(call("/v1/encoders")[1]["encoders"]) == 2
    time.sleep(2.0)                                              # past TTL, no heartbeat
    assert call("/v1/encoders")[1]["encoders"] == []
    # Remote decoder control
    st, r = call("/v1/decoder/heartbeat", {"id": "pc1-1", "name": "Truck decoder", "host": "pc1", "state": "live", "stream": "ESPN"})
    assert st == 200 and r["want"] is None, (st, r)
    assert call("/v1/decoder/heartbeat", {"name": "no id"})[0] == 400
    assert call("/v1/decoder/want", {"id": "pc1-1", "stream": "CBS"}, key="wrong")[0] == 401
    st, r = call("/v1/decoder/want", {"id": "pc1-1", "stream": "CBS"})
    assert st == 200 and r["want"]["stream"] == "CBS"
    seq = r["want"]["seq"]
    st, r = call("/v1/decoder/heartbeat", {"id": "pc1-1", "name": "Truck decoder", "host": "pc1", "state": "live", "stream": "ESPN"})
    assert r["want"] == {"stream": "CBS", "seq": seq}, r          # the decoder is told what to play
    st, r = call("/v1/decoders")
    assert st == 200 and len(r["decoders"]) == 1 and r["decoders"][0]["want"]["stream"] == "CBS", r
    assert call("/v1/decoder/want", {"id": "pc1-1", "stream": ""})[1]["want"]["seq"] > seq   # "" = disconnect, newer request
    # Remote encoder control
    hb = {"id": "pc9", "name": "Garden PC", "host": "pc9", "streams": [{"sid": "s1", "name": "Garden", "state": "live", "bitrate": 10000}]}
    st, r = call("/v1/host/heartbeat", hb)
    assert st == 200 and r["commands"] == [], (st, r)
    assert call("/v1/host/heartbeat", {"name": "no id"})[0] == 400
    assert call("/v1/host/command", {"host": "ghost", "stream": "s1", "action": "stop"})[0] == 404          # not connected
    assert call("/v1/host/command", {"host": "pc9", "stream": "s1", "action": "explode"})[0] == 400
    assert call("/v1/host/command", {"host": "pc9", "stream": "s1", "action": "bitrate", "value": 5})[0] == 400
    assert call("/v1/host/command", {"host": "pc9", "stream": "s1", "action": "stop"}, key="wrong")[0] == 401
    st, r = call("/v1/host/command", {"host": "pc9", "stream": "s1", "action": "bitrate", "value": 6000})
    assert st == 200
    seq1 = r["seq"]
    seq2 = call("/v1/host/command", {"host": "pc9", "stream": "s1", "action": "stop"})[1]["seq"]
    st, r = call("/v1/host/heartbeat", hb)
    assert [c["seq"] for c in r["commands"]] == [seq1, seq2] and r["commands"][0]["value"] == 6000, r      # delivered until acknowledged
    st, r = call("/v1/host/heartbeat", dict(hb, ack=seq1, results=[{"seq": seq1, "ok": True}]))
    assert [c["seq"] for c in r["commands"]] == [seq2], r
    st, r = call("/v1/host/heartbeat", dict(hb, ack=seq2, results=[{"seq": seq2, "ok": False, "error": "no signal"}]))
    assert r["commands"] == []
    st, r = call("/v1/hosts")
    assert st == 200 and len(r["hosts"]) == 1 and r["hosts"][0]["pending"] == 0, r
    assert [x["ok"] for x in r["hosts"][0]["results"]] == [True, False] and r["hosts"][0]["results"][1]["error"] == "no signal"
    assert r["hosts"][0]["streams"][0]["name"] == "Garden"
    # Path health travels with the heartbeats (small dicts only)
    hp = {"relays": [{"host": "a", "port": 8895, "up": True, "rttMs": 20.0}, {"host": "b", "port": 8895, "up": False}], "up": 1, "total": 2}
    st = [{"sid": "s1", "name": "Garden", "state": "live", "bitrate": 10000, "paths": hp}, {"sid": "s2", "name": "Alt", "state": "live", "paths": "not a dict"}]
    call("/v1/host/heartbeat", dict(hb, streams=st))
    got = call("/v1/hosts")[1]["hosts"][0]["streams"]
    assert got[0]["paths"] == hp and "paths" not in got[1], got
    call("/v1/host/heartbeat", dict(hb, streams=[{"sid": "s1", "name": "Garden", "paths": {"x": "y" * 3000}}]))
    assert "paths" not in call("/v1/hosts")[1]["hosts"][0]["streams"][0]           # too big: dropped, the heartbeat still works
    call("/v1/decoder/heartbeat", {"id": "pc1-1", "name": "Truck decoder", "host": "pc1", "state": "live", "stream": "ESPN", "paths": {"paths": 2, "up": 1, "pathUp": [True, False]}})
    assert call("/v1/decoders")[1]["decoders"][0]["paths"]["up"] == 1
    # Software updates
    assert call("/v1/update/link/latest?host=pc1&version=0.1.0", key="wrong")[0] == 401
    assert call("/v1/update/link/latest?host=pc1&version=0.1.0")[1] == {"update": False}                  # nothing published yet
    write_manifest()
    st, r = call("/v1/update/link/latest?host=pc1&version=0.1.0")
    assert st == 200 and r["update"] is True and r["version"] == "0.2.0" and r["file"].endswith("0.2.0.exe") and r["sha256"] == "ab" * 32, r
    assert call("/v1/update/link/latest?host=pc1&version=0.2.0")[1] == {"update": False}                  # already there
    assert call("/v1/update/link/latest?host=pc1&version=0.10.0")[1] == {"update": False}                 # 0.10.0 is newer than 0.2.0, numerically
    assert call("/v1/update/link/latest?host=pc1&version=0.1.9")[1]["update"] is True
    write_manifest(paused=True)
    assert call("/v1/update/link/latest?host=pc1&version=0.1.0")[1] == {"update": False}
    write_manifest(allow=["canary-pc"])
    assert call("/v1/update/link/latest?host=pc1&version=0.1.0")[1] == {"update": False}                  # staged: not this PC yet
    assert call("/v1/update/link/latest?host=canary-pc&version=0.1.0")[1]["update"] is True
    write_manifest(exact=True, version="0.1.5")
    assert call("/v1/update/link/latest?host=pc1&version=0.2.0")[1]["update"] is True                     # a roll back moves backwards
    assert call("/v1/update/link/latest?host=pc1&version=0.1.5")[1] == {"update": False}
    write_manifest(file="../../etc/passwd")
    assert call("/v1/update/link/latest?host=pc1&version=0.1.0")[1] == {"update": False}                  # a manifest cannot point outside
    write_manifest()
    assert call("/v1/update/Link!/latest")[0] == 404 and call("/v1/update/nope/latest?version=0")[1] == {"update": False}
    st, body, h = raw("/v1/update/link/file/Arena-Link-Setup-0.2.0.exe")
    assert st == 200 and body == PAYLOAD and h["Accept-Ranges"] == "bytes"
    st, body, h = raw("/v1/update/link/file/Arena-Link-Setup-0.2.0.exe", {"Range": "bytes=10000-"})
    assert st == 206 and body == PAYLOAD[10000:] and h["Content-Range"] == "bytes 10000-10239/10240", (st, h)
    st, body, h = raw("/v1/update/link/file/Arena-Link-Setup-0.2.0.exe", {"Range": "bytes=0-99"})
    assert st == 206 and body == PAYLOAD[:100]
    st, body, h = raw("/v1/update/link/file/Arena-Link-Setup-0.2.0.exe", {"Range": "bytes=-16"})
    assert st == 206 and body == PAYLOAD[-16:]
    assert raw("/v1/update/link/file/Arena-Link-Setup-0.2.0.exe", {"Range": "bytes=99999-"})[0] == 416
    assert raw("/v1/update/link/file/missing.exe")[0] == 404
    assert raw("/v1/update/link/file/..%2f..%2fetc%2fpasswd")[0] in (400, 404)
    assert raw("/v1/update/link/file/Arena-Link-Setup-0.2.0.exe", key="wrong")[0] == 401
    # versions travel with the heartbeats
    call("/v1/host/heartbeat", dict(hb, version="0.1.0", updater={"state": "ready", "pending": "0.2.0"}))
    h0 = call("/v1/hosts")[1]["hosts"][0]
    assert h0["version"] == "0.1.0" and h0["updater"]["pending"] == "0.2.0", h0
    call("/v1/decoder/heartbeat", {"id": "pc1-1", "name": "Truck decoder", "host": "pc1", "state": "live", "stream": "ESPN", "version": "0.1.0"})
    assert call("/v1/decoders")[1]["decoders"][0]["version"] == "0.1.0"
    print("directory: all checks passed")
finally:
    srv.terminate()
