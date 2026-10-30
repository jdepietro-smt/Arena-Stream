#!/usr/bin/env bash
# Installs Arena Comms next to the Arena stream server on one Ubuntu box.
# Run as root from the checkout:   bash comms/deploy/install.sh
# Safe to re-run: it updates code and services, and keeps existing config, keys and users.
#
# What it sets up
#   arena-comms.service    the Comms server (127.0.0.1:8900)
#   arena-livekit.service  the LiveKit SFU (127.0.0.1:7880 signalling, 7881/tcp + 7882/udp media)
#   nginx :443 (self-signed cert for the IP)   /            -> the existing dashboard (127.0.0.1:5000)
#                                              /comms/       -> Comms server  (+ /comms/admin)
#                                              /comms/app/   -> the Comms web app
#                                              /livekit/     -> LiveKit signalling
#   The dashboard gets a "Comms" tab injected by nginx; the dashboard's own files are untouched.
set -euo pipefail

# Default to the checkout this script lives in, so no environment variable is needed.
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
COMMS="$REPO/comms"
ETC=/etc/arena-comms
WEBROOT=/var/www/arena-comms
ARENA_API="${ARENA_API:-http://127.0.0.1:9997}"
DASHBOARD="${DASHBOARD:-http://127.0.0.1:5000}"

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -d "$COMMS/server" ] || { echo "$COMMS/server not found — is the repo at $REPO up to date?"; exit 1; }

IP="${PUBLIC_IP:-$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)}"
IP="${IP:-$(hostname -I | awk '{print $1}')}"
echo "== Public address: $IP"

step() { echo; echo "== $*"; }

step "Packages"
export DEBIAN_FRONTEND=noninteractive
need_node=1
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then need_node=0; fi
apt-get update -qq
apt-get install -y -qq curl openssl nginx ca-certificates xz-utils ffmpeg >/dev/null # ffmpeg: the server music player
if [ "$need_node" = 1 ]; then
  # Official tarball into /usr/local: independent of apt, so it cannot clash with Ubuntu's old
  # nodejs/libnode packages. /usr/local/bin comes before /usr/bin on PATH, so it wins.
  case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64) NODE_ARCH=arm64 ;; *) echo "unsupported CPU $(uname -m)"; exit 1 ;; esac
  NODE_VER=v20.18.1
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$NODE_ARCH.tar.xz" | tar -xJ -C /usr/local --strip-components=1
  hash -r
fi
echo "node $(node -v)  npm $(npm -v)"

step "LiveKit"
if ! command -v livekit-server >/dev/null; then
  curl -sSL https://get.livekit.io | bash >/dev/null
fi
livekit-server --version | head -1

step "Secrets and config"
mkdir -p "$ETC" "$WEBROOT" "$ETC/tls"
chmod 700 "$ETC"
if [ ! -f "$ETC/env" ]; then
  LK_KEY="arena$(openssl rand -hex 4)"
  LK_SECRET="$(openssl rand -hex 24)"
  ADMIN_PW="${COMMS_ADMIN_PW_INIT:-$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)}" # set COMMS_ADMIN_PW_INIT to choose the first admin password
  cat >"$ETC/env" <<EOF
LK_KEY=$LK_KEY
LK_SECRET=$LK_SECRET
COMMS_ADMIN_PASSWORD=$ADMIN_PW
COMMS_HOST=127.0.0.1
EOF
  chmod 600 "$ETC/env"
  FIRST_RUN=1
else
  FIRST_RUN=0
fi
# shellcheck disable=SC1091
. "$ETC/env"

cat >"$ETC/livekit.yaml" <<EOF
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
keys:
  $LK_KEY: $LK_SECRET
EOF
chmod 600 "$ETC/livekit.yaml"

if [ ! -f "$COMMS/server/comms.config.json" ]; then
  node "$COMMS/deploy/make-config.mjs" "$COMMS/server/comms.config.json" "$IP" "$LK_KEY" "$LK_SECRET" "$ARENA_API"
else
  echo "keeping existing comms.config.json"
fi

