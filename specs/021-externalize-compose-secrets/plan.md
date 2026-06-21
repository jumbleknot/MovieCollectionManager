# Implementation Plan: Externalize Docker Compose Credentials

**Branch**: `021-externalize-compose-secrets` | **Date**: 2026-06-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/021-externalize-compose-secrets/spec.md`

## Summary

Remove every clear-text credential from the version-controlled Docker Compose files (the `auth`, `mcm`, `audit`, `observability` stacks and their `include`d component files) by replacing each literal with a fail-fast `${VAR:?msg}` interpolation reference. Real values are minted per-machine by a generator script into gitignored per-stack `.env` files from committed `*.env.example` placeholder templates; deterministic cross-consumer fixtures (LangFuse project keys) keep their fixed value. A new static gate (`check-no-inline-secrets.mjs`, mirroring the existing `check-resource-naming.mjs`) fails CI if any secret-shaped key holds a literal. After the working-tree change merges, a separate coordinated `git filter-repo` pass scrubs the historical strings.

This enforces the constitution's **Secrets Management** principle (no secrets in version control) and remediates a standing deviation; it changes no runtime behavior.

## Technical Context

**Language/Version**: Node.js 24.x ESM (`.mjs` scripts, matches existing `scripts/*.mjs`); Docker Compose v2 (`docker compose`); GitHub Actions (CI).

**Primary Dependencies**: `yaml` (root dep, already used by `check-resource-naming.mjs`); `node:crypto` (random generation); `node:fs`/`node:child_process` (`git ls-files`); `git-filter-repo` (history scrub, dev-machine tool only — not a repo dependency).

**Storage**: Per-stack `.env` files under `infrastructure-as-code/docker/stacks/` (gitignored); `*.env.example` templates (committed). No database.

**Testing**: TDD gate-first — `node scripts/check-no-inline-secrets.mjs` (RED on today's tree → GREEN after edits) + `--selftest` (planted-literal detection, mirroring `secret-scan.mjs --selftest`); per-stack `docker compose config` + `up` smoke validation; existing web E2E + opt-in observability/audit smoke unaffected.

**Target Platform**: Local developer machines (Windows/PowerShell primary, Bash available) + Linux CI runners.

**Project Type**: Infrastructure / build-tooling change. No application source touched.

**Performance Goals**: N/A (config + tooling). Gate must run well under the existing naming-gate's 10-minute CI budget (a static scan of ~16 files).

**Constraints**:
- Credentials embedded in **connection-string URLs** must be **URL-safe** (no `@ : / ? # %`) — so URL-embedded passwords use the base62 alphabet only. Non-URL passwords (Keycloak/OpenSearch admin) may carry the special characters their images require for complexity.
- A single mechanism must cover `environment`, `command`, `healthcheck`, `entrypoint`, and URL occurrences — `${VAR}` interpolation does; `_FILE` secrets do not (research R2: only ~5 of ~25 occurrences support `_FILE`, and URL clients still need plaintext).
- Compose `include:` interpolation scoping must be verified empirically (research R1) — the per-stack `.env` must reach the included component files.

**Scale/Scope**: 4 stacks, ~10 component compose files, **17 canonical credential variables = 15 randomized (incl. the 2 structured unleash tokens) + 2 deterministic fixtures**, across ~25 literal occurrences (see [data-model.md](./data-model.md) Counts). New: 1 generator script, 1 gate script, 4 `*.env.example` templates, 1 `.gitignore` carve-out, 4 Nx target edits, 1 CI wiring, 1 runbook section.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| Security § Data Protection — **Secrets Management** ("never store sensitive values in source code, config files, or version control … rotated on a defined schedule and upon suspected compromise") | ✅ **Enforced** | This feature is the remediation. `${VAR:?}` + gitignored `.env` removes secrets from VCS; the generator rotates values (new per machine / on `--force`); the history scrub completes "upon suspected compromise." |
| Security § Infrastructure Hardening — metadata/`.env` files never in web root | ✅ | `.env` files live under `infrastructure-as-code/docker/stacks/`, gitignored, not served. |
| **Test-Driven Development (NON-NEGOTIABLE)** — RED before GREEN, Verify RED/GREEN in tasks | ✅ | The gate is authored first and verified RED on the current tree, GREEN after externalization; `--selftest` proves detection. Smoke validation per stack. tasks.md will carry Verify RED/GREEN per `docs/templates/feature-test-tasks-template.md`. |
| **Docker-Native Operations** | ✅ | Change is entirely within the Docker Compose operational model; no new runtime services. |
| Centralized Access Control / Auth principles | ➖ N/A | No application auth surface changed. |
| API-First / Clean Architecture / Rust Safety / Frontend principles | ➖ N/A | No service or app code changed. |

**No violations.** Complexity Tracking table omitted (nothing to justify).

**Post-Phase-1 re-check**: still ✅ — the design adds only config indirection, a generator, and a static gate; introduces no new service, in-source dependency, or auth path. The one mechanism risk (R1, `include` interpolation scope) is mitigated by per-`include` `env_file`.

## Project Structure

### Documentation (this feature)

```text
specs/021-externalize-compose-secrets/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 — mechanism decisions + gotchas
├── data-model.md        # Phase 1 — canonical credential-variable registry
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   ├── env-var-manifest.md      # the .env.example contract (vars, format, shared-by, fixed/random)
│   └── inline-secret-gate.md    # the gate's pass/fail contract + selftest
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 — created by /speckit-tasks
```

### Source Code (repository root)

```text
infrastructure-as-code/
├── project.json                         # EDIT: --env-file on up-auth/up-mcm/up-audit/up-observability/up-all; add check-no-inline-secrets target
└── docker/
    ├── keycloak/compose.yaml            # EDIT: KC_BOOTSTRAP_ADMIN_PASSWORD → ${...}
    ├── vault/compose.yaml               # EDIT: VAULT_DEV_ROOT_TOKEN_ID → ${...}
    ├── agent-db/compose.yaml            # EDIT: POSTGRES_PASSWORD → ${AGENT_DB_PASSWORD}
    ├── agent-gateway/compose.yaml       # EDIT: AGENT_DB_URL password → ${AGENT_DB_PASSWORD}
    ├── opensearch/compose.yaml          # EDIT: admin password (env + healthcheck) + sanitize comment creds
    ├── observability/compose.yaml       # EDIT: langfuse/clickhouse/redis/minio/unleash secrets (env+command+healthcheck+entrypoint+URLs)
    └── stacks/
        ├── auth.compose.yaml            # EDIT: include → long syntax w/ env_file (per research R1)
        ├── mcm.compose.yaml             # EDIT: include env_file (per R1)
        ├── audit.compose.yaml           # EDIT: include env_file (per R1)
        ├── observability.compose.yaml   # EDIT: include env_file (per R1)
        ├── auth.env.example             # NEW (committed)
        ├── mcm.env.example              # NEW (committed)
        ├── audit.env.example            # NEW (committed)
        ├── observability.env.example    # NEW (committed)
        ├── {auth,mcm,audit,observability}.env   # NEW (gitignored, generated)
        └── README.md                    # NEW (optional): how the env files work

scripts/
├── gen-dev-secrets.mjs                  # NEW: generator (reads *.env.example → writes *.env)
└── check-no-inline-secrets.mjs          # NEW: static gate (+ --selftest)

.github/workflows/
└── naming-gate.yml                      # EDIT: add inline-secret gate step + broaden path filter
                                         #   (or sibling secrets-inline-gate.yml — research R5)

.gitignore                               # EDIT: add `!*.env.example` carve-out after *.env / *.env.*
docs/runbooks/local-dev.md              # EDIT: first-time setup runs gen-dev-secrets before up-*
CLAUDE.md                                # EDIT: SPECKIT marker → this plan
```

**Structure Decision**: No new project. All changes land in the existing `infrastructure-as-code` project, the shared `scripts/` directory (alongside `check-resource-naming.mjs` / `secret-scan.mjs`), CI workflows, and docs. The keycloak DB password (already a Docker file-secret) and the BFF/mc-service `.env` files (already externalized) are **out of scope** and left unchanged.

## Phasing

- **Phase A — gate first (RED)**: author `check-no-inline-secrets.mjs` + `--selftest`; verify RED on current tree.
- **Phase B — externalize**: edit the 6 component compose files; add the 4 `*.env.example`, the generator, the `.gitignore` carve-out; wire `--env-file`/`include env_file`; gate goes GREEN; per-stack smoke up.
- **Phase C — wire CI + docs**: add the gate to CI; update the local-dev runbook + Nx targets; run the web-E2E regression.
- **Phase D — history scrub (separate, coordinated, after merge)**: `git filter-repo --replace-text`, force-push, notify collaborators.

Phase D is sequenced but does not block A–C merging (spec FR-010 / US3).

## Complexity Tracking

No constitution violations — table intentionally omitted.
