#!/bin/bash
# Install the share-link auth hook on the relay server.  Run as root from the repo:
#   cd /opt/arena-stream; git pull; bash relay/linkd/install.sh
# Safe to re-run.  Starts in LOG-ONLY mode (nothing is refused); once links are in
# use, turn enforcement on with:  bash relay/linkd/enforce.sh on
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
CONF=/etc/mediamtx.yml
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found - install nodejs first"; exit 1; }
[ -f "$CONF" ] || { echo "$CONF not found"; exit 1; }

echo "=== linkd service ==="
cat > /etc/systemd/system/arena-linkd.service <<UNIT
[Unit]
Description=Arena share-link auth hook for mediamtx
After=network.target

[Service]
Environment=LINKD_PORT=9100
Environment=LINKD_ENFORCE=0
ExecStart=$NODE $HERE/linkd.js
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now arena-linkd
sleep 1
systemctl is-active --quiet arena-linkd || { echo "linkd FAILED"; journalctl -u arena-linkd -n 15 --no-pager; exit 1; }

echo "=== mediamtx auth hook ==="
cp "$CONF" "$CONF.pre-linkd"
python3 - <<'PY'
import re
p = '/etc/mediamtx.yml'
t = open(p).read()
# mediamtx 1.x renamed the external-auth key; set whichever this binary understands
import subprocess
try:
    v = subprocess.run(['mediamtx', '--version'], capture_output=True, text=True).stdout.strip().lstrip('v')
    major, minor = [int(x) for x in v.split('.')[:2]]
except Exception:
    major, minor = 1, 99
for k in ('authMethod', 'authHTTPAddress', 'authHTTPExclude', 'externalAuthenticationURL'):
    t = re.sub(r'(?m)^%s:.*\n(?:[ \t]+.*\n)*' % k, '', t)
if (major, minor) >= (1, 12):
    block = ("authMethod: http\n"
             "authHTTPAddress: http://127.0.0.1:9100/auth\n"
             "authHTTPExclude:\n  - action: api\n  - action: metrics\n  - action: pprof\n")
else:
    block = "externalAuthenticationURL: http://127.0.0.1:9100/auth\n"
open(p, 'w').write(block + t)
print('mediamtx', major, minor, '->', block.splitlines()[0])
PY
systemctl restart mediamtx
sleep 3
if systemctl is-active --quiet mediamtx; then
  echo "mediamtx: OK (log-only mode; streams unaffected)"
else
  echo "mediamtx FAILED - restoring previous config"
  cp "$CONF.pre-linkd" "$CONF"
  systemctl restart mediamtx
  journalctl -u mediamtx -n 15 --no-pager
  exit 1
fi
echo "Watch decisions with:  journalctl -u arena-linkd -f"
