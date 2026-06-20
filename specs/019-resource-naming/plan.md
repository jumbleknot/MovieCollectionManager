# Implementation Plan: Docker Resource Naming Convention & Rename

**Branch**: `019-resource-naming` | **Date**: 2026-06-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/019-resource-naming/spec.md`

## Summary

Standardize every Docker volume, network, and (Phase 2) service/container name to `<context>-<role>-<engine>` form, qualifying only the frontend-bound BFF with `mcm-`. Stage A (tasks Phases 1–5) renames external volumes + networks, deletes the unused containerized Ollama service, and folds the observability/mailpit volumes into the convention — preserving data in the three stateful stores via a backup→copy→cutover migration (never an in-place `name:` change, which orphans data). Stage B (tasks Phase 6) renames services/containers (runtime DNS) as a coordinated cutover that also updates the gitignored `.env` files. Authoritative design + mapping: [docs/proposals/resource-naming-convention.md](../../docs/proposals/resource-naming-convention.md); runbook: [docs/proposals/volume-network-rename-migration.md](../../docs/proposals/volume-network-rename-migration.md).

## Technical Context

**Language/Version**: Docker Compose v2 (YAML); PowerShell 5.1 + POSIX Bash provisioning scripts; Node ESM (`scripts/agent-stack.mjs`); Nx task runner. No application source language changes.

**Primary Dependencies**: Docker Engine / Docker Desktop, Docker Compose `include:` + profiles, Nx.

**Storage**: Docker named volumes backing Postgres (Keycloak, agent checkpointer, LangFuse, Unleash), MongoDB (mc-service, BFF), Redis (BFF cache), OpenSearch (audit), ClickHouse/MinIO (LangFuse), Mailpit.

**Testing**: Existing Nx gates (`test`, `test:integration`, `e2e`) re-run post-rename as regression; **new static naming gate** asserting every compose `name:` matches the convention.

**Target Platform**: Local dev (Windows + Docker Desktop) and CI (`android-e2e.yml`); prod (Komodo) updated operationally via runbook.

**Project Type**: Infrastructure-as-code / devops (no app feature surface).

**Performance Goals**: N/A — one-time migration (minutes); zero steady-state runtime impact.

**Constraints**: Zero data loss on the three stateful volumes; fully reversible until explicit decommission; Stage-B service rename requires per-environment `.env` updates (gitignored, not PR-capturable).

**Scale/Scope**: ~13 volumes, 4 networks, ~13 services across 11 component compose files (one — `ollama` — deleted, not edited) + root compose + 2 scripts + 1 CI workflow + 4 docs (+ `.env*.example` in Stage B).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **Secrets Management** | PASS — migration backups (Keycloak realm export, volume tarballs) are written to `E:/tmp` (outside the repo); no secret enters git. The rename touches no secret values. |
| **Encryption at Rest** | PASS — the BFF store's AES-256-GCM-encrypted agent-configs are copied as opaque bytes; nothing is decrypted, re-keyed, or logged. |
| **Documentation / No Vibe Coding** | PASS — spec + convention + runbook are the governing artifacts; all live docs updated in lockstep (FR-006). |
| **Behavior-Descriptive Identifiers** | PASS — resource names are external/persisted contracts (explicitly exempt from the no-spec-ID rule) and the feature *improves* their descriptiveness; no `FR-###`/`SC-###` leaks into names. |
| **Centralized Access Control / Auth / Session** | PASS (no change) — Phase 2 preserves inter-service auth wiring; the existing E2E auth-flow gates are the enforcement that a service rename didn't break protection. No auth code is added or moved. |
| **Test-Driven Development** | PASS — the static naming gate is written before the renames; the regression gates (unit/integration/E2E) must be green after each phase (FR-010). |

No violations → Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/019-resource-naming/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (naming answers, container_name, migration safety, ollama removal)
├── data-model.md        # Phase 1 — naming taxonomy + authoritative current→proposed mapping
├── quickstart.md        # Phase 1 — migration + verification runbook (validation guide)
├── contracts/
│   └── naming-convention.md   # the enforceable rule + the static gate it implies
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

This feature edits configuration/scripts/docs, not application source. Touched paths:

```text
compose.yaml                                   # include: (drop ollama), profile table, first-time create block
infrastructure-as-code/docker/
├── keycloak/compose.yaml                       # volume name:, network refs
├── mc-service/compose.yaml                     # volume name:
├── bff/compose.yaml                            # 2 volume name:, mcm-bff-network
├── agent-db/compose.yaml                       # volume name:
├── opensearch/compose.yaml                     # volume name: (agent-audit)
├── ollama/compose.yaml                         # DELETED
├── observability/compose.yaml                  # managed-volume explicit names
├── agent-gateway/compose.yaml                  # movie-assistant-mcp-network, drop ollama dep
├── web-api-mcp/compose.yaml                    # movie-assistant-mcp-network
├── movie-mcp/compose.yaml                       # Stage B: container_name only (backend-network, no volume)
└── spreadsheet-mcp/compose.yaml                 # Stage B: container_name only
scripts/agent-stack.mjs                         # network name + --name flags + MCP URLs
scripts/agent-gateway-local.ps1                 # network/name refs
.github/workflows/android-e2e.yml               # volume + network create loops
docs/runbooks/local-dev.md, docs/MCM-Architecture.md, docs/agent-layer.md,
agents/movie-assistant/README.md                # operational doc references
# Stage B additionally: every .env*.example + service DNS refs
```

**Structure Decision**: No app-code structure change; the deliverable is the compose/scripts/CI/docs edits above plus the migration runbook and a static naming gate.

## Complexity Tracking

> No constitutional violations — section intentionally empty.
