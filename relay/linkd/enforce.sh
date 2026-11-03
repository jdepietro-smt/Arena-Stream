#!/bin/bash
# Turn share-link enforcement on or off:  bash relay/linkd/enforce.sh on|off
# "on" means remote readers need a valid, unexpired link; "off" logs only.
case "$1" in on) v=1;; off) v=0;; *) echo "usage: enforce.sh on|off"; exit 1;; esac
sed -i "s/^Environment=LINKD_ENFORCE=.*/Environment=LINKD_ENFORCE=$v/" /etc/systemd/system/arena-linkd.service
systemctl daemon-reload
systemctl restart arena-linkd
echo "linkd enforce=$v"
