#!/bin/bash
# Point the comms server at a domain name and give it a real certificate.
#   bash comms/deploy/set-domain.sh 5-161-235-143.sslip.io
# Lowercase only, so it can be typed in the Hetzner console. Safe to repeat.
set -e
[ -n "${1:-}" ] || { echo "usage: bash comms/deploy/set-domain.sh <name>"; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
COMMS_DOMAIN="$1" bash comms/deploy/install.sh
echo
echo "https://$1" > /root/arena-comms-url.txt
echo "Server address: https://$1"
