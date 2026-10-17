# Inbox Zero native source releases

The application image is built from `DeadFrostt/inbox-zero:selfhosted`, using
`selfhosted/image/Dockerfile` at the repository root. The fork's
`selfhosted/upstream-revision.txt` records the included upstream revision.
Gmail pacing, metadata reads, replay-safe history and operation integration live
in application source. This deployment does not mount a runtime patcher or
rewrite upstream compiled JavaScript.

The canonical code, regression tests and image build workflow are maintained in
that fork. This repository owns Kubernetes manifests and deployed poller scripts.
Keep poller behavior aligned with the fork. Image changes require a complete
source build with TypeScript checks enabled, passing application/core/poller
regressions, and an isolated staging boot with migrations, database-backed health
and the worker against disposable PostgreSQL/Redis. Staging must have no real
OAuth/API credentials, public ports or mail/AI egress.

Before rollout, compare database migrations with the deployed source, verify a
fresh encrypted recovery snapshot and retain the old immutable image. Import the
validated ARM64 image into the pinned node's container runtime and record its
actual manifest digest. Update every application image reference together:
web, worker, worker init container and all four CronJobs. Keep
`imagePullPolicy: Never`, the existing node pin and runtime account policies.
Do not reintroduce the removed `gmail-runtime` ConfigMap/preload.

Validate rendered manifests, require CI for the exact GitOps PR head, then merge
through the normal Argo workflow. Confirm Argo Synced/Healthy, both deployments
Ready on the expected image, database-backed internal/public health and a
successful regularly scheduled poll job. Do not trigger live mailbox actions as
upgrade smoke tests.

A source sync alone does not update production. Automated maintenance must follow
this native source workflow; changing the old prebuilt-image FROM pin cannot
produce the current application. An image rollback does not reverse database
migrations or completed Gmail actions. Assess schema compatibility first.

The recovery image scripts read `release.json` for the current source revision,
image digest and platform. Back up the newly imported release with
`scripts/backup-image.sh`; `scripts/restore-image.sh` restores that release.
The previous compiled-patch image and its encrypted legacy artifact remain
available for rollback. Neither image backup changes the shared database
recovery snapshot policy.
