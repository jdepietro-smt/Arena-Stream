#!/bin/bash
# Root helper for the portal's Admin page. The portal runs as an unprivileged user and cannot restart
# services or start the capacity test itself; it leaves one request word in the request file and systemd
# (arena-portal-ctl.path) runs this script as root. Only the words below are ever acted on; anything else
# is logged and dropped.
D=/var/lib/arena-portal
REQ=$D/ctl/request
[ -e "$REQ" ] || [ -L "$REQ" ] || exit 0
if [ -L "$REQ" ] || [ ! -f "$REQ" ]; then rm -f "$REQ"; exit 0; fi
name="$(head -c 64 "$REQ" | head -n 1 | tr -d '\r')"
rm -f "$REQ"
case "$name" in
  mediamtx|arena-lowlat|arena-link-directory|arena-linkd|arena-portal|arena-comms|arena-livekit|nginx)
    logger -t arena-portal-ctl "restart $name"
    systemctl restart "$name.service" ;;
  captest-start)
    # The capacity test runs as its own transient service (no portal CPU limit, low priority, hard time limit).
    if systemctl is-active --quiet arena-captest.service; then logger -t arena-portal-ctl "capacity test already running"; exit 0; fi
    NODE="$(command -v node)"
    if [ -z "$NODE" ] || [ ! -f "$D/ctl/captest.json" ] || [ ! -f /opt/arena-portal/captest.js ]; then logger -t arena-portal-ctl "capacity test cannot start"; exit 0; fi
    logger -t arena-portal-ctl "capacity test start"
    systemd-run --unit=arena-captest --collect --uid=nobody --gid=nogroup \
      -p Nice=10 -p RuntimeMaxSec=1500 -p MemoryMax=2G \
      -p EnvironmentFile=/etc/arena-portal/env -p WorkingDirectory=/opt/arena-portal \
      "$NODE" /opt/arena-portal/captest.js --config "$D/ctl/captest.json" --out "$D/captest" ;;
  captest-stop)
    logger -t arena-portal-ctl "capacity test stop"
    systemctl stop arena-captest.service ;;
  *)
    logger -t arena-portal-ctl "refused a request that is not on the list" ;;
esac
exit 0
