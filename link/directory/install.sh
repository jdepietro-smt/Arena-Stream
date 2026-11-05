#!/bin/bash
# Installs the Arena Link directory (live list of encoders) on TCP 8002.
# Touches nothing else on the server: no mediamtx restart, no change to the SRT relay.
#   cd /opt/arena-stream; git pull; bash link/directory/install.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/directory.py"
[ -f "$SRC" ] || { echo "missing $SRC - run git pull first"; exit 1; }
command -v python3 >/dev/null || apt-get install -y python3 >/dev/null

if ss -ltn | grep -q ':8002 ' && ! systemctl is-active -q arena-link-directory; then
  echo "TCP 8002 is already in use by something else:"; ss -ltnp | grep ':8002 '; exit 1
fi

# Copy it out of the git checkout so a later git pull cannot change a running service.
install -d -m 755 /opt/arena-link
install -m 644 "$SRC" /opt/arena-link/directory.py

# The access key is created once and kept across updates. No look-alike characters (0/o, 1/l).
if [ ! -f /etc/arena-link.env ]; then
  KEY="$(tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 12)"
  umask 077
  printf 'LINK_PORT=8002\nLINK_TTL=4\nLINK_KEY=%s\n' "$KEY" > /etc/arena-link.env
fi
KEY="$(grep -m1 '^LINK_KEY=' /etc/arena-link.env | cut -d= -f2-)"

# Relay passphrase: copied from the low-latency relay's own config so it is never typed or pasted.
if ! grep -q '^LINK_RELAY_SECRET=' /etc/arena-link.env && [ -f /etc/arena-lowlat.env ]; then
  RS="$(grep -m1 '^LL_PUBLISH_SECRET=' /etc/arena-lowlat.env | cut -d= -f2-)"
  [ -n "$RS" ] && printf 'LINK_RELAY_SECRET=%s\n' "$RS" >> /etc/arena-link.env
fi
grep -q '^LINK_RELAY_SECRET=' /etc/arena-link.env || echo "WARNING: no relay passphrase found - remote (internet) decoders will not work"

cat > /etc/systemd/system/arena-link-directory.service <<'UNIT'
[Unit]
Description=Arena Link directory (encoders on air)
After=network.target

[Service]
EnvironmentFile=/etc/arena-link.env
ExecStart=/usr/bin/python3 -u /opt/arena-link/directory.py
User=nobody
Group=nogroup
Restart=always
RestartSec=1
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable arena-link-directory >/dev/null 2>&1
systemctl restart arena-link-directory
command -v ufw >/dev/null && ufw status | grep -q "Status: active" && ufw allow 8002/tcp >/dev/null || true
sleep 1

echo
systemctl is-active arena-link-directory
echo -n "self-test: "
curl -s -m 3 -H "X-Arena-Key: $KEY" http://127.0.0.1:8002/v1/encoders || echo "FAILED"
echo
echo "=========================================="
echo "  ARENA LINK ACCESS KEY:  $KEY"
echo "=========================================="
echo "Enter it in Settings on every encoder and decoder PC."
echo "Also allow inbound TCP 8002 in the Hetzner Cloud firewall."
