# Contract: Compose profile-selection invariance & portability (US3 / FR-010, FR-011 / AC3)

**Guarantee**: After relocating `profiles:` into the per-service compose files and deleting the top-level `services:` block from `stacks/mcm.compose.yaml`, the stack parses on any conformant Compose and each profile selects an identical service set.

## Verification

For each Compose version **V ∈ { v2.40.x apt plugin, current v5.x }** and each profile set **P**:

```bash
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml <P> config --services | sort
```

where `<P>` ∈:

| Selector | Expected services (must be identical pre/post and across V) |
|---|---|
| (none) | mc-service-store-mongo, mc-service-store-mongo-rs-init, mcm-bff-cache-redis, mcm-bff-store-mongo |
| `--profile app` | above + mc-service |
| `--profile bff-nonsecure` | default infra + mcm-bff-service-nonsecure |
| `--profile bff-secure` | default infra + mcm-bff-service-secure + mcm-bff-tls-proxy |
| `--profile agents` | default infra + movie-assistant-gateway + movie-assistant-mcp-{movie,webapi,spreadsheet} + movie-assistant-store-postgres |
| `--profile agents-metro` | default infra + movie-assistant-gateway-metro |
| `--profile app --profile bff-nonsecure` | default infra + mc-service + mcm-bff-service-nonsecure (the standard E2E selection) |

## Pass criteria

- **PC-1**: `config` exits 0 under **both** Compose versions — no `services.<x> conflicts with imported resource`.
- **PC-2**: for every selector, the sorted service list is byte-for-byte identical to the pre-change output captured on `main` (baseline the list before the edit).
- **PC-3**: the containerized web E2E (auth→mcm `--profile app --profile bff-nonsecure`) still passes — the real end-to-end proof the selection is unchanged.

## Audit & verification results (implementation, 2026-07-14)

**Standalone-consumer audit (FR-011, T019):** the only sites that run a per-service compose file directly are two legacy Nx targets — `backend/mc-service/project.json` (`deploy`/`docker-down`) and `frontend/mcm-app/project.json` (`deploy`/`docker-up`/`docker-down`). Both were relying on the per-service files having NO profiles (everything starts). They were updated to preserve behavior: mc-service `deploy` → `--profile app` (still starts mongo + rs-init + mc-service); bff `deploy`/`docker-up` → `--profile bff-nonsecure --profile bff-secure` (still starts all 5). `down` needs no profile. No other consumer runs a per-service file standalone.

**Metro regression caught + fixed:** `movie-assistant-gateway-metro` used `extends: movie-assistant-gateway`; once the base carried `profiles: [agents]`, `extends` COPIED it into metro, so metro wrongly appeared under `--profile agents`. Fixed by replacing `extends` with a YAML anchor (`x-agent-gateway-base` + `<<:`) so each service declares its own profiles with no inheritance. Metro is now `[agents-metro]` only.

**Verified under Compose v5.2.0 (PC-2):** all six selectors (`(none)`, `app`, `bff-nonsecure`, `bff-secure`, `agents`, `app+bff-nonsecure`) are byte-identical to `baseline-profile-selection.txt`. `agents-metro` alone reproduces the SAME pre-existing "depends on undefined service movie-assistant-store-postgres" error (unchanged). `agents+agents-metro` includes metro exactly once. Full stack `config` exits 0.

**PC-1 v2.40.x (apt plugin):** not run on the Windows dev host (Docker Desktop ships v5.x only). Since the top-level re-declaration/merge block was DELETED entirely, the exact `conflicts with imported resource` error can no longer be produced — the config is now plain `include:` + per-service `profiles:`, which any conformant Compose parses. Confirm on the dev container / CI apt-plugin path as the final AC3 sign-off.
