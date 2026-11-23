#!/bin/bash
# Installs the Arena recorder: records the streams chosen on the portal's Recordings page, keeps them for the chosen number of days,
# and cuts clips. It runs as its own service, so restarting the portal never interrupts a recording.
#   cd /opt/arena-stream; git pull; bash recorder/deploy/install.sh
# Run it on the server that has the relay (the recorder reads streams from it) and the portal. Safe to run again: the access token
# and the settings are kept.
#
# Recordings go to /var/recordings/arena (the big volume). Override with:  REC_DIR=/some/folder bash recorder/deploy/install.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/.."
APP=/opt/arena-recorder
ETC=/etc/arena-recorder
DATA=/var/lib/arena-recorder
REC_DIR="${REC_DIR:-/var/recordings/arena}"
step() { echo; echo "== $*"; }

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -f "$SRC/recorderd.js" ] || { echo "$SRC/recorderd.js not found - run git pull first"; exit 1; }
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] \
  || { echo "Node 18 or newer is needed. Run: bash comms/deploy/install.sh   (it installs Node)"; exit 1; }
NODE="$(command -v node)"
[ -f /etc/arena-link.env ] || { echo "the Arena Link directory is not installed (no /etc/arena-link.env): run bash link/directory/install.sh first"; exit 1; }

step "ffmpeg"
command -v ffmpeg >/dev/null || { apt-get update -qq; apt-get install -y -qq ffmpeg >/dev/null; }
ffmpeg -hide_banner -protocols 2>/dev/null | grep -qw srt || { echo "this ffmpeg has no SRT support, so it cannot read streams from the relay"; exit 1; }
echo "ffmpeg with SRT: ok"

step "Where recordings go"
mkdir -p "$REC_DIR"
FREE_GB=$(df -P -B1G "$REC_DIR" | awk 'NR==2 {print $4}')
TOTAL_GB=$(df -P -B1G "$REC_DIR" | awk 'NR==2 {print $2}')
echo "$REC_DIR has ${FREE_GB} GB free of ${TOTAL_GB} GB"
if ! mountpoint -q /var/recordings 2>/dev/null && [ "$REC_DIR" = /var/recordings/arena ]; then
  echo "WARNING: /var/recordings is not a separate volume here, so recordings would fill the server's own disk."
  echo "         Mount the recordings volume there, or run again with REC_DIR=/path/on/the/big/volume"
fi
echo "A 10 Mbps stream is about 4.5 GB an hour: ${TOTAL_GB} GB holds roughly $((TOTAL_GB * 8 / 10 / 5)) stream-hours at that rate."

step "Recorder files"
rm -rf "$APP.new"; mkdir -p "$APP.new"
cp -r "$SRC/recorderd.js" "$SRC/lib" "$APP.new/"
rm -rf "$APP"; mv "$APP.new" "$APP"
mkdir -p "$ETC" "$DATA"; chmod 700 "$ETC"
chown -R nobody:nogroup "$DATA" "$REC_DIR"

step "Configuration"
TOKEN=""
[ -f "$ETC/env" ] && TOKEN="$(grep -m1 '^REC_TOKEN=' "$ETC/env" | cut -d= -f2-)"
[ -n "$TOKEN" ] || TOKEN="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)"
KEY="$(grep -m1 '^LINK_KEY=' /etc/arena-link.env | cut -d= -f2-)"
[ -n "$KEY" ] || { echo "no LINK_KEY in /etc/arena-link.env"; exit 1; }
umask 077
cat > "$ETC/env" <<ENV
REC_PORT=8920
REC_DIR=$REC_DIR
REC_DATA=$DATA
DIRECTORY_URL=http://127.0.0.1:8002
LINK_KEY=$KEY
RELAY_SRT=127.0.0.1:8895
REC_TOKEN=$TOKEN
ENV
chmod 600 "$ETC/env"

step "Service"
cat > /etc/systemd/system/arena-recorder.service <<UNIT
[Unit]
Description=Arena recorder (records chosen streams, keeps them, cuts clips)
After=network.target arena-link-directory.service arena-lowlat.service

[Service]
EnvironmentFile=$ETC/env
WorkingDirectory=$APP
ExecStart=$NODE $APP/recorderd.js
User=nobody
Group=nogroup
Restart=always
RestartSec=2
KillMode=mixed
TimeoutStopSec=8
NoNewPrivileges=true
# Below the relay and mediamtx in priority, but never starved: recording must not stall.
Nice=5
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA $REC_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable arena-recorder >/dev/null 2>&1
systemctl restart arena-recorder

step "Tell the portal"
if [ -f /etc/arena-portal/env ]; then
  sed -i '/^REC_URL=/d;/^REC_TOKEN=/d' /etc/arena-portal/env
  printf 'REC_URL=http://127.0.0.1:8920\nREC_TOKEN=%s\n' "$TOKEN" >> /etc/arena-portal/env
  systemctl restart arena-portal && echo "portal restarted: the Recordings tab is live"
else
  echo "the portal is not installed yet: run bash portal/deploy/install.sh, then run this again"
fi

sleep 2
if systemctl is-active --quiet arena-recorder; then
  echo; echo "arena-recorder is running. Open the portal, Video, Recordings, and tick the streams to record."
  journalctl -u arena-recorder -n 3 --no-pager 2>/dev/null | tail -3
else
  echo "the recorder did not start:"; journalctl -u arena-recorder -n 15 --no-pager; exit 1
fi
