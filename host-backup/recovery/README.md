# Independent home recovery

Yeager remains primary. Ackermann runs `ackermann-dr`, a separate Ubuntu 24.04
LXD VM with four CPUs, 8 GiB RAM and a 40 GiB SSD-backed root disk. Its K3s
v1.35.4+k3s1 cluster has fresh credentials, secrets encryption and separate
10.52/16 pod and 10.53/16 service networks. It is not a member of the primary
cluster. The home Docker media/game workloads remain outside this VM.

## Access without Yeager

On Ackermann, the owner's `deadfrost` account belongs to the LXD group:

```bash
lxc exec ackermann-dr -- bash
k3s kubectl get nodes
k3s secrets-encrypt status
curl -fsS http://127.0.0.1:9387/health
```

The guest uses static 10.67.46.10/24 on the existing LXD NAT bridge; the host's
firewall was not changed. VM autostart and the guest systemd services persist.
The freshness endpoint listens on guest port 9387 and reports backup readiness
separately from promotion readiness. It has no credentials in its responses.

## Backup and custody

On Yeager, install `portable-backup.py`, `portable-backup.sh`, `retention.py`
and `backup-verify.sh` into `/usr/local/lib/homelab-dr`. Install the portable
service/timer files into `/etc/systemd/system` and enable both timers. Priority
sets run every 30 minutes; full sets run daily. Both services have a shared lock,
a one-core CPU limit, 2 GiB memory limit, and an 8 GiB free-disk reserve.

The source's existing backup config supplies the age recipient and B2
destination. `/etc/homelab-dr/source-rclone.conf` supplies a separate B2 writer
credential limited to `k3s-backups-yeager/host-state/portable/yeager/`.
`source-signing.key` is a private Ed25519 signing key; generate it once and
preserve its public trust anchor. Never commit either private credential.

Each set contains encrypted online SQLite snapshots, stable file copies,
PostgreSQL logical dumps, role exports, and indispensable application secrets
and stopped resource definitions. The signed SHA256SUMS covers the encrypted
payloads and metadata. Backup success requires remote download verification.
File changes during an application's consistency interval refuse the set.
Logical dumps do not provide recovery between snapshot points.

On the guest, install the recovery Python files and `retention.py` into
`/usr/local/lib/homelab-dr`. `/etc/homelab-dr` is mode 0700 and its credential
files are mode 0600:

- `identity.txt`: approved backup decryption identity.
- `source-signing.pub`: trusted source public key, copied independently.
- `rclone.conf`: B2 key with only list/read permissions for the portable prefix.
- `recovery.json`: expected guest cluster UID, remote and application allowlists.

The actual guest kube-system UID is `c4bc6bed-e44c-4469-af62-4d759ccc6312`.
Rebuilding the VM requires updating this identity through a deliberate owner
bootstrap; an identity mismatch refuses mutation. Do not copy the primary K3s
datastore/token into this guest.

Enable `homelab-dr-mirror.timer` and `homelab-dr-status.service` using the
provided unit files. The mirror runs every fifteen minutes independently of
Yeager, Infisical and Authentik. It checks signatures, every file checksum,
every encrypted payload and snapshot age before recording a usable set. It
retains the latest priority and full sets independently. Unsigned, incomplete,
corrupt, incorrectly signed and stale sets are refused.

Retention prefers 48 recent sets, 14 daily full sets and eight weekly full
sets, with a 20 GiB cache budget. The newest set containing each protected
application is always retained. Budget overflow of indispensable sets stops
pruning. Source remote pruning occurs only after a new offsite set verifies;
the home credential cannot upload or delete remote backups.

The owner should additionally hold the age identity, B2 account recovery and
Cloudflare/Oracle access on an independent personal device/offline medium.
The VM copy protects against Yeager loss; it does not establish that third copy.

## Isolated restore sequence

Run these commands inside the guest. Set `snapshot` to a signed verified cache
directory. Each helper checks the cluster identity before making changes.

```bash
python3 /usr/local/lib/homelab-dr/recovery.py mirror
python3 /usr/local/lib/homelab-dr/recovery.py verify "$snapshot"
python3 /usr/local/lib/homelab-dr/prepare.py "$snapshot"
python3 /usr/local/lib/homelab-dr/restore-file-drill.py "$snapshot"
python3 /usr/local/lib/homelab-dr/restore-postgres.py "$snapshot"
```

Install CNPG chart 0.29.1 in this independent cluster first, with its operator
selected onto `ackermann-dr`. Label its namespace `homelab.dev/site=home-recovery`
so isolated database pods can communicate with their operator. No production
backup destination or ScheduledBackup is configured for the home databases.

`prepare.py` creates isolated namespaces, imports necessary secrets/config,
converts services to private ClusterIP and leaves all app replicas at zero.
It excludes tunnels, production cron jobs and old CNPG services/PVCs. Outbound
application traffic permits only recovery namespaces and DNS; PostgreSQL gets
the additional local API access its instance manager requires. No workers or
public tunnels are activated by a restore helper.

The file helper uses short-lived claim consumers for delayed local-path
provisioning, then restores only to empty home PVC directories. Active writers,
foreign destinations, archive traversal and archive links are refused. The
database helper creates new version-matched AMD64 databases; it refuses any
existing cluster and preserves original roles and database metadata/ownership.
For a new drill, deliberately discard the old isolated application namespaces
first. Never discard a home site that has accepted authoritative user writes.

Start only the service being checked, retaining outbound isolation. Infisical
also requires its Redis StatefulSet. Authentik's worker remains stopped during
initial validation. Gatus's pilot config has no alert destination. Use the
provided rejection and PostgreSQL drill scripts for repeatable checks.

## Manual promotion and failback gates

Public promotion is not enabled. A backup-health HTTP 200 does not mean these
gates have passed:

1. Independently establish Oracle instance control and Cloudflare routing
   control. Record the primary instance/tunnel/DNS identifiers and baseline
   configurations, and verify credentials outside the primary services.
2. Fence Yeager's writers with independent cloud control; verify the instance
   is stopped and cannot restart writers through automation. Quiesce any old
   worker jobs that could write, and prevent GitOps/updates from restarting
   the old site. Loss of connectivity or DNS removal alone is insufficient.
3. Record the accepted signed recovery point and actual data loss. Restore
   fresh data into stopped home workloads. Validate synthetic login, secret
   decryption, notes synchronization, budget writes and attachments privately.
4. Establish and verify independent encrypted backups of new home writes
   before exposing writable services. Source-only backups do not meet this gate.
5. Activate the separate home tunnel and switch only validated application
   hostnames. Verify original service security/Access policies and single-site
   routing. Never run both independent datasets behind one live hostname.
6. Once home accepts writes, it is authoritative. A routing rollback to stale
   Yeager data is unsafe. Restore home backups into a fenced/rebuilt cloud site,
   perform a final synchronization while writes are stopped, validate it, then
   switch once and reseed the recovery site. Failback remains manual.

A public promotion/failback drill and final RTO are pending those gates. No
automatic promotion, primary outage, public routing switch or claimed one-hour
RPO guarantee follows from the isolated tests alone.
