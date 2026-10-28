#!/bin/sh
# Cluster-only deny before Cilium's FORWARD accepts. Does not restrict the
# explicitly retained Tailscale integrations, public DNS or Internet access.
set -eu
[ "$(id -u)" = 0 ] || exit 1
[ "$(cat /etc/hostname | cut -d. -f1)" = ackermann ] || exit 1
for cidr in 10.42.0.0/16 10.43.0.0/16; do
  case "${1:-apply}" in
    apply)
      iptables -w -t raw -C PREROUTING -i rakazo-c+ -d "$cidr" -m comment --comment rakazo-deny-cluster -j DROP 2>/dev/null || iptables -w -t raw -I PREROUTING 1 -i rakazo-c+ -d "$cidr" -m comment --comment rakazo-deny-cluster -j DROP
      ;;
    remove)
      if iptables -w -t raw -C PREROUTING -i rakazo-c+ -d "$cidr" -m comment --comment rakazo-deny-cluster -j DROP 2>/dev/null; then
        iptables -w -t raw -D PREROUTING -i rakazo-c+ -d "$cidr" -m comment --comment rakazo-deny-cluster -j DROP
      fi
      ;;
    *) echo 'Usage: configure-cluster-egress.sh [apply|remove]' >&2; exit 2 ;;
  esac
done

# Cilium service DNAT occurs before netfilter for the host-network API endpoint.
# Block only its verified TCP port from computer bridges, never Yeager SSH.
case "${1:-apply}" in
  apply)
    iptables -w -t raw -C PREROUTING -i rakazo-c+ -d 100.105.150.16/32 -p tcp --dport 6443 -m comment --comment rakazo-deny-cluster-api -j DROP 2>/dev/null || iptables -w -t raw -I PREROUTING 1 -i rakazo-c+ -d 100.105.150.16/32 -p tcp --dport 6443 -m comment --comment rakazo-deny-cluster-api -j DROP
    ;;
  remove)
    if iptables -w -t raw -C PREROUTING -i rakazo-c+ -d 100.105.150.16/32 -p tcp --dport 6443 -m comment --comment rakazo-deny-cluster-api -j DROP 2>/dev/null; then
      iptables -w -t raw -D PREROUTING -i rakazo-c+ -d 100.105.150.16/32 -p tcp --dport 6443 -m comment --comment rakazo-deny-cluster-api -j DROP
    fi
    ;;
esac
