# Homelab Docker / k3s Rationalization

This worktree tracks the rationalization of homelab services across Docker Compose and
k3s (Argo CD) platforms.

## Service Ownership Ledger

The **[service inventory](docs/service-inventory.md)** documents every known workload,
its tier, source path, exposure, data persistence, backup ownership, and recommended
disposition for the rationalization project.

- **Markdown (human-readable):** [`docs/service-inventory.md`](docs/service-inventory.md)
- **CSV (machine-readable):** [`docs/service-inventory.csv`](docs/service-inventory.csv)

### Quick stats

| Platform | Count | Tier 0 | Tier 1 | Tier 2 | Tier — |
|----------|-------|--------|--------|--------|--------|
| K3s (Argo) | 24 | 7 | 16 | 1 | 0 |
| Docker | 26 | 2 | 13 | 10 | 1 |
| **Total** | **50** | **9** | **29** | **11** | **1** |

### Retired services

| Service | Reason |
|---------|--------|
| **airpipe-relay** | Docker standalone — fully retired, all artifacts removed |
| **cosmos-mongo-ESn** | Docker standalone — fully retired, all artifacts removed |
| **cloudflared (Docker)** | Docker Compose — permanently retired after k3s Cloudflared pinned to Yeager (PR #106) |

### Next steps

1. **Phase 1 (done):** Service inventory / ownership ledger ✓
2. **Phase 2:** Per-service migration plans (`docs/migration-plans/`)

---

*See [docs/service-inventory.md](docs/service-inventory.md) for full details.*
