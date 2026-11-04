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


env = dict(os.environ, LINK_PORT=PORT, LINK_KEY=KEY, LINK_TTL="1.5")
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
    print("directory: all checks passed")
finally:
    srv.terminate()
