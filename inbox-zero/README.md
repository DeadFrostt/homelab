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
format-dependent subrequest quota costs and spaces work at a maximum of **4,500 actual units/minute**,
splitting read-only batches into at most **two requests** to avoid large bursts.
Full/default/raw message reads cost 60 units; metadata/minimal reads cost 20.
Full thread reads cost 120 units. These are the current Gmail API costs for
this project's 6,000-unit per-user quota. The shared ceiling leaves 1,500
units/minute of headroom even if one mailbox consumes every slot. All linked
accounts currently share this ceiling, rather than each receiving a separate budget.
Quota failures halve the effective rate (once per minute, down to one eighth
of the maximum); after two quiet minutes it recovers gradually.
Quota errors, including errors inside HTTP-200 multipart responses, pause all
Gmail work for at least **65 seconds** (or longer Retry-After). Read-only
requests retry once through that shared cooldown; writes are never replayed
by this guard. Cancelled requests release pending queue positions.
Foreground Gmail reads take priority over background analysis, and cheap
label/profile requests take priority over bulk reads. After four foreground
reads, a waiting background read receives a quota slot so automated rules
cannot starve during a continuous archive import. Requests waiting at least
10 seconds receive FIFO service regardless of priority, so archive pages also
make progress under continuous automatic processing. A privacy-safe pacing
summary logs granted quota units, request counts, maximum queue wait, and
queue length each minute. `/api/threads` pages are
capped at five while retaining provider continuation tokens, so Process Past
Emails continues across smaller pages. Browser disconnects cancel queued
Gmail work instead of leaving abandoned reads behind. Other providers,
including Lithos, are unaffected.

The browser mailbox protocol uses POST requests; interactive reads receive
foreground priority too. Archive enumeration runs below automatic rule processing
and bulk reads, so opening a mailbox does not give its full import equal priority
with Process Past Emails. Its source is decorated before modules load to bound enumeration,
search, and change pages at 10 messages. Google scope `primary` continues the
complete archive scan with its original continuation tokens. A separate
`primary-live` history stream initializes from the current Gmail checkpoint
with a `delta` checkpoint (the upstream baseline returns a snapshot cursor).
Existing snapshot checkpoints are migrated using their original history ID,
while each response retains the client's original `from` position for an atomic
commit. This avoids a second archive scan, so new-mail catch-up does not wait for
thousands of older messages to finish downloading. Neither scope clears local
mail or deletes provider messages. Existing browser caches retain their progress.

Gmail history is listed in pages of 500 records (up to 20 pages per call), then
at most ten distinct messages are hydrated. Live history reads get a quota
slot before bulk work, with an aged background slot after four live reads to
preserve import progress. Newly added inbox messages are processed
before pending label changes, including arrivals received while an earlier
backlog is still pending. Legacy history-page continuations are re-listed from
their original history ID so new arrivals are not left behind old label pages.
Initial enumeration and live change reads request Gmail `format=metadata`,
so subjects, previews, senders, timestamps and labels load without downloading
all message bodies. These list-only responses neither store snippet fallbacks
as complete bodies nor enqueue automatic body hydration for every imported item.
Opening a message uses the existing full body/attachment hydration path. Provider
search and AI/automation reads retain full content. Browser checkpoints and cached
mail are preserved. Minute pacing logs include per-priority request/unit totals.

Pending IDs are scoped to the authenticated mailbox in a bounded, expiring
in-process cache. The opaque cursor also retains the original replay baseline;
cache eviction or an app restart replays history instead of losing pending
updates. Other providers and archive continuation tokens retain their behavior.

Keep **one web replica** and the `Recreate` strategy: this is a single-process
budget shared by linked mailboxes. Scaling requires a distributed per-account limiter.
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

## Automatic Gmail handling: one-minute polling fallback

Browser mail display now runs live history catch-up independently of archive
loading, and continues polling while the mailbox is open. Pub/Sub is not required
for that browser read path.

