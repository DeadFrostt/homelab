# Rakazo, native k3s control plane on Ackermann

**Activated on Ackermann, 2026-10-27 at 22:57 America/Chicago
(2026-10-28 03:57 UTC).** All five production Deployments now request one replica.
The control plane runs under k3s/containerd on the same host; bot computers and
the Cloudflare edge connector intentionally remain on Docker.

## Post-cutover inspection, 2026-10-28 04:03 UTC

- PostgreSQL, supervisor, API, web and worker each have one ready pod on Ackermann,
  with zero restarts. API and supervisor health endpoints and native web return
  HTTP 200. The public root at `https://rakazo.deadfrost.dev/` returns HTTP 200.
- All five original `rakazo-trial-{postgres,supervisor,api,web,worker}-1` Docker
  containers are stopped and retained, with restart policy `no`. Production pods
  mount the original appdata, pgdata and webassets directories, not staging copies.
- The latest observed Cloudflare configuration sends Rakazo to
  `http://172.27.0.1:5173`; hooks remains `http://x-receiver:8787`.
- Live resources were applied directly. At inspection there was no Rakazo Argo CD
  Application; repository publication and reviewed merge into `main` are still
  needed for the existing ApplicationSet to adopt these resources. Do not apply
  the earlier zero-replica branch revision over production.
- The worker is ready but reports one delayed queued run (about 144 seconds at
  the latest inspected warning). Readiness does not prove successful dispatch;
  investigate the queue and verify an authenticated end-to-end run before calling
  the migration complete.
- Authenticated login/data, screens/WebSockets, post-cutover computer operations,
  integrations, Yeager SSH and Keepr still need final acceptance evidence. Earlier
  staging checks below do not establish post-cutover acceptance.
- Temporary `rakazo-staging` workloads and `case-migration-*` access/maintenance
  pods remain. Remove them only after required diagnostics and rollback checks.

The activation sequence stopped the original worker/API/supervisor and database
before starting their replacements, verified API/web health, enabled the native
worker, then stopped the original web. Retain the original containers and volumes
for rollback; follow the shutdown ordering below.

## Architecture and conventions

Follows this repository's per-service Kustomize directory, namespace, digest-pinned images, resource limits, probes and automatic Argo discovery. The native supervisor overlay is based on upstream `f9165321526c4923816c5e854c16ff078059bd07`. Renovate still proposes upgrades, but `rakazo/**` must not digest-automerge before overlay regression and live smoke tests.

All five control-plane services run as native containerd pods, pinned to `ackermann`, using `hostNetwork` and loopback-only internal service listeners, with the web listener restricted to the Docker-edge gateway `172.27.0.1:5173`. This deliberately avoids weakening Docker's raw-table isolation of child computers. Native supervisor/web can route to Docker computer bridge IPs directly; neither pretends to be a Docker Compose container. Computers continue on Docker, with host-enforced restricted bridge egress. The supervisor socket grants host-Docker administrative power, so it is a trusted control-plane component, not a tenant security boundary.

The original appdata, pgdata and webassets directories are retained in place as `hostPath: Directory` mounts. No directory is created silently. The explicit volume identity preserves existing per-bot network ownership and Docker volume subpaths. There is no additional backup. Existing Backblaze inclusion is permitted by the user. HostNetwork is not isolated by ordinary Kubernetes NetworkPolicy; database/API/supervisor listeners must stay loopback-only; web binds only its Docker-edge gateway. Do not expose the PostgreSQL/supervisor listeners with a Service or hostPort.

## Secret preservation

Per-component `rakazo-{api,worker,web,supervisor,postgres}-env` Secrets are externally provisioned Kubernetes Secrets, not tracked here. Prepare each through a private in-cluster pipe from its own corresponding source container (no cross-component credential broadening) from the authorized source environment, never command-line literal credentials or Git. Preserve all application/encryption/auth/integration credentials. Rewrite only database hostname to `127.0.0.1:5432`, internal API and supervisor URLs to loopback; retain public URL/origin. Include original POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB for probes. Validate the application's Infisical configuration still resolves its original store. Do not print `docker inspect` environment or cloudflared command arguments.

If adopting Infisical operator management later, verify the exact project/folder and provision the corresponding InfisicalSecret before replacing these Secrets. Do not guess a project ID or import unrelated shared secrets. The application's own Infisical store remains configured through preserved env.

## Verified staging evidence, 2026-10-28

