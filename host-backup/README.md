# K3s state backup

The control-plane host creates an online SQLite backup every day, verifies it
with SQLite's quick integrity check, bundles the K3s server token and host
configuration, encrypts the bundle with age, and uploads it through the existing
offsite rclone destination.

Local encrypted copies are retained for 2 days and remote copies for 14 days.
The private age identity is deliberately not stored in this repository.

Install or update the units:

```bash
sudo install -m 0755 host-backup/backup-verify.sh /usr/local/sbin/backup-verify.sh
sudo install -m 0755 host-backup/k3s-state-backup.sh /usr/local/sbin/k3s-state-backup
sudo install -m 0644 host-backup/k3s-state-backup.service /etc/systemd/system/
sudo install -m 0644 host-backup/k3s-state-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now k3s-state-backup.timer
```

Run and verify an immediate encrypted backup:

```bash
sudo systemctl start k3s-state-backup.service
sudo journalctl -u k3s-state-backup.service
```

For disaster recovery, verify `SHA256SUMS`, decrypt
`k3s-state.tar.gz.age` with the separately held age identity, stop K3s, and
restore both `state.db` and `token`. Never replace a live datastore.

## Tailscale overlay guard (Yeager)

The nodes communicate over Tailscale, and Cilium VXLAN uses that connection.
On September 30, 2026, Tailscale repeatedly selected `10.42.1.176` and
`10.42.2.14` as peer transport endpoints. This creates a recursive dependency:
Tailscale transport enters the pod overlay that itself runs over Tailscale.
The switches coincided with API timeouts and lost operator leadership leases.

The guard rejects host UDP from tailscaled's fixed source port `41641` to the
pod CIDR and drops UDP from the pod CIDR to that listen port. Other pod traffic,
VXLAN, and normal Tailscale endpoints remain permitted. This is a host service,
so `host-backup` must remain excluded from the Argo ApplicationSet.

Install on Yeager:

```bash
sudo install -m 0755 host-backup/tailscale-overlay-guard.sh /usr/local/sbin/tailscale-overlay-guard
sudo install -m 0644 host-backup/tailscale-overlay-guard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tailscale-overlay-guard.service
```

After reloading UFW or changing firewall rules, reload the guard and verify its
rules precede any broad ACCEPT rules:

```bash
sudo systemctl reload tailscale-overlay-guard.service
sudo iptables -vnL OUTPUT --line-numbers
sudo iptables -vnL INPUT --line-numbers
```

If tailscaled's listen port or the pod CIDR changes, update the script first.
To roll back just this fix, run
`sudo systemctl disable --now tailscale-overlay-guard.service`.

## Content verification and retention

Both host backup jobs now verify downloaded remote content against SHA-256
checksums, exit unsuccessfully when verification fails, and prune only after
verification succeeds. The last verified local snapshot is protected from local
retention. `BACKUP_VERIFY_DEADLINE` defaults to ten minutes per attempt.

The installed rclone logger deadlocked when automatically detecting journald.
A captured Go stack showed recursive entry into its log handler mutex. The
helper removes `JOURNAL_STREAM` only from rclone's environment; stderr continues
to reach journald. This was tested under real systemd.

Run `bash host-backup/test-backup-verify.sh` for real content-corruption, missing
object, checksum-path and protected-retention regression tests.
