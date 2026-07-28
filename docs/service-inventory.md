# Service Inventory Ledger

> **Purpose:** Document every known workload in the homelab (k3s Argo-managed + Docker),
> its ownership tier, canonical source, exposure, state persistence, backup status, and
> a recommended disposition for the Docker/k3s rationalization project.
>
> **Last updated:** `2026-07-28`

---

## Conventions

| Field        | Meaning |
|--------------|---------|
| **Tier**     | 0 = platform infrastructure (auth, secrets, ingress, DB operators, backup); 1 = self-hosted app; 2 = experimental / dev / sandbox; 3 = unknown / orphan |
| **Source**   | Canonical path in the k3s repo (`kube-stack/…`) or Docker compose path |
| **Owner**    | `infra` = platform team (me); `user` = personal data; `dev` = app project owner |
| **Exposure** | `none` = cluster/internal only; `nodeport` = k8s NodePort; `host` = Docker host bind; `cloudflared` = CF Tunnel |
| **Data**     | `stateful-db` = own database; `stateful-vol` = persistent volume; `stateful-both` = DB + volume; `stateless` = no persist |
| **Backup**   | Who owns backup (Velero/Kopia, or other) |
| **Disp.**    | `retain` = keep where it is; `migrate candidate` = could move between platforms; `retire candidate` = low-value; `unknown` = needs investigation |

---

## K3s — Argo CD Managed (24 apps, all Synced Healthy)

| # | Service | Tier | Source (kube-stack/) | Owner | Exposure | Data | Backup | Disp. |
|---|---------|------|----------------------|-------|----------|------|--------|-------|
| 1 | **actual-budget** | 1 | `actual-budget/` | user | NodePort 30507 | stateful-vol | Velero/Kopia | retain |
| 2 | **authentik** | 0 | `authentik/` | infra | NodePort 30900, rac-outpost | stateful-db (CNPG) | Velero/Kopia | retain |
| 3 | **beszel-agent** | 1 | `beszel-agent/` | infra | none (internal) | stateless | Velero/Kopia | retain |
| 4 | **cloudflared** | 0 | `cloudflared/` | infra | Cloudflare Tunnel | stateless | — | retain |
| 5 | **cnpg-system** | 0 | `cnpg-system/` | infra | none (operator) | stateless | — | retain |
| 6 | **cobalt** | 1 | `cobalt/` | user | NodePort 30009 | stateful-vol (MinIO) | Velero/Kopia | retain |
| 7 | **couch-db** | 1 | `couch-db/` | user | none (internal) | stateful-vol (CouchDB) | Velero/Kopia | migrate candidate |
| 8 | **degoog** | 2 | `degoog/` | user | NodePort 30444 | stateless | Velero/Kopia | retain |
| 9 | **flaresolverr** | 1 | `flaresolverr/` | infra | NodePort 30191 | stateless | Velero/Kopia | retain |
| 10 | **gatus** | 1 | `gatus/` | infra | NodePort 30386 | stateless | Velero/Kopia | retain |
| 11 | **infisical** | 0 | `infisical/` | infra | NodePort 30820 | stateful-db (CNPG) | Velero/Kopia | retain |
| 12 | **infisical-operator** | 0 | `infisical-operator/` | infra | none (operator) | stateless | — | retain |
| 13 | **matrix** | 1 | `matrix/` | user | NodePorts 30899, 30030, 30081 | stateful-db (CNPG) | Velero/Kopia | retain |
| 14 | **matrix-coturn** | 1 | `matrix-coturn/` | user | none (internal) | stateless | Velero/Kopia | retain |
| 15 | **matrix-livekit** | 1 | `matrix-livekit/` | user | NodePort 30070 | stateless | Velero/Kopia | retain |
| 16 | **mealie** | 1 | `mealie/` | user | NodePort 30925 | stateful-vol | Velero/Kopia | retain |
| 17 | **netdata** | 1 | `netdata/` | infra | none (no running pods) | stateless | Velero/Kopia | retain |
| 18 | **pelican** | 1 | `pelican/` | user | NodePort 30180 | stateful-vol (panel) | Velero/Kopia | retain |
| 19 | **syncthing** | 1 | `syncthing/` | user | NodePort 30384 | stateful-vol | Velero/Kopia | retain |
| 20 | **termix** | 1 | `termix/` | user | NodePort 30100 | stateless | Velero/Kopia | retain |
| 21 | **trawl** | 1 | `trawl/` | infra | NodePort 30192 | stateful-db (Redis) | Velero/Kopia | retain |
| 22 | **vaultwarden** | 0 | `vaultwarden/` | user | NodePort 30222 | stateful-vol | Velero/Kopia | retain |
| 23 | **velero** | 0 | `velero/` | infra | none (internal) | stateless | (is backup infra) | retain |
| 24 | **zipline** | 1 | `zipline/` | user | NodePort 30003 | stateful-db (CNPG) | Velero/Kopia | retain |

