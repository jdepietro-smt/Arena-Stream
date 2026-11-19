#!/usr/bin/env bash
# Load test for the Comms media relay (LiveKit), using LiveKit's own load tester.
#
#   cd /opt/arena-stream; git pull; bash comms/deploy/load-test.sh all
#   bash comms/deploy/load-test.sh current16          (one level only)
#
# Each level creates N "publishers" (one audio track each, like a gateway channel) and S "subscribers" that receive every
# track, so the relay forwards N x S audio streams. The levels match comms/server/tools/capacity-sim.mjs:
#
#   bridged16   16 arenas, gateways listen only to what they bridge     140 x 5   =    700 streams
#   current16   16 arenas, gateways listen to everything (old behaviour) 140 x 18  =  2,520 streams
#   bridged35   35 arenas, gateways listen only to what they bridge     315 x 4   =  1,260 streams
#   current35   35 arenas, gateways listen to everything                315 x 35  = 11,025 streams
#
# It uses its own room ("loadtest"), but it loads the real relay: run it when nobody is on the intercom (it stops if
# anyone is connected, unless you set FORCE=1). Run on this server it measures the relay's CPU; the load tester itself also
# uses CPU here, so treat the numbers as a little pessimistic. For the network side, run the same script on a second
# machine with:  LK_KEY=... LK_SECRET=... bash load-test.sh all wss://your-server/livekit
set -euo pipefail

ETC=/etc/arena-comms
# shellcheck disable=SC1091
[ -f "$ETC/env" ] && . "$ETC/env"
: "${LK_KEY:?LK_KEY is not set (it is in $ETC/env on the Comms server)}"
: "${LK_SECRET:?LK_SECRET is not set}"

WHICH="${1:-all}"
URL="${2:-ws://127.0.0.1:7880}"
DURATION="${DURATION:-90s}"
RAMP="${RAMP:-20}"          # participants started per second

declare -A PUBS=([bridged16]=140 [current16]=140 [bridged35]=315 [current35]=315)
declare -A SUBS=([bridged16]=5   [current16]=18  [bridged35]=4   [current35]=35)
ORDER=(bridged16 current16 bridged35 current35)

if [ "$WHICH" != all ] && [ -z "${PUBS[$WHICH]:-}" ]; then
  echo "Unknown level '$WHICH'. Use: all ${ORDER[*]}"; exit 1
fi

# Do not load the relay while people are using it.
PEERS="$(curl -fsS --max-time 3 http://127.0.0.1:8900/health 2>/dev/null | sed -E 's/.*"peers":([0-9]+).*/\1/' || true)"
if [[ "$PEERS" =~ ^[0-9]+$ ]] && [ "$PEERS" -gt 0 ] && [ -z "${FORCE:-}" ]; then
  echo "$PEERS people or gateways are connected to the intercom right now. Run this when it is quiet, or set FORCE=1."
  exit 1
fi

if ! command -v lk >/dev/null; then
  echo "Installing the LiveKit command line tool (lk)..."
  curl -sSL https://get.livekit.io/cli | bash >/dev/null
fi
ulimit -n 65535 2>/dev/null || true

CORES="$(nproc)"
case "$URL" in
  ws://127.*|ws://localhost*|wss://127.*) IFACE=lo ;;
  *) IFACE="$(ip route show default | awk '{print $5; exit}')" ;;
esac
echo "Relay: $URL   cores: $CORES   network interface sampled: $IFACE   each level runs $DURATION"

txbytes() { awk -v i="$IFACE:" '$1==i {print $10}' /proc/net/dev; }
relay_cpu() { ps -C livekit-server -o %cpu= 2>/dev/null | awk '{s+=$1} END {printf "%.0f", s}'; }

declare -A R_CPU_PEAK R_CPU_AVG R_TX_PEAK R_STATUS

run_level() {
  local name="$1" p="${PUBS[$1]}" s="${SUBS[$1]}"
  echo
  echo "=== $name: $p publishers x $s subscribers = $((p * s)) streams"
  local log; log="$(mktemp)"
  lk load-test --url "$URL" --api-key "$LK_KEY" --api-secret "$LK_SECRET" \
    --room loadtest --audio-publishers "$p" --subscribers "$s" --duration "$DURATION" --num-per-second "$RAMP" >"$log" 2>&1 &
  local pid=$! n=0 peak=0 sum=0 txpeak=0 last t
  last="$(txbytes)"
  sleep 3
  while kill -0 "$pid" 2>/dev/null; do
    local c; c="$(relay_cpu)"; c="${c:-0}"
    t="$(txbytes)"; local mbit=$(( (t - last) * 8 / 3 / 1000000 )); last="$t"
    [ "$c" -gt "$peak" ] && peak="$c"
    [ "$mbit" -gt "$txpeak" ] && txpeak="$mbit"
    sum=$((sum + c)); n=$((n + 1))
    printf '\r  relay CPU %3s%% of one core (%s%% of the machine)   network out %s Mbit/s      ' "$c" "$((c / CORES))" "$mbit"
    sleep 3
  done
  wait "$pid" && R_STATUS[$name]=ok || R_STATUS[$name]="load tester reported a problem"
  echo
  tail -n 18 "$log"
  rm -f "$log"
  R_CPU_PEAK[$name]=$peak; R_CPU_AVG[$name]=$(( n ? sum / n : 0 )); R_TX_PEAK[$name]=$txpeak
}

if [ "$WHICH" = all ]; then
  for l in "${ORDER[@]}"; do run_level "$l"; echo "(resting 20 s)"; sleep 20; done
else
  run_level "$WHICH"
fi

echo
echo "================ SUMMARY (machine has $CORES cores; 100% = one core) ================"
printf '%-10s %-9s %-9s %-12s %-12s %s\n' level streams "CPU avg" "CPU peak" "net peak" result
for l in "${ORDER[@]}"; do
  [ -n "${R_CPU_PEAK[$l]:-}" ] || continue
  printf '%-10s %-9s %-9s %-12s %-12s %s\n' "$l" "$(( ${PUBS[$l]} * ${SUBS[$l]} ))" "${R_CPU_AVG[$l]}%" "${R_CPU_PEAK[$l]}%" "${R_TX_PEAK[$l]} Mbit/s" "${R_STATUS[$l]}"
done
echo "A level is comfortable if the peak CPU stays under about $((CORES * 60))% (60% of the machine) and the load tester reports no packet loss."
