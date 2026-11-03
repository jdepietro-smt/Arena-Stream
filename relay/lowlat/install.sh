#!/bin/bash
# Installs the low-latency SRT relay beside mediamtx (UDP 8895).
# Does NOT touch mediamtx, so no stream drops and the SRT passphrase survives.
#   git pull; bash relay/lowlat/install.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../../cpp/relay/srt_relay.cpp"
[ -f "$SRC" ] || { echo "missing $SRC - run git pull first"; exit 1; }

echo "== build tools + libsrt"
apt-get install -y g++ pkg-config libsrt-openssl-dev >/dev/null

echo "== compile"
g++ -O2 -std=c++17 "$SRC" -o /usr/local/bin/arena-srt-relay $(pkg-config --cflags --libs srt) -lpthread

# Publishers authenticate with the same SRT passphrase the encoder already uses.
SECRET=""
for f in /opt/arena/.env /opt/arena/backend/.env; do
  [ -f "$f" ] && SECRET="$(grep -m1 '^SRT_PUBLISH_PASSPHRASE=' "$f" | cut -d= -f2- | tr -d '"' | tr -d "'")" && [ -n "$SECRET" ] && break
done
[ -n "$SECRET" ] || { echo "could not read SRT_PUBLISH_PASSPHRASE from /opt/arena/.env"; exit 1; }

umask 077
printf 'LL_PORT=8895
LL_LATENCY_MS=40
LL_PUBLISH_SECRET=%s
' "$SECRET" > /etc/arena-lowlat.env

cat > /etc/systemd/system/arena-lowlat.service <<'UNIT'
[Unit]
Description=Arena low-latency SRT relay (UDP 8895)
After=network.target

[Service]
EnvironmentFile=/etc/arena-lowlat.env
ExecStart=/usr/local/bin/arena-srt-relay
Restart=always
RestartSec=1
TimeoutStopSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now arena-lowlat
systemctl restart arena-lowlat
command -v ufw >/dev/null && ufw status | grep -q "Status: active" && ufw allow 8895/udp || true
sleep 1
systemctl is-active arena-lowlat && journalctl -u arena-lowlat -n 3 --no-pager
echo "Also allow UDP 8895 in the Hetzner Cloud firewall."
