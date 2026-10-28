#!/bin/sh
# Run as root ON ACKERMANN before switching the public tunnel origin.
# This is host configuration, deliberately not a privileged GitOps workload.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root on Ackermann' >&2; exit 1; }
[ "$(hostname -s)" = ackermann ] || { echo 'Refusing a different host' >&2; exit 1; }
command -v ufw >/dev/null
command -v docker >/dev/null
command -v ip >/dev/null
# Fail closed if Docker topology has changed. Inspect ONLY networking, not
# cloudflared command arguments, which contain the tunnel credential.
network=$(docker inspect --format '{{range $name, $net := .NetworkSettings.Networks}}{{if eq $net.IPAddress "172.27.0.3"}}{{$name}}{{end}}{{end}}' cloudflared)
[ -n "$network" ] || { echo 'Cloudflared source changed; update the exact rule before proceeding' >&2; exit 1; }
id=$(docker network inspect --format '{{.Id}}' "$network")
bridge="br-$(printf '%s' "$id" | cut -c1-12)"
[ "$bridge" = br-9b7ea5b085f4 ] || { echo 'Docker bridge changed; refusing' >&2; exit 1; }
ip -4 addr show dev "$bridge" | grep -q 'inet 172\.27\.0\.1/' || { echo 'Gateway changed; refusing' >&2; exit 1; }
ufw status | grep -q '^Status: active$' || { echo 'UFW is not active; refusing to enable or reset it' >&2; exit 1; }
case "${1:-apply}" in
  apply)
    # UFW persists this exact ingress allow in its host configuration. No
    # default policy changes, reload/reset, broad subnet, or forwarding allow.
    ufw allow in on "$bridge" proto tcp from 172.27.0.3 to 172.27.0.1 port 5173 comment 'rakazo-cloudflared-native-web'
    ;;
  remove)
    ufw --force delete allow in on "$bridge" proto tcp from 172.27.0.3 to 172.27.0.1 port 5173
    ;;
  *) echo 'Usage: configure-origin-firewall.sh [apply|remove]' >&2; exit 2 ;;
esac
ufw status
