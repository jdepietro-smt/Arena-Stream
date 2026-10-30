#!/bin/bash
# One-shot installer for a blank Ubuntu server. Typed in the Hetzner console (lowercase only):
#   wget -q raw.githubusercontent.com/jdepietro-smt/arena-stream/main/comms/deploy/bootstrap.sh
#   bash bootstrap.sh
# Gets a real certificate for <ip-with-dashes>.sslip.io (no domain needed), or falls back to a self-signed one.
set -e
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
apt-get update -qq
apt-get install -y -qq git curl >/dev/null
[ -d /opt/arena-stream ] || git clone https://github.com/jdepietro-smt/Arena-Stream.git /opt/arena-stream
cd /opt/arena-stream && git pull -q
IP="$(curl -4fsS --retry 5 --retry-delay 3 https://api.ipify.org)"
DOM="$(echo "$IP" | tr . -).sslip.io"
sleep 5
if COMMS_DOMAIN="$DOM" bash comms/deploy/install.sh 2>&1 | tee /root/arena-comms-install.log && [ "${PIPESTATUS[0]}" = 0 ]; then
  echo "https://$DOM" > /root/arena-comms-url.txt
else
  echo "A certificate for $DOM could not be issued: installing with a self-signed certificate instead"
  bash comms/deploy/install.sh 2>&1 | tee -a /root/arena-comms-install.log
  echo "https://$IP (self-signed)" > /root/arena-comms-url.txt
fi
echo
echo "Server address:  $(cat /root/arena-comms-url.txt)"
echo "Admin login is in the box above (admin / password). Also saved in /root/arena-comms-install.log"
