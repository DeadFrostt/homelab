On Ackermann, before syncing the supervisor:

    sudo bash install-client-config.sh
    sudo bash restrict-computer-egress.sh

The installed firewall service persists its rules across reboot. Only rakazo-c*
bridges may open 172.17.0.1:1056; host loopback health probes are also allowed, and all other sources are dropped. Other host ports
and the original forwarded destination restrictions remain blocked.

The supervisor mounts these operator-owned client defaults into new computer
containers. Existing computers need the three files copied to the corresponding
paths in computer-spec.ts (a restart alone does not add Docker mounts).

The gateway forwards permitted SOCKS CONNECT requests to the loopback Tailscale
proxy. It pins public DNS results, blocks private/LAN/metadata/cluster addresses,
and blocks port 6443, including over tailnet IPs. Known short MagicDNS names are
mapped in proxy/proxy.cjs; other peers work by their 100.x address. IPv6 targets
are rejected. Tailscale grants still control which tailnet services may be used.

Clients without proxy support do not gain direct routes. For example:

    curl http://yeager:3015/
    curl --proxy socks5h://172.17.0.1:1056 http://100.105.150.16:3015/

The first command uses /home/rakazo/.curlrc. Public browsing also works through the gateway.
