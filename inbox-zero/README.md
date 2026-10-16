# Inbox Zero on Yeager

GitOps-managed personal Inbox Zero deployment in namespace `inbox-zero`.
Canonical URL: **https://zero.deadfrost.dev**, behind Cloudflare Tunnel and
the app's one-account login allowlist. The tunnel targets
`http://inbox-zero.inbox-zero.svc.cluster.local:3000`. Tailscale Serve on port
3017 still forwards to NodePort **30317**; OAuth uses the canonical public URL.

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
The image patches its bundled Gaxios adapter to use a shared in-process transport;
the runtime also covers direct multipart Gmail batch requests. It accounts for
subrequest quota costs and spaces work at **1,500 units/minute**, splitting
read-only batches into at most **10 requests** each to avoid large bursts.
Quota errors, including errors inside HTTP-200 multipart responses, pause all
Gmail work for at least **65 seconds** (or longer Retry-After). Read-only
requests retry once through that shared cooldown; writes are never replayed
by this guard. Cancelled requests release pending queue positions.
Foreground Gmail reads take priority over background analysis, and cheap
label/profile requests take priority over bulk reads. `/api/threads` pages are
capped at 10 while retaining provider continuation tokens, so Process Past
Emails continues across smaller pages. Browser disconnects cancel queued
Gmail work instead of leaving abandoned reads behind. Other providers,
including Lithos, are unaffected.

The browser mailbox protocol uses POST requests; these receive foreground
priority too. Its source is decorated before modules load to bound enumeration,
search, and change pages at 10 messages. Google scope `primary` continues the
complete archive scan with its original continuation tokens. A separate
`primary-live` history stream initializes from the current Gmail checkpoint
without re-enumerating the archive, so new-mail catch-up does not wait for
thousands of older messages to finish downloading. Neither scope clears local
mail or deletes provider messages. Existing browser caches retain their progress.

Keep **one web replica** and the `Recreate` strategy: this is a single-process
budget for one mailbox. Scaling requires a distributed per-account limiter.
The pacer is mounted from a hashed ConfigMap so changes trigger a rollout.
The preload upgrades the pinned image's adapter hook before server modules load;
the writable compiled chunks are owned by UID 1001. The exact adapter signature
is checked at build and startup, failing closed if incompatible. Upstream
upgrades must revalidate the patch and tests.

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

## Automatic Gmail handling: polling prepared, activation pending

Browser mail display now runs live history catch-up independently of archive
loading, and continues polling while the mailbox is open. Pub/Sub is not required
for that browser read path.

`inbox-zero-gmail-poll` is prepared as a one-minute fallback for closed-browser
notifications and existing-rule automation. It is deliberately **suspended** and
its command contains **`--check`** pending owner approval for automatic labels,
archives, and drafts. Its read-only check passed against the account; no history
cursor or mailbox content was changed. Sending/deletion restrictions remain set.

On activation, a previously unset processing cursor is initialized at the current
Gmail history position, so enabling the poller does not replay the existing inbox.
Past mail remains an explicit Process Past Emails operation. Later polls read
Gmail's profile (one quota unit), compare the durable app cursor, and deliver new
history through the existing authenticated internal webhook. That pipeline saves
its own progress; a failed poll does not advance it. OAuth tokens stay in memory,
and jobs log counts/status only. Network policies restrict the poller to DNS,
PostgreSQL, the web service, and public HTTPS.

```sh
# Safe: the prepared CronJob currently runs --check only.
kubectl create job -n inbox-zero --from=cronjob/inbox-zero-gmail-poll inbox-zero-poll-check-NEW_ID
kubectl logs -n inbox-zero job/inbox-zero-poll-check-NEW_ID
```

After owner approval, remove `--check`, set `suspend: false`, and verify a new
incoming message is processed and appears in Assistant History. Public app login
remains required. No subscription or extra Gmail quota is needed for polling.

## Optional Google Pub/Sub delivery

Watch renewal remains suspended until real Pub/Sub delivery is configured.
The configured topic placeholder must be replaced with the actual project ID:
`projects/inbox-zero-511720/topics/inbox-zero-emails`. The topic and push
subscription have not been created by this deployment.

1. Create the topic in project `inbox-zero-511720`; grant Publisher to
   `gmail-api-push@system.gserviceaccount.com`.
2. Set `GOOGLE_PUBSUB_TOPIC_NAME` to that topic in Git and restart web/worker.
3. Create a push subscription to
   `https://zero.deadfrost.dev/api/google/webhook?token=TOKEN`, using the existing
   verification secret privately. This route must not receive an interactive
   upstream login challenge.
4. Enable `inbox-zero-watch-renewal`, establish the mailbox watch, and verify a
   new incoming message reaches the webhook and Assistant History.
5. Once push delivery is verified, suspend the polling fallback if desired.

Google OAuth must use the public callbacks `/api/auth/callback/google` and
`/api/google/linking/callback`; the app already generates the public login callback.
