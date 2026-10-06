#!/usr/bin/env bash
# Keep the node's Tailscale transport off the Cilium overlay it carries.
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
action=${1:-start}
case "$action" in
  start|stop) ;;
  *) echo "Usage: $0 [start|stop]" >&2; exit 2 ;;
esac

# This cluster uses the fixed tailscaled listen port 41641 on Yeager.
# Match that port only: ordinary pod traffic and VXLAN remain permitted.
output_rule=(-p udp --sport 41641 -d 10.42.0.0/16 -m comment
  --comment tailscale-overlay-guard -j REJECT --reject-with icmp-port-unreachable)
input_rule=(-p udp --dport 41641 -s 10.42.0.0/16 -m comment
  --comment tailscale-overlay-guard -j DROP)

update_rule() {
  local chain=$1
  shift
  # Reinsert at the top on reload in case another service prepended ACCEPTs.
  while iptables -w 5 -C "$chain" "$@" 2>/dev/null; do
    iptables -w 5 -D "$chain" "$@"
  done
  if [[ $action == start ]]; then
    iptables -w 5 -I "$chain" 1 "$@"
  fi
}

update_rule OUTPUT "${output_rule[@]}"
update_rule INPUT "${input_rule[@]}"