step "Comms server dependencies"
( cd "$COMMS/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null )

step "Building the Comms web app"
( cd "$REPO/ui/comms-app" \
  && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund >/dev/null \
  && npx vite build >/dev/null )
[ -f "$REPO/ui/comms-app/dist/index.html" ] || { echo "web build failed"; exit 1; }
install -m 644 "$COMMS/deploy/comms-tab.js" "$WEBROOT/comms-tab.js"

TLS_CERT="$ETC/tls/cert.pem"
TLS_KEY="$ETC/tls/key.pem"
SERVER_NAME="_"
if [ -n "${COMMS_DOMAIN:-}" ]; then
  # A real certificate for a domain that points at this server: browsers and the gateway apps trust it with nothing to install.
  step "TLS certificate (Let's Encrypt for $COMMS_DOMAIN)"
  apt-get install -y -qq certbot >/dev/null
  if [ ! -f "/etc/letsencrypt/live/$COMMS_DOMAIN/fullchain.pem" ]; then
    # Needs the name to resolve to this server and port 80 reachable. nginx is paused for the few seconds it takes.
    EMAIL_ARGS=(--register-unsafely-without-email)
    [ -n "${COMMS_EMAIL:-}" ] && EMAIL_ARGS=(-m "$COMMS_EMAIL")
    certbot certonly --standalone -d "$COMMS_DOMAIN" --non-interactive --agree-tos "${EMAIL_ARGS[@]}" \
      --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx" \
      || { echo "Could not get a certificate: does $COMMS_DOMAIN point at $IP, and is port 80 open?"; exit 1; }
  fi
  TLS_CERT="/etc/letsencrypt/live/$COMMS_DOMAIN/fullchain.pem"
  TLS_KEY="/etc/letsencrypt/live/$COMMS_DOMAIN/privkey.pem"
  SERVER_NAME="$COMMS_DOMAIN"
else
  step "TLS certificate (self-signed for $IP)"
  if [ ! -f "$ETC/tls/cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$ETC/tls/key.pem" -out "$ETC/tls/cert.pem" \
      -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" 2>/dev/null
    chmod 600 "$ETC/tls/key.pem"
  fi
fi

step "Services"
cat >/etc/systemd/system/arena-livekit.service <<EOF
[Unit]
Description=Arena Comms LiveKit SFU
After=network-online.target

[Service]
ExecStart=/usr/local/bin/livekit-server --config $ETC/livekit.yaml
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/arena-comms.service <<EOF
[Unit]
Description=Arena Comms server
After=network-online.target arena-livekit.service

[Service]
WorkingDirectory=$COMMS/server
EnvironmentFile=$ETC/env
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now arena-livekit.service >/dev/null
systemctl restart arena-comms.service
systemctl enable arena-comms.service >/dev/null

step "nginx"
cat >/etc/nginx/sites-available/arena-comms <<EOF
# Managed by comms/deploy/install.sh
map \$http_upgrade \$arena_conn { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name $SERVER_NAME;
    ssl_certificate     $TLS_CERT;
    ssl_certificate_key $TLS_KEY;
    client_max_body_size 50m;

    location = /comms-tab.js { alias $WEBROOT/comms-tab.js; add_header Cache-Control no-cache; }

    # The web app connects its websocket to exactly /comms (no trailing slash).
    location = /comms {
        proxy_pass http://127.0.0.1:8900/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$arena_conn;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_read_timeout 1h;
    }
    location /comms/app/ {
        alias $REPO/ui/comms-app/dist/;
        try_files \$uri \$uri/ /comms/app/index.html;
        add_header Cache-Control no-cache;
    }
    location /comms/ {
        proxy_pass http://127.0.0.1:8900/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$arena_conn;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_read_timeout 1h;
    }
    location /livekit/ {
        proxy_pass http://127.0.0.1:7880/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$arena_conn;
        proxy_set_header Host \$host;
        proxy_read_timeout 1h;
    }

    # Everything else is the existing dashboard, with the Comms tab injected into its pages.
    location / {
        proxy_pass $DASHBOARD;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$arena_conn;
        proxy_set_header Accept-Encoding "";
        proxy_buffering off;
        proxy_read_timeout 1h;
        sub_filter_types text/html;
        sub_filter '</body>' '<script src="/comms-tab.js"></script></body>';
        sub_filter_once on;
    }
}
EOF
ln -sf /etc/nginx/sites-available/arena-comms /etc/nginx/sites-enabled/arena-comms
if ! nginx -t 2>/tmp/nginx-test.log; then
  cat /tmp/nginx-test.log
  rm -f /etc/nginx/sites-enabled/arena-comms
  echo "nginx config rejected; the existing dashboard was left untouched"
  exit 1
fi
systemctl reload nginx

step "Firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 443/tcp >/dev/null; ufw allow 7881/tcp >/dev/null; ufw allow 7882/udp >/dev/null
  [ -n "${COMMS_DOMAIN:-}" ] && ufw allow 80/tcp >/dev/null # the certificate check and its renewals
  echo "ufw: opened 443/tcp, 7881/tcp, 7882/udp"
else
  echo "ufw not active"
fi
echo "If this server has a Hetzner Cloud Firewall, allow inbound 443/tcp, 7881/tcp and 7882/udp."

step "Checks"
sleep 2
systemctl is-active arena-livekit arena-comms
curl -fsS --max-time 5 http://127.0.0.1:8900/health && echo
curl -fsSk --max-time 5 -o /dev/null -w "dashboard via https: %{http_code}\n" "https://127.0.0.1/"
curl -fsSk --max-time 5 https://127.0.0.1/comms-tab.js -o /dev/null -w "comms-tab.js: %{http_code}\n"
curl -fsSk --max-time 5 -o /dev/null -w "comms web app: %{http_code}\n" "https://127.0.0.1/comms/app/"
# The dashboard root redirects to /login when signed out, so look at the login page.
curl -fsSk --max-time 5 https://127.0.0.1/login | grep -c comms-tab.js | sed 's/^/tab script injected into the dashboard login page: /' || true

echo
echo "=============================================="
HOST="${COMMS_DOMAIN:-$IP}"
echo "Dashboard (with Comms tab):  https://$HOST/"
echo "Comms admin:                 https://$HOST/comms/admin"
if [ "$FIRST_RUN" = 1 ]; then
  echo "Admin login:                 admin / $COMMS_ADMIN_PASSWORD   (change it in the admin page)"
fi
[ -z "${COMMS_DOMAIN:-}" ] && echo "Your browser warns once about the self-signed certificate; accept it."
echo "=============================================="
