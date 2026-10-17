# Controlled Inbox Zero upgrades

Upstream releases do not automatically update this deployment. The application
uses an immutable image digest, and the self-hosting image derives from a pinned
upstream image/source commit. Argo applies changes committed to this repository;
it does not follow upstream release tags.

The custom runtime is mounted from a versioned ConfigMap. It patches the pinned
image's compiled Gmail transport, mailbox source and operation executor before
application modules load. Those patches are version-specific. They are not a
promise of compatibility with arbitrary upstream releases.

## What we maintain

- `image/gmail-pacing.cjs`: format-dependent quota accounting, shared adaptive
  pacing, cancellation/fair scheduling, live history catch-up, metadata-first
  imports, and metadata-only cleanup preparation/readback.
- `image/patch-gmail-transport.cjs`: applies and checks the same compatibility
  hooks at image build time. Runtime startup checks all three hooks again.
- `image/*.test.cjs`: behavior and pinned-signature/idempotence regressions.
- `scripts/poll-gmail.mjs`: the minute Gmail notification fallback. It invokes
  the normal server webhook; the server runs the user's enabled rules.

Provider calls that send messages or perform AI analysis retain full content.
Cleanup still uses the upstream durable command queue and provider writes. This
patch changes preparation/readback costs, not which messages are acted upon.

## Before changing the pinned version

1. Read the target release notes and database migrations. Record the current
   upstream commit/digest, custom image digest, manifests and runtime ConfigMap.
2. Take a database backup and confirm the restore procedure. Retain the old
   custom image in the cluster's container runtime; the deployment uses
   `imagePullPolicy: Never` and cannot recover a missing local image by pulling it.
3. Update the Dockerfile's upstream tag and digest deliberately. Keep the source
   commit associated with that exact image for reviewing provider changes.
4. Run `node --test inbox-zero/image/*.test.cjs inbox-zero/scripts/poll-gmail.test.mjs`
   and syntax-check the maintenance/poller scripts. Existing unit tests alone
   cannot prove a new compiled image is compatible.
5. Build the custom image. Its patch script must find compatible transport,
   mailbox-source and operation-executor hooks. A missing hook is a failed
   upgrade: inspect upstream changes, update the adapter and tests, then rebuild.
   Do not bypass the compatibility checks.
6. Start that image with Node as the entrypoint, before supplying production
   credentials, to confirm the runtime preload can patch the actual bundles:
   `docker run --rm --entrypoint node CUSTOM_IMAGE -e "console.log('runtime compatible')"`.
7. Test in an isolated environment using a restored database. Prevent its
   worker, cron jobs, Gmail poller and enabled rules from acting on the live
   mailbox. Verify login, current mail, archive pagination, live catch-up,
   on-demand bodies/attachments, and operation metadata inspection. Run any
   archive-write test only on messages deliberately selected for that test.
8. Import the reviewed image into the pinned cluster node and update all image
   references together. Commit the manifests/runtime, let Argo roll out one web
   replica, and check database-backed health, sync progress and quota logs.

## Rollback

Revert the image/runtime manifests to the recorded release only if the database
schema remains compatible. An upstream migration may require a database restore
or a forward fix; switching images does not reverse migrations. A database
restore also does not undo Gmail actions that already completed. Assess those
separately before a rollback.

Keeping the patches together and tested makes upgrades reviewable, but this is
still more maintenance than an untouched upstream deployment. Moving compatible
fixes into upstream source is the long-term way to reduce this patch surface.
