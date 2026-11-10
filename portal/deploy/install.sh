#!/usr/bin/env bash
# Installs the Arena Portal next to the existing Arena services. Run as root from the checkout:
#   cd /opt/arena-stream; git pull; bash portal/deploy/install.sh
# Safe to re-run: it updates the code and keeps the existing password, secret and links.
#
# What it does
#   1. updates the Arena Link directory (adds the decoder-control calls); its access key is kept
#   2. installs the portal as the arena-portal service on 127.0.0.1:8910
#   3. adds /portal/ and /w/ to the nginx sites that serve the dashboard (a backup is kept, and any
#      nginx error rolls the change back)
# It does not touch mediamtx, the relays, Comms or the dashboard itself.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO/portal"
APP=/opt/arena-portal
ETC=/etc/arena-portal
DATA=/var/lib/arena-portal
step() { echo; echo "== $*"; }

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -f "$SRC/server.js" ] || { echo "$SRC/server.js not found - run git pull first"; exit 1; }
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] \
  || { echo "Node 18 or newer is needed. Run: bash comms/deploy/install.sh   (it installs Node)"; exit 1; }
NODE="$(command -v node)"

step "Arena Link directory (decoder control)"
if ! bash "$REPO/link/directory/install.sh" >/tmp/arena-dir-install.log 2>&1; then
  cat /tmp/arena-dir-install.log; echo "directory update failed"; exit 1
fi
systemctl is-active --quiet arena-link-directory && echo "directory running"

step "ffmpeg (thumbnails)"
command -v ffmpeg >/dev/null || { apt-get update -qq; apt-get install -y -qq ffmpeg >/dev/null; }
ffmpeg -hide_banner -protocols 2>/dev/null | grep -qw srt && echo "ffmpeg with SRT: ok" || echo "WARNING: this ffmpeg has no SRT support, so thumbnails will not appear (web links and live preview still work)"

step "Portal files"
rm -rf "$APP.new"; mkdir -p "$APP.new"
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/reset-owner.js" "$SRC/add-user.js" "$SRC/lib" "$SRC/public" "$APP.new/"
install -m 755 "$SRC/deploy/ctl.sh" "$APP.new/ctl.sh"
rm -rf "$APP"; mv "$APP.new" "$APP"
mkdir -p "$ETC" "$DATA"; chmod 700 "$ETC"
chown -R nobody:nogroup "$DATA"

step "Configuration"
rand() { local v; v="$(openssl rand -base64 48 | tr -dc "$1" | head -c "$2")" || true; printf '%s' "$v"; }
NEW_PW=""
if [ ! -f "$ETC/env" ]; then
  NEW_PW="$(rand 'abcdefghjkmnpqrstuvwxyz23456789' 12)"
  IP="${PUBLIC_IP:-$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)}"
  IP="${IP:-$(hostname -I | awk '{print $1}')}"
  umask 077
  cat > "$ETC/env" <<ENV
PORTAL_PORT=8910
PORTAL_ADMIN_PASSWORD=$NEW_PW
PORTAL_SECRET=$(openssl rand -hex 32)
DIRECTORY_URL=http://127.0.0.1:8002
MEDIAMTX_API=http://127.0.0.1:9997
MEDIAMTX_WEBRTC=http://127.0.0.1:8889
RELAY_SRT=127.0.0.1:8895
PORTAL_DATA_DIR=$DATA
PORTAL_PUBLIC_BASE=http://$IP
ENV
fi
# The owner password (Admin section) is kept hashed in the data folder. First install, or an upgrade from
# a portal that had no Admin section: make one now and hand it to the service once.
NEW_OWNER=""
if ! grep -q '"ownerPwHash":"s1' "$DATA/admin.json" 2>/dev/null; then
  NEW_OWNER="$(rand 'abcdefghjkmnpqrstuvwxyz23456789' 12)"
  sed -i '/^PORTAL_OWNER_PASSWORD_INIT=/d' "$ETC/env"
  printf 'PORTAL_OWNER_PASSWORD_INIT=%s\n' "$NEW_OWNER" >> "$ETC/env"
fi

# The directory access key is shared with the Arena Link directory; keep ours in step with it.
KEY="$(grep -m1 '^LINK_KEY=' /etc/arena-link.env | cut -d= -f2-)"
[ -n "$KEY" ] || { echo "no LINK_KEY in /etc/arena-link.env"; exit 1; }
sed -i '/^LINK_KEY=/d' "$ETC/env"
printf 'LINK_KEY=%s\n' "$KEY" >> "$ETC/env"
chmod 600 "$ETC/env"

step "Service"
cat > /etc/systemd/system/arena-portal.service <<UNIT
[Unit]
Description=Arena Portal (web links, status, decoder control)
After=network.target arena-link-directory.service