`inbox-zero-gmail-poll` runs every minute for closed-browser notifications and
existing-rule automation. The owner explicitly approved automatic labels,
archives, and drafts. Sending/deletion restrictions remain set. Its preceding
read-only check passed without changing the processing cursor or mailbox.

On activation, a previously unset processing cursor is initialized at the current
Gmail history position, so enabling the poller does not replay the existing inbox.
Past mail remains an explicit Process Past Emails operation. Later polls read
Gmail's profile (one quota unit), compare the durable app cursor, and deliver new
history through the existing authenticated internal webhook. That pipeline saves
its own progress; a failed poll does not advance it. OAuth tokens stay in memory,
and jobs log counts/status only. Network policies restrict the poller to DNS,
PostgreSQL, the web service, and public HTTPS. Polling waits for authenticated
database-backed app readiness during restarts before notifying the webhook.

```sh
# Run one authorized processing pass immediately.
kubectl create job -n inbox-zero --from=cronjob/inbox-zero-gmail-poll inbox-zero-poll-check-NEW_ID
kubectl logs -n inbox-zero job/inbox-zero-poll-check-NEW_ID
```

The poller is active with `suspend: false` and no `--check` argument. The script
also supports `--check` for read-only diagnostics; that mode never invokes
automation or initializes a processing cursor. Public app login remains required.
No Pub/Sub subscription or quota increase is needed for polling.

## Daily-use verification (2026-10-16)

- Real authenticated browser: messages rendered while archive enumeration
  advanced through three 10-message pages; live history reads returned HTTP 200
  before archive completion, with no Waiting to sync banner during the test.
- The owner-sent test message appeared in the browser and its existing rule
  reached `APPLIED`. The approved notification path delivered a mailbox-change
  event to the browser.
- Reloading preserved cached mail and the test message, with zero new bootstrap
  requests. Archive continuation was retained.
- The active one-minute poller initialized safely, delivered changes, and waited
  through an app restart. Sending and deletion remain disabled.
- All 28 pacing/sync/polling tests and CI checks passed. ArgoCD and Gatus are
  healthy. CNPG's daily offsite base backup completed on 2026-10-16.

The entire archive is not yet cached in each browser. Older mail imports
incrementally while the browser mailbox engine is running; new-mail catch-up
is independent. Closing the browser pauses that local archive import, while
server polling continues automatic rule handling.

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

### Two-account bulk processing follow-up (2026-10-16)

After linking a second Google mailbox, Gmail again returned per-user quota errors
and Process Past Emails spent minutes in layered retries. The Cloud quota page
showed 6,000 units/minute/user; the observed project usage was much higher than
the application's intended budget, so an increased quota was not assumed to fix it.
Read batches now contain two subrequests, thread pages contain at most five,
archive enumeration has lower priority, and quota feedback reduces the pacing
rate before gradually recovering. Both connected accounts passed authenticated
thread fetches. A bounded, one-page browser bulk run on the second account fetched
five threads in about 11 seconds and finished within 40 seconds; all five rule
executions were APPLIED. No quota errors occurred during this verification.
This verifies a small run, not completion of either full archive or a sustained
large backfill under the project's effective quota.

### Stalled inbox follow-up (2026-10-16)

Two independent defects contributed to a mailbox stopping at 66 locally cached
conversations: archive requests could starve behind sustained higher-priority
traffic, and the upstream bootstrap baseline returned a snapshot cursor that
made the added live stream enumerate old mail again. Queue aging now guarantees
continued archive service. Google bootstrap baselines use history/delta cursors;
existing snapshot checkpoints preserve their original history ID and migrate
on the next read, retaining the original client commit position and cached mail.

Verification: 33 regression tests and all deployment CI checks passed. Against
real Gmail, a legacy snapshot position returned a delta checkpoint with its
client commit position preserved, roundComplete true, and zero pending changes.
A fresh browser received successive 10-message archive pages with live delta
reads, no waiting banner, and increasing local counts. The owner refreshed the
affected existing browser and confirmed its count was increasing beyond 66.
Argo reported Synced/Healthy, polling jobs succeeded, and no Gmail quota errors
were recorded in the final six-minute observation. Full archive import remains
incremental; this is not a claim that all older mail is already cached.