> CNPG clusters: `authentik-pg`, `infisical-pg`, `matrix-pg`, `zipline-pg` — all healthy.
> Velero backs up every Argo app namespace with Kopia maintain jobs running every ~4h.

---

## Docker — Compose Projects

### From `~/docker-compose/`

| # | Service | Tier | Source | Owner | Exposure | Data | Backup | Disp. |
|---|---------|------|--------|-------|----------|------|--------|-------|
| D1 | **actual-ai** | 2 | `~/docker-compose/actual-ai/` | user | none (internal) | stateless | none | migrate candidate |
| D2 | **actual-api** | 1 | `~/docker-compose/actual-api/` | user | Host :5007 (internal companion) | stateful-vol (budget cache) | unknown | retain |
| D3 | **backclone** | 1 | `~/docker-compose/backclone/` | user | Host :8080 | stateful-vol | none | retain |
| D4 | **caddy** | 0 | `~/docker-compose/caddy/` | infra | Host :80, :443 | stateless | — | retain |
| D5 | **glance** | 1 | `~/docker-compose/glance/` | user | Host :8087 (+ modules, uptime-kuma-ext) | stateless | none | retain |
| D6 | **keeper** | 2 | `~/docker-compose/keeper/` | dev | Host :3015 | stateful-db (PG) | none | retain |
| D7 | **komodo** | 0 | `~/docker-compose/komodo/komodo/` | infra | Host :9120 | stateful-db (Mongo) | none | retain |
| D8 | **pwpush** | 1 | `~/docker-compose/pwpush/` | user | Host :5101 | stateless | none | retain |
| D9 | **searxng** | 1 | `~/docker-compose/searxng/` | user | Host :8888 | stateless | none | retain |
| D10 | **transmission** | 1 | `~/docker-compose/transmission/` | user | none (VPN via gluetun) | stateful-vol (downloads) | none | retain |
| D11 | **wings** | 1 | `~/docker-compose/wings/` | user | Host :2022, :8787 | stateful-vol (server data) | none | retain |

### From `~/projects/`

| # | Service | Tier | Source | Owner | Exposure | Data | Backup | Disp. |
|---|---------|------|--------|-------|----------|------|--------|-------|
| D12 | **crows** | 2 | `~/crows/` | dev | Host :8020 (api), :5411 (db) | stateful-db (PG) | none | retain |
| D13 | **o** | 2 | `~/projects/o/` | dev | Host :3001 | stateless | none | retain |
| D14 | **poke-soccer** | 2 | `~/projects/poke-soccer/` | dev | Host :1378 | stateless | none | retain |
| D15 | **deploy** (hawking) | 2 | `~/projects/hawking/deploy/` | dev | Host :1400 (broker), :8731 (nginx) | stateful-db (PG) + Redis | none | retain |
| D16 | **room-ate** | 2 | `~/room-ate/room-ate/` | dev | Host :3023 | stateful-db (PG) | none | retain |

