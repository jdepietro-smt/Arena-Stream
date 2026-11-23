#!/bin/bash
# Sets THIS server up as a second Arena site: a relay and a backup directory, in one step, with nothing to look up or type but the main
# server's address. It asks the main server for the access key's partner (the relay password) itself, so no password is ever typed.
#
#   cd /opt/arena-stream; git pull; bash link/join.sh 5.78.236.254
#
# Everything typed there is plain lowercase, digits and punctuation that needs no Shift key. Safe to run again.
# The access key used is the one built into the Link apps; if the main server uses another, give it after the address:
#   bash link/join.sh 5.78.236.254 theotherkey
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$HERE/.."
MAIN="$1"
KEY="${2:-5jpmzaedzkm5}"
step() { echo; echo "== $*"; }

[ -n "$MAIN" ] || { echo "give the main server's address, for example:  bash link/join.sh 5.78.236.254"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
command -v curl >/dev/null || { apt-get update -qq; apt-get install -y -qq curl >/dev/null; }
command -v python3 >/dev/null || { apt-get install -y -qq python3 >/dev/null; }
[ -f "$REPO/relay/lowlat/install.sh" ] && [ -f "$REPO/link/directory/install.sh" ] || { echo "the installers are missing: run git pull first"; exit 1; }

step "Asking the main server ($MAIN) for the relay password"
JSON="$(curl -fsS --max-time 10 -H "X-Arena-Key: $KEY" "http://$MAIN:8002/v1/config")" || {
  echo "could not get it from $MAIN. Check that the address is right, that TCP 8002 is open in the Hetzner firewall for"
  echo "this server, and that the access key is right (a different key can be given after the address)."
  exit 1
}
SECRET="$(printf '%s' "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("relaySecret",""))')"
[ -n "$SECRET" ] || { echo "the main server answered but has no relay password set"; exit 1; }
echo "got it (${#SECRET} characters)"
if [ -n "$JOIN_DRY" ]; then echo "dry run: stopping here"; exit 0; fi

export LINK_KEY="$KEY" LINK_RELAY_SECRET="$SECRET" RELAY_SECRET="$SECRET"

step "Relay"
bash "$REPO/relay/lowlat/install.sh"

step "Backup directory"
bash "$REPO/link/directory/install.sh"

ME="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "================ this server is ready ================"
echo "Open these in the Hetzner firewall for this server if they are not already:  UDP 8895 (relay) and TCP 8002 (directory)."
echo
echo "Then, in each Link app (Settings):"
echo "   Relay server:       $MAIN,$ME"
echo "   Directory address:  http://$MAIN:8002,http://$ME:8002"
echo "And in the portal, Monitoring, Backup directory:  http://$ME:8002"