## Import quota accounting correction

The prior guard counted full message reads as 20 units, while Gmail currently
charges 60. This understated request costs and explains quota failures despite
apparently conservative local totals. A 6,000-unit budget permits only about
100 full message reads/minute before other calls, rather than 6,000 emails/minute.
Metadata-first import uses 20 units/message and avoids immediate repeated body
hydration during live catch-up. The previous 1,500 locally counted units/minute
was close to 4,500 actual units/minute when dominated by full message reads.
The new 4,500 ceiling is therefore an accurately counted ceiling, not a blind
increase of Google's limit. Existing adaptive cooldown/recovery remains active.

References: [Gmail quotas](https://developers.google.com/workspace/gmail/api/reference/quota),
[client synchronization](https://developers.google.com/workspace/gmail/api/guides/sync).

Verification of the correction:
- 49 regression tests passed, including format-dependent/default read costs,
  scoped metadata rewriting, preserved continuation tokens, suppression of
  automatic body hydration, and full content reads outside list sync.
- In a fresh authenticated browser, the previous two 10-message pages took
  15.3 and 28.5 seconds and carried ten full bodies each. Deployed metadata
  pages took approximately 4.4–10.8 seconds and carried no bodies or required
  hydration keys. Visible mailbox counts continued to increase.
- Explicit full-body hydration returned content in 0.32–0.44 seconds. A separate
  message selected by Gmail's `has:attachment filename:pdf` query returned its
  PDF attachment descriptor through the normal hydration API. This tests the
  descriptor path, not downloading the attachment bytes.
- The final isolated browser check had zero browser errors and no automatic
  body downloads before the explicit request. Short-lived diagnostic login
  sessions were revoked after each run.
- Runtime accounting recorded archive metadata reads at 20 units/request;
  no quota cooldowns occurred during the checks. Argo reported Synced/Healthy,
  scheduled Gmail polls succeeded, and all three repository CI checks passed.

Import time still depends on competing work and the active browser cache. Both
linked mailboxes and open browser imports share the 4,500-unit ceiling. Even
without competing work, indexing 15,404 messages at 20 units each needs roughly
69 minutes of quota time; it is not an instant download of the entire archive.
Responsive list browsing and on-demand content do not require that import to
finish. Other browsers maintain separate local caches and repeat their import.

## Bulk cleanup read optimization

The sender cleanup path fetched 100 full conversations per request before
queuing archive commands. Those full thread reads cost 120 units each. Sender
inbox scans now use at most ten conversations/page, preserving provider filters
and continuation tokens, and request thread metadata (40 units each). This is
scoped to `/api/threads/basic` with both `fromEmail` and `labelId=INBOX`; general
thread previews retain full content.

Conversation membership preparation and metadata-operation execution/inspection
also request metadata. They retain complete message IDs, normal label reads,
per-target outcomes and archive verification. Mutating calls are neither changed
nor replayed by this guard. Send operations, body hydration and AI reads retain
full content. Unknown attachment flags from metadata cannot erase previously
hydrated attachment evidence.

The operation-executor hook has its own pinned compatibility guard at both image
build and runtime startup. All 57 regression tests pass. The initial read-only
production baseline fetched ten conversations in 18.2 seconds and returned
664,865 HTML characters. After deployment, the bounded ten-conversation page
completed in 8.1 seconds with zero HTML/text body characters. A distinct next
page also returned ten conversations successfully in 8.1 seconds. Complete
conversation membership returned in 1.15 seconds; archive-state inspection
returned in 0.58 seconds. These production checks were read-only and dispatched
no archive/unsubscribe writes. Argo reported Synced/Healthy and the temporary
diagnostic session was revoked.

Bulk Unsubscribe still processes senders sequentially and can wait on external
unsubscribe websites. This optimization reduces Gmail preparation/readback work;
it does not make external sites instantaneous. The shared 4,500-unit budget is
unchanged. See [UPGRADING.md](UPGRADING.md) for controlled release upgrades and
rollback limitations.