### From Komodo stacks (`/etc/komodo/stacks/`)

| # | Service | Tier | Source | Owner | Exposure | Data | Backup | Disp. |
|---|---------|------|--------|-------|----------|------|--------|-------|
| D17 | **pocketbase** | 2 | `/etc/komodo/stacks/pocketbase/` | user | Host :8090 | stateful-vol | none | retain |
| D18 | **backrest** | 1 | `/etc/komodo/stacks/backrest/` | user | unknown (compose exists) | stateful-vol | — | unknown |
| D19 | **couchdb-ubuntu** | — | `/etc/komodo/stacks/couchdb-ubuntu/` | user | compose exists, may be duplicating k3s couch-db | stateful-vol | — | retire candidate |
| D20 | **freshrss** | 1 | `/etc/komodo/stacks/freshrss/` | user | compose exists | stateful-db | — | unknown |
| D21 | **kopia** | 1 | `/etc/komodo/stacks/kopia/` | user | compose exists (may overlap k8s Velero/Kopia) | stateful-vol | — | retire candidate |
| D22 | **palmr** | 2 | `/etc/komodo/stacks/palmr/` | user | compose exists | unknown | — | unknown |
| D23 | **peekaping** | 2 | `/etc/komodo/stacks/peekaping/` | user | compose exists | unknown | — | unknown |
| D24 | **stirlingpdf** | 1 | `/etc/komodo/stacks/stirlingpdf/` | user | compose exists | stateless | — | unknown |

> **Note on Komodo stacks:** Several stacks exist as compose files but may not be currently running.
> `couchdb-ubuntu` and `kopia` likely overlap with k3s deployments — verify before cleanup.

---

## Docker — Pelican Wings-managed (game server yolks)

| Container | Image | Status | Notes |
|-----------|-------|--------|-------|
| **88b4aebd-7d44-4bb6-a598-c9cb867be717** | `ghcr.io/parkervcp/yolks:java_25` | Up 12 days | Pelican Wings-managed Minecraft server (port 25565) |
| **257c3f10-3a44-487e-8a79-e092f10873d7** | `ghcr.io/pterodactyl/yolks:java_25` | Up 12 days | Pelican Wings-managed Minecraft server (port 25566) |

> Both UUID-named containers are ephemeral game server instances managed by the Pelican Wings daemon (`pelican-wings`). They are not independently owned services — treat them as data of the Wings deployment. No backup responsibility assigned here; Wings handles server state.

---

## Retired / Removed

| Service | Platform | Reason |
|---------|----------|--------|
| **airpipe-relay** | Docker standalone | Fully retired; all artifacts removed. |
| **cosmos-mongo-ESn** | Docker standalone | Fully retired; all artifacts removed. |
| **cloudflared** (Docker) | Docker Compose | Permanently retired after k3s Cloudflared pinned to Yeager (PR #106). |

---

## Summary

| Platform | Count | Tier 0 | Tier 1 | Tier 2 | Tier — |
|----------|-------|--------|--------|--------|--------|
| **K3s (Argo)** | 24 | 7 | 16 | 1 | 0 |
| **Docker (compose)** | 24 | 2 | 11 | 10 | 1 |
| **Docker (wings-managed)** | 2 | 0 | 2 | 0 | 0 |
| **Total** | **50** | **9** | **29** | **11** | **1** |

### Disposition breakdown

| Disposition | Count | Notes |
|-------------|-------|-------|
| retain | 41 | Keep where it is for now |
| migrate candidate | 2 | actual-ai, couch-db (k3s) |
| retire candidate | 2 | couchdb-ubuntu (komodo), kopia (komodo) — potential overlaps |
| unknown | 5 | backrest, freshrss, palmr, peekaping, stirlingpdf — Komodo stacks needing investigation |

> Komodo uncertainty remains for the 5 `unknown` stacks: compose files exist but current runtime state is unconfirmed.

---

*Generated 2026-07-28 — Inventory ledger across k3s Argo + Docker platforms.*
