# Rakazo, native k3s control plane on Ackermann

**Prepared, not activated.** Every Deployment intentionally has `replicas: 0`.
Do not enable Argo auto-sync/raise replicas until the gates below are satisfied.

## Architecture and conventions

Follows this repository's per-service Kustomize directory, namespace, digest-pinned images, resource limits, probes and automatic Argo discovery. The native supervisor overlay is based on upstream `f9165321526c4923816c5e854c16ff078059bd07`. Renovate still proposes upgrades, but `rakazo/**` must not digest-automerge before overlay regression and live smoke tests.

All five control-plane services run as native containerd pods, pinned to `ackermann`, using `hostNetwork` and loopback-only service listeners. This deliberately avoids weakening Docker's raw-table isolation of child computers. Native supervisor/web can route to Docker computer bridge IPs directly; neither pretends to be a Docker Compose container. Computers continue on Docker, with host-enforced restricted bridge egress. The supervisor socket grants host-Docker administrative power, so it is a trusted control-plane component, not a tenant security boundary.

The original appdata, pgdata and webassets directories are retained in place as `hostPath: Directory` mounts. No directory is created silently. The explicit volume identity preserves existing per-bot network ownership and Docker volume subpaths. There is no additional backup. Existing Backblaze inclusion is permitted by the user. HostNetwork is not isolated by ordinary Kubernetes NetworkPolicy; every service listener must stay loopback-only. Do not expose the PostgreSQL/supervisor listeners with a Service or hostPort.

## Secret preservation

`rakazo-env` is a pre-existing externally provisioned Kubernetes Secret, not tracked here. Prepare it through a private in-cluster pipe from the authorized source environment, never command-line literal credentials or Git. Preserve all application/encryption/auth/integration credentials. Rewrite only database hostname to `127.0.0.1:5432`, internal API and supervisor URLs to loopback; retain public URL/origin. Include original POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB for probes. Validate the application's Infisical configuration still resolves its original store. Do not print `docker inspect` environment or cloudflared command arguments.

If adopting Infisical operator management later, verify the exact project/folder and provision the corresponding InfisicalSecret before replacing this Secret. Do not guess a project ID or import unrelated shared secrets. The application's own Infisical store remains configured through preserved env.

## Verified staging evidence, 2026-10-28

- Exact pinned image, PostgreSQL16.15; isolated native supervisor, API, web and PostgreSQL running on Ackermann. Staged worker never enabled, so no duplicate production jobs.
- Source DB copied by private streaming pg_dump/pg_restore; original untouched. Initial roles restored without passwords, then staged app password restored from the preserved private Secret.
- 391 supervisor tests passed, 2 skipped, in isolated same-image k3s pod; latest targeted25 passed and TypeScript passed.
- Live native canary: provisioning, correct staged bind home sentinel, stop/resume identity, two display HTTP views, desktop observation, browser navigate/snapshot, canary deletion all passed. Host restricted egress probe passed.
- Staged API `/health` HTTP200, staged web `/` HTTP200. Public production remained HTTP200.
- Adversarial review found unsafe existing-computer bind reuse; now exact writable source bind matching is required, with regression tests. Production uses original Docker-volume identity rather than a copied bind, avoiding a split writable home.
- Staged home copy is not a final consistent snapshot while production agents are writing. Do not promote it or claim completion without final verification.

## Required activation gates

1. Verify current Cloudflare remote tunnel hostname origin and a supported native-k3s origin route. Current cloudflared is token-managed with no local config. Origin was not established from bounded logs. Do not stop the source web based on an assumed route.
2. Publish/review this branch through authorized repository access, and verify Argo renders the same zero-replica resources. Do not directly push main.
3. Private `rakazo-env` bootstrap and validate database credentials, encryption/auth/store settings. Confirm backup mechanisms cover retained original host paths if relied on.
4. Verify computer egress against actual PodIP/ClusterIP targets. Cilium FORWARD ordering means the existing gateway/metadata probe alone does not prove cluster isolation. Do not weaken host firewall to make screens work.
5. Verify Yeager SSH, Keepr and connected integrations from a migrated/staged computer using preserved credentials, plus authenticated web screen/WebSocket path and public-origin login.
6. Record rollback steps and original container restart policies. Quiesce new API writes/worker dispatch. Stop original api/worker/supervisor before activating their replacements. Stop original PostgreSQL before starting the native PostgreSQL pod over its data directory. **Never run two PostgreSQL processes on the same PGDATA.** No schema upgrade is bundled; pinned app revision is unchanged.
7. Enable database first, verify recovery and application role access; then supervisor, API/web. Verify screens and public routing before enabling the singleton worker. A matching Pod label is not a distributed singleton lock.
8. Preserve old containers/volumes. Before rollback, stop native worker/API/supervisor and PostgreSQL, then restart originals on the same unchanged data. Do not copy stale staged data over production. Disable old restart policies before final activation so reboot cannot create duplicate controllers/DB processes. Keep the k3s replica state and GitOps desired state aligned.
9. Completion requires post-cutover authenticated UI/data, browser/computer, integrations, Yeager SSH, Keepr, worker dispatch, singleton checks and public-origin health, not only a successful `kubectl apply`.

## Current temporary resources

Namespace `rakazo-staging`: test PVCs, preserved private Secret, app pod, PostgreSQL pod, native supervisor and preparation pod. Test pods have bounded active deadlines. No public route or worker was activated. Completed/failed test pods may be removed by exact names after logs are saved. Do not delete PVCs/Secrets before verifying final activation/rollback requirements.