[Service]
EnvironmentFile=$ETC/env
WorkingDirectory=$APP
ExecStart=$NODE $APP/server.js
User=nobody
Group=nogroup
Restart=always
RestartSec=1
NoNewPrivileges=true
# The portal (and the ffmpeg it starts for thumbnails) must never take CPU from the relay or mediamtx.
Nice=15
CPUQuota=60%
IOSchedulingClass=idle
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT
# Root helper that restarts a fixed list of services when the Admin page asks for it.
mkdir -p "$DATA/ctl"; chown nobody:nogroup "$DATA/ctl"; rm -f "$DATA/ctl/request"
cat > /etc/systemd/system/arena-portal-ctl.service <<UNIT
[Unit]
Description=Arena Portal service restarts (root helper)

[Service]
Type=oneshot
ExecStart=$APP/ctl.sh
UNIT
cat > /etc/systemd/system/arena-portal-ctl.path <<UNIT
[Unit]
Description=Watches for Arena Portal restart requests

[Path]
PathExists=$DATA/ctl/request

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable arena-portal >/dev/null 2>&1
systemctl enable --now arena-portal-ctl.path >/dev/null 2>&1
systemctl restart arena-portal
sleep 1
systemctl is-active --quiet arena-portal || { journalctl -u arena-portal -n 20 --no-pager; echo "portal failed to start"; exit 1; }
echo "portal running"
if [ -n "$NEW_OWNER" ]; then
  for _ in 1 2 3 4 5 6 7 8; do grep -q '"ownerPwHash":"s1' "$DATA/admin.json" 2>/dev/null && break; sleep 1; done
  if grep -q '"ownerPwHash":"s1' "$DATA/admin.json" 2>/dev/null; then sed -i '/^PORTAL_OWNER_PASSWORD_INIT=/d' "$ETC/env"; else echo "WARNING: owner password was not stored"; NEW_OWNER=""; fi
fi

step "nginx"
install -d /etc/nginx/snippets
cat > /etc/nginx/snippets/arena-portal.conf <<'NGINX'
# Managed by portal/deploy/install.sh
location = /portal { return 301 /portal/; }
location /portal/ {
    proxy_pass http://127.0.0.1:8910;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
}
location /w/ {
    proxy_pass http://127.0.0.1:8910;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64k;
    proxy_read_timeout 30s;
}
NGINX

python3 - <<'PY'
import glob, re, shutil, sys
INC = 'include /etc/nginx/snippets/arena-portal.conf;'
files = [f for f in glob.glob('/etc/nginx/sites-enabled/*') + glob.glob('/etc/nginx/conf.d/*.conf')]
patched = []
for f in files:
    t = open(f).read()
    if 'arena-portal' in t or '127.0.0.1:5000' not in t:
        continue                       # already done, or not a dashboard site
    new, n = re.subn(r'(?m)^([ \t]*)location\s+/\s*\{', lambda m: f'{m.group(1)}{INC}\n{m.group(0)}', t)
    if n:
        shutil.copy(f, f + '.pre-portal')
        open(f, 'w').write(new)
        patched.append(f)
print('patched: ' + (', '.join(patched) if patched else 'nothing new'))
open('/tmp/arena-portal-patched', 'w').write('\n'.join(patched))
PY
if ! nginx -t 2>/tmp/arena-nginx-test.log; then
  cat /tmp/arena-nginx-test.log
  while read -r f; do [ -n "$f" ] && mv -f "$f.pre-portal" "$f"; done < /tmp/arena-portal-patched
  echo "nginx rejected the change; it was rolled back and the dashboard is untouched"
  exit 1
fi
systemctl reload nginx

# Optional first account: bash portal/deploy/install.sh <username>. Created once, with a generated
# password printed below (change it afterwards in the Admin page if you like).
NEW_USER_MSG=""
if [ -n "${1:-}" ]; then
  step "Account $1"
  NEW_USER_MSG="$("$NODE" "$APP/add-user.js" "$1" "$DATA")" || { echo "$NEW_USER_MSG"; echo "could not create the account"; exit 1; }
  echo "$NEW_USER_MSG" | head -1
  systemctl is-active --quiet arena-portal || systemctl start arena-portal
fi

step "Self-test"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8910/portal/ || true)"
echo "portal page: HTTP $code"
dcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "X-Arena-Key: $KEY" http://127.0.0.1:8002/v1/decoders || true)"
echo "directory decoder list: HTTP $dcode"
IPNOW="$(grep -m1 '^PORTAL_PUBLIC_BASE=' "$ETC/env" | cut -d= -f2- | sed 's#^http://##')"

echo
echo "=========================================="
echo "  ARENA PORTAL:  https://$IPNOW/portal/"
if [ -n "$NEW_PW" ]; then
echo "  Password:      $NEW_PW"
else
echo "  Password:      unchanged (grep PORTAL_ADMIN_PASSWORD $ETC/env)"
fi
if [ -n "$NEW_OWNER" ]; then
echo "  Owner password (Admin tab): $NEW_OWNER"
else
echo "  Owner password: unchanged (lost it? node $APP/reset-owner.js)"
fi
if [ -n "$NEW_USER_MSG" ]; then
echo "$NEW_USER_MSG" | sed 's/^/  /'
fi
echo "  Web links:     http://$IPNOW/w/<id>"
echo "=========================================="
echo "Update the Arena Link app on the decoder PCs to use remote decoder control."
echo "TCP 80 and 443 must be open in the Hetzner Cloud firewall."
