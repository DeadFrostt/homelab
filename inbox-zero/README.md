# Inbox Zero on Yeager

GitOps-managed personal Inbox Zero deployment in namespace `inbox-zero`.
The existing Tailscale HTTPS address is preserved in Infisical. Tailscale Serve
on port 3017 forwards to the app's NodePort **30317**. Cloudflare Tunnel changes
are deliberately deferred. Its future target can be
`http://inbox-zero.inbox-zero.svc.cluster.local:3000` or Yeager's NodePort.

## Components

- Web and BullMQ worker: pinned upstream revision `59cf6d2`, non-root UID 1001,
  no service-account token, no host mounts or Codex credentials.
- AI: Lithos `zai-org/GLM-5.3-Flash-ultra-chat` for every AI role; no CLI fallback.
- PostgreSQL 16: CloudNativePG `inbox-zero-pg`, 10Gi local-path storage on Yeager.
- Redis 7: authenticated, persistent AOF queue/cache, 2Gi PVC and no eviction.
- Redis HTTP bridge: internal-only authenticated endpoint.
- Maintenance: 15-minute queue/scheduled-action checks; daily retention cleanup.
- Gatus: authenticated database-backed `/api/health` check.

This follows the stack's single-instance, Yeager-local storage model. A host
failure still requires recovery; it does not provide multi-node HA.

## Secrets and account settings

Infisical project `fd17c52d-3b20-4958-9bc5-e061833835e9`, environment `prod`,
contains the existing OAuth credentials, encryption keys, account allowlist,
base URL, database/Redis credentials and Lithos key. The operator materializes
`inbox-zero-env` and the CNPG basic-auth secret. No credential values belong in Git.

Sending and destructive-action restrictions from the pilot are preserved.
The existing rules label, archive, and draft; review them in Assistant before
bulk processing. A configured AI provider does not itself trigger background rules.

After changing secrets or the base URL, wait for Infisical reconciliation and
restart the web/worker deployments. Environment variables in running pods do
not refresh automatically.

## Gmail request pacing

The upstream app can exhaust Gmail's per-user minute budget during catch-up.
The image patches its bundled Gaxios adapter to use a shared in-process pacer;
the runtime also covers direct multipart Gmail batch requests. It accounts for
subrequest quota costs and spaces work at **3,000 units/minute**. Cancelled
requests release pending queue positions. Other providers, including Lithos,
are unaffected.

Keep **one web replica** and the `Recreate` strategy: this is a single-process
budget for one mailbox. Scaling requires a distributed per-account limiter.
The pacer is mounted from a hashed ConfigMap so changes trigger a rollout.
The exact bundled adapter signature is checked at build time; upstream upgrades
must revalidate the patch and tests.

## Image lifecycle

The application image is locally built and imported into Yeager's containerd,
not published to a public registry. Manifests pin its OCI digest and use
`imagePullPolicy: Never`. The `ghcr.io/deadfrostt/inbox-zero` reference is a local
image identifier, not a promise that this package exists publicly.

The image source is in `image/`; its base is an immutable upstream digest.
CI runs pacing and script checks without package/release write permissions.
For an upgrade, build and import on Yeager, inspect the new OCI manifest digest,
then update the deployment, worker and CronJob image references in Git together.
Do not reuse an existing digest for different content.

```sh
docker build -t ghcr.io/deadfrostt/inbox-zero:NEW_VERSION inbox-zero/image
docker save ghcr.io/deadfrostt/inbox-zero:NEW_VERSION | sudo k3s ctr images import --local --digests -
node --test inbox-zero/image/gmail-pacing.test.cjs
```

`scripts/backup-image.sh` stores the current version, compressed and age-encrypted,
in the existing private backup destination and verifies native offsite hashes.
`scripts/restore-image.sh` restores it using the separately held age identity.
Run these host scripts as root. No public image archive or credentials are published.

## Backups and verified migration

- CNPG archives WAL to the stack's B2 bucket under `cnpg/inbox-zero`.
- Daily base backup at 03:40 UTC operator schedule (`0 40 3 * * *`),
  with 14-day retention. CNPG schedules use UTC.
- Velero's existing wildcard namespace schedule includes this namespace;
  PostgreSQL volumes are excluded because CNPG handles them.
- The existing portable backup inventory includes Inbox Zero in priority/full
  encrypted logical dumps and bootstrap-secret recovery.
- Redis AOF survives pod restarts. Redis is operational state, not the canonical
  mailbox database; CNPG/portable backups preserve accounts, rules and tokens.

Migration verification on 2026-10-16:
all 104 tables matched the frozen Compose database row-for-row; one user,
one connected mailbox, ten rules, one OAuth account and 297 migration records
were preserved. Fourteen Redis keys were transferred with expirations.
An immediate offsite CNPG backup was restored into a disposable cluster and
all 104 tables matched. An encrypted portable snapshot also passed offsite hash
verification. The old Compose database and encrypted pre-migration snapshot
are retained for recovery; the old app/worker are stopped.

Before upgrading CNPG to 1.31, migrate its native barman backup configuration to
the Barman Cloud plugin, alongside the stack's other CNPG clusters.

## Operations

```sh
kubectl get pods,cronjobs -n inbox-zero
kubectl get cluster,backup,scheduledbackup -n inbox-zero
kubectl logs -n inbox-zero deployment/inbox-zero --tail=60
kubectl logs -n inbox-zero deployment/inbox-zero-worker --tail=60
kubectl rollout restart -n inbox-zero deployment/inbox-zero deployment/inbox-zero-worker
kubectl create job -n inbox-zero --from=cronjob/inbox-zero-maintenance inbox-zero-maintenance-check-NEW_ID
kubectl exec -i -n inbox-zero deployment/inbox-zero -- node --input-type=module < inbox-zero/scripts/verify-ai.mjs
```

The synthetic AI check consumes a small amount of Lithos credit and does not
read or alter real mail. The app readiness check validates PostgreSQL; its
liveness check only tests the listener, avoiding restart loops during a DB outage.

## Public access and automatic Gmail notifications: deferred

The app works through its current private URL. Automatic incoming-email rule
execution still needs Google's Pub/Sub delivery, which the owner deferred with
public access. Watch renewal is explicitly **suspended** until that is configured.
The planned topic is `projects/734522807349/topics/inbox-zero-emails`; creating
that resource and the push subscription is still required.

When adding the public hostname:

1. Point the Cloudflare Tunnel at the service/NodePort without changing this
   app's namespace or exposing PostgreSQL/Redis.
2. Update `NEXT_PUBLIC_BASE_URL` in Infisical and both Google OAuth callbacks:
   `/api/auth/callback/google` and `/api/google/linking/callback`.
3. Create the Pub/Sub topic and grant Gmail's service account Publisher access.
4. Create a push subscription to `/api/google/webhook?token=TOKEN`, using the
   existing verification secret. Google must reach this route without an
   interactive upstream login challenge; normal app login remains enabled.
5. Enable `inbox-zero-watch-renewal`, establish the mailbox watch, and verify a
   new incoming email appears in Assistant History with the expected label.

Changing ingress alone does not complete notification setup.
