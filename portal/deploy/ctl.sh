#!/bin/bash
# Root helper for the portal's Admin page. The portal runs as an unprivileged user and cannot restart
# services itself; it leaves one service name in the request file and systemd (arena-portal-ctl.path)
# runs this script as root. Only the names below are ever acted on; anything else is logged and dropped.
REQ=/var/lib/arena-portal/ctl/request
[ -e "$REQ" ] || [ -L "$REQ" ] || exit 0
if [ -L "$REQ" ] || [ ! -f "$REQ" ]; then rm -f "$REQ"; exit 0; fi
name="$(head -c 64 "$REQ" | head -n 1 | tr -d '\r')"
rm -f "$REQ"
case "$name" in
  mediamtx|arena-lowlat|arena-link-directory|arena-linkd|arena-portal|arena-comms|arena-livekit|nginx)
    logger -t arena-portal-ctl "restart $name"
    systemctl restart "$name.service" ;;
  *)
    logger -t arena-portal-ctl "refused a request that is not on the list" ;;
esac
exit 0