- Exact pinned image, PostgreSQL16.15; isolated native supervisor, API, web and PostgreSQL running on Ackermann. Staged worker never enabled, so no duplicate production jobs.
- Source DB copied by private streaming pg_dump/pg_restore; original untouched. Initial roles restored without passwords, then staged app password restored from the preserved private Secret.
- 391 supervisor tests passed, 2 skipped, in isolated same-image k3s pod; latest targeted25 passed and TypeScript passed.
- Live native canary: provisioning, correct staged bind home sentinel, stop/resume identity, two display HTTP views, desktop observation, browser navigate/snapshot, canary deletion all passed. Host restricted egress probe passed.
- Preserved staged SSH private key used from canary to Yeager, BatchMode SSH command exited0. No private key printed.
- Cloudflared network to staged gateway web HTTP200 with an exact-source/destination staging-port firewall allow; temporary rule removed. UFW default INPUT DROP requires a persistent narrowly scoped production rule before public cutover. Source IP172.27.0.3, destination172.27.0.1, TCP5173, interfacebr-9b7ea5b085f4. Do not expose a wildcard listener or alter hooks.
- Staged API `/health` HTTP200, staged web `/` HTTP200. Public production remained HTTP200.
- Adversarial review found unsafe existing-computer bind reuse; now exact writable source bind matching is required, with regression tests. Production uses original Docker-volume identity rather than a copied bind, avoiding a split writable home.
- Staged home copy is not a final consistent snapshot while production agents are writing. Do not promote it or claim completion without final verification.

## Activation and rollback checklist

1. Verify the current Cloudflare remote tunnel hostname origin. Cloudflared is token-managed with no local config. The post-cutover route is `http://172.27.0.1:5173`, while hooks stays `http://x-receiver:8787`. Recheck the actual configuration before any future routing change.
2. Publish/review this branch through authorized repository access, and verify Argo renders the same active resources with one replica per Deployment. Preparation used zero replicas; that revision is no longer the desired production state. Do not directly push main.
3. Private per-component Secret bootstrap and validate database credentials, encryption/auth/store settings. Confirm backup mechanisms cover retained original host paths if relied on.
4. Verify computer egress against actual PodIP/ClusterIP targets. Cilium FORWARD ordering means the existing gateway/metadata probe alone does not prove cluster isolation. Do not weaken host firewall to make screens work.
5. Verify Yeager SSH, Keepr and connected integrations from a migrated/staged computer using preserved credentials, plus authenticated web screen/WebSocket path and public-origin login.
6. Record rollback steps and original container restart policies. Quiesce new API writes/worker dispatch. Stop original api/worker/supervisor before activating their replacements. Stop original PostgreSQL before starting the native PostgreSQL pod over its data directory. **Never run two PostgreSQL processes on the same PGDATA.** No schema upgrade is bundled; pinned app revision is unchanged.
7. Enable database first, verify recovery and application role access; then supervisor, API/web. Verify screens and public routing before enabling the singleton worker. A matching Pod label is not a distributed singleton lock.
8. Preserve old containers/volumes. Before rollback, stop native worker/API/supervisor and PostgreSQL, then restart originals on the same unchanged data. Do not copy stale staged data over production. Disable old restart policies before final activation so reboot cannot create duplicate controllers/DB processes. Keep the k3s replica state and GitOps desired state aligned.
9. Completion requires post-cutover authenticated UI/data, browser/computer, integrations, Yeager SSH, Keepr, worker dispatch, singleton checks and public-origin health, not only a successful `kubectl apply`.

## Current temporary resources

Namespace `rakazo-staging`: test PVCs, preserved private Secret, app pod, PostgreSQL pod, native supervisor, edge web and preparation pod. These are separate from the activated production namespace `rakazo`. Completed/failed test pods may be removed by exact names after logs are saved. Do not delete PVCs/Secrets before verifying final activation/rollback requirements.

## Permanent narrow origin firewall configuration

The completed configure-origin-firewall.sh host configuration script is run with sudo sh configure-origin-firewall.sh apply on Ackermann before switching the tunnel origin to http://172.27.0.1:5173. It validates the observed source IP, bridge and gateway, then persists only TCP5173 ingress from 172.27.0.3 on br-9b7ea5b085f4 to 172.27.0.1 through UFW. It does not change default policies, open the port broadly, or modify hooks. Run with remove to roll back. Revalidate if Docker networking changes. This host script is deliberately not auto-applied by Kustomize and introduces no privileged firewall controller.

Manifests and this script remain in the homelab repository on Yeager; node selectors place the migrated services on Ackermann. Production cutover has already occurred through direct application; the branch now records one replica per production service. Publishing the branch alone does not enable Argo CD adoption, which follows a reviewed merge into `main`.
