#!/usr/bin/env bash
# A/B check for audio loss: serves a bare LiveKit page (stock client, none of Arena Comms' audio code) from this
# server for 20 minutes, so its loss can be compared with the intercom's own connection test.
# Run on the server after install.sh:   bash comms/deploy/abtest.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="$REPO/ui/comms-app/dist"
[ -f /etc/arena-comms/env ] || { echo "run install.sh first"; exit 1; }
# shellcheck disable=SC1091
. /etc/arena-comms/env
[ -f "$DIST/index.html" ] || { echo "run install.sh first (web app not built)"; exit 1; }
cp "$REPO/ui/comms-app/node_modules/livekit-client/dist/livekit-client.umd.js" "$DIST/abtest-lk.js"
TOKEN="$(cd "$REPO/comms/server" && LK_KEY="$LK_KEY" LK_SECRET="$LK_SECRET" node --input-type=module -e '
import { AccessToken } from "livekit-server-sdk"
const t = new AccessToken(process.env.LK_KEY, process.env.LK_SECRET, { identity: "abtest-" + Date.now(), ttl: "20m" })
t.addGrant({ roomJoin: true, room: "abtest", canPublish: true, canSubscribe: false })
console.log(await t.toJwt())
')"
sed "s|__TOKEN__|$TOKEN|" "$REPO/comms/deploy/abtest.html" > "$DIST/abtest.html"
echo "open  https://<this server>/comms/app/abtest.html   (works for 20 minutes)"
( sleep 1200; rm -f "$DIST/abtest.html" "$DIST/abtest-lk.js" ) >/dev/null 2>&1 &
