# Implementation Plan: Replace MinIO with RustFS

**Branch**: `080-minio-to-rustfs` | **Date**: 2026-10-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/080-minio-to-rustfs/spec.md`

## Summary

Swap every MinIO for a digest-pinned upstream `rustfs/rustfs` (Alpine tag), running as the image's own
uid 10001 with no compose `user:` override. Production Langfuse data moves **in place**: writers stop,
a manifest is taken, MinIO stops, the drive is copied to a **new** volume chowned to the image's uid,
RustFS starts on the copy, and parity is verified against the manifest. The original volume is never
written, so rollback is a revert onto it. The from-source MinIO build (features 069/070) — workflow,
Dockerfile, promotion script, Renovate rule, allowlist entries and their guards — is deleted in the
same change, and RustFS enters the ordinary pulled-image supply chain (Renovate + infra-image sweep),
with a guard that it is actually **extracted**. A new guard keeps MinIO out of live files.

Key decisions (research.md has the evidence):

| Decision | Choice | Evidence |
|---|---|---|
| Variant | `rustfs/rustfs:1.0.1` (Alpine) | R3 — equal on the gate, 405 MB vs 643 MB, has curl + wget |
| Runtime uid | image's 10001, no `user:`; migration chowns the copy | R5 — `user: 1000` is FATAL on a fresh volume (CI's every run) |
| Health | `curl -fsS http://localhost:9000/health/ready` | R7 — 200 unauthenticated; readiness semantics verified in T011 |
| Bucket init | same RustFS image, `curl --aws-sigv4`, creds on stdin | R8 — PUT existing bucket = 200 (idempotent); no argv secret |
| Logs | `RUSTFS_OBS_LOG_DIRECTORY: ""` | R9 — default writes to a file `docker logs` never sees |
| Console | disabled, no port | R10 |
| Rollback | revert onto the untouched original volume + kept Komodo Variable | R11, R12 |
| Rehearsal | `object-store-migration.mjs rehearse` against the deployed MinIO digest; MinIO ref removed at cleanup | R13 |
| Third instance | host-managed Nx-cache MinIO replaced too (P3, operator) | R14 |

## Technical Context

**Language/Version**: Node 24 ESM scripts (`scripts/*.mjs`, `node --test`); Docker Compose YAML;
Forgejo Actions YAML; JSON (Renovate); YAML (allowlist). No application language changes.

**Primary Dependencies**: `rustfs/rustfs:1.0.1@sha256:<index>` (Docker Hub). Removed:
`${REGISTRY_HOST}/jumbleknot/minio`, `golang:*-alpine` builder, `alpine:3.24` runtime base for MinIO.

**Storage**: Docker named volumes. Prod: new external `observability-langfuse-rustfs-data`; old
`observability-langfuse-minio-data` retained as rollback target until M7.

**Testing**:
- `guardrails`: `node --test` guard and unit tests under `scripts/__tests__/` (new: the migration
  tool's pure logic, the no-MinIO guard, the RustFS visibility/identity assertions; deleted: minio
  promote/build guards).
- `app-ci`: mcm-app `test:integration` against the RustFS backup destination with
  `MCM_REQUIRE_BACKUP_TARGETS=1` and `MCM_REQUIRE_LIVE_STACK=1`; `app-e2e` including
  `tests/e2e/web/backups.spec.ts`.
- `infra-image-scan`: PR run plus one real scheduled Friday sweep.
- Docker-driven rehearsal (dev container, `MCM_REQUIRE_LIVE_STACK=1` turns a skip into a failure).
- Operator verification on the prod host (contracts/migration-procedure.md M5).

**Target Platform**: linux/amd64; the dev container's Docker Sandbox daemon, the CI rootless daemon,
the prod rootless daemon (Komodo).

**Project Type**: infrastructure swap + supply-chain retirement + data migration. No application
logic change.

**Constraints**: in-place data migration (operator decision); 2026-12-01 allowlist expiry; lands after
item #642; one Komodo Variable added before cutover and one removed after.

**Scale/Scope**: 72 tracked files reference MinIO (research R18) plus one host-managed compose.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Assessment |
|---|---|---|
| **Security — Secrets Management** | Yes | New secret is a masked Komodo Variable `LANGFUSE_RUSTFS_SECRET_KEY`, `${VAR:?}` in compose, declared in `stacks.toml` (feature 069 R9 guard). Init containers read creds from env as `$$VAR`, piped to curl on stdin — no argv exposure. The image's insecure fallback for an unset credential is unreachable because every credential is fail-fast. **PASS** |
| **Security — supply chain** | Yes | Moves from a from-source image of an abandoned upstream (permanent suppressions) to a live upstream, digest-pinned, Renovate-tracked with 3-day cooldown, swept weekly; 0 fixable Critical measured. Removes an egress allowance (Go proxy) that only the build needed. **PASS** |
| **Security — classification / exposure** | Yes | No new published port; console disabled; backup destination still loopback-only. Removes the Nx-cache console's `0.0.0.0:9001`. **PASS** |
| **Docker-Native Operations** | Yes | Real readiness healthchecks; logs to stdout; restart policy `always` in prod; graceful stop before copy. **PASS** |
| **Test-Driven Development** | Yes | Every guard and the migration tool's logic get Verify RED / Verify GREEN in `tasks.md`; deletions of guards are justified per the "update at the cause" rule (a guard is deleted only when what it protects is deleted). Compose/config/doc tasks use "Done when". **PASS** |
| **Test Type Integrity** | Yes | The S3 driver's integration oracle remains a **real** server (RustFS), no mocking; the suites are re-earned against it with 0 skips. **PASS** |
| **Logging & Monitoring** | Yes | Monitoring stack untouched (R15) and re-verified (SC-008). **PASS** |
| **AI Assistant Constraints** | Yes | Prod steps are marked operator-only; the assistant never runs them. Behaviour-descriptive names (`object-store-migration.mjs`, `no-minio-references.guard`). **PASS** |

**Re-check after Phase 1**: no change — design adds no principle exceptions.

## Project Structure

### Documentation (this feature)

```text
specs/080-minio-to-rustfs/
├── spec.md
├── plan.md                 # this file
├── research.md             # R1–R18, measured evidence
├── data-model.md           # migration evidence records
├── quickstart.md           # reproduce the measurements and the rehearsal
├── contracts/
│   ├── object-store-service.md   # S1–S9, every RustFS instance
│   ├── migration-procedure.md    # M0–M8, operator steps marked
│   └── no-minio-guard.md         # G1–G3, exemption list
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root) — what changes

```text
infrastructure-as-code/
├── docker/observability/compose.yaml        # langfuse-minio{,-init} → langfuse-rustfs{,-init}; S3 env; depends_on; volume
├── docker/observability/compose.prod.yaml   # same, prod shape; external observability-langfuse-rustfs-data; drop REGISTRY_HOST
├── docker/backups/compose.yaml              # mcm-bff-backup-minio{,-init} → -rustfs; drop 9101; drop REGISTRY_HOST
├── docker/stacks/mcm.compose.yaml           # comment only
├── docker/stacks/{mcm,observability}.env.example   # variable rename; drop REGISTRY_HOST blocks
├── docker/minio/                            # DELETED (Dockerfile, README if any)
└── komodo/stacks.toml                       # prod-observability env: LANGFUSE_RUSTFS_SECRET_KEY; drop REGISTRY_HOST + old var

.forgejo/workflows/
├── minio-image.yml                          # DELETED (cron 0 5 * * 5, push paths, dispatch)
├── app-ci.yml                               # backup-destination step: names, health loops, init loop, log dump list; drop REGISTRY_HOST check
└── infra-image-scan.yml                     # comments: image list, cron-ordering note

scripts/
├── object-store-migration.mjs               # NEW (temporary — deleted at cleanup)
├── promote-minio-digest.mjs                 # DELETED
├── infra-image-scan.mjs                     # drop 'minio' from BUILT_IMAGE_NAMES + comments
├── check-infra-image-findings.mjs, allowlist-expiry.mjs   # "two jobs consult" → one; comments
├── check-resource-naming.mjs                # service names
├── check-prod-restart-policy.mjs            # self-test fixture names
├── check-no-inline-secrets.mjs              # comment + fixture value
├── sast-scan.mjs, check-sast-findings.mjs   # historical comments re-anchored
├── secret-scan.mjs                          # unchanged (exempted line, G2)
├── gen-dev-env.mjs, gen-ci-env.mjs          # BACKUP_ALLOWED_DESTINATION_HOSTS, BACKUP_TEST_S3_INTERNAL_ENDPOINT
├── ci-step-ceilings.tsv                     # comment; ceiling re-calibrated only if measured slower
├── cd/scan-push.sh                          # comment: no longer "inherits from minio-image"
└── __tests__/
    ├── minio-promote.guard.test.mjs, promote-minio-digest.test.mjs   # DELETED with what they guard
    ├── no-minio-references.guard.test.mjs   # NEW
    ├── object-store-migration.test.mjs      # NEW (pure logic)
    ├── object-store-migration.rehearsal.mjs   # NEW (Docker; deliberately NOT *.test.mjs so guardrails' glob does not pick it up; skip→fail under MCM_REQUIRE_LIVE_STACK=1)
    ├── object-store-service.guard.test.mjs  # NEW (S2 no user:, S4 health, S5 no argv secret, S6 logs, S7 no console port)
    ├── infra-image-scan.test.mjs            # fixtures off minio; rustfs in enumerated set; visibility
    ├── renovate-workflow.guard.test.mjs     # delete minio date-tag tests; add rustfs rule + extraction visibility
    ├── allowlist-expiry.test.mjs, sast-scan.guard.test.mjs, komodo-stack-env.guard.test.mjs,
    │   cd-scan-push-gate.guard.test.mjs, argv-mutating-default.guard.test.mjs, ci-status.test.mjs
    │                                        # fixture/comment updates; argv guard loses promote-minio entry
    └── ci-digest-redact.test.mjs, ci-failure-digest.test.mjs   # unchanged (exempted plant, G2)

renovate.json                                # delete minio packageRules + false customManager prose; add rustfs/rustfs rule
security/infra-images/allowlist.yaml         # delete 4 jumbleknot/minio entries + their comment blocks
.devcontainer/egress-allowlist.json          # delete proxy.golang.org / sum.golang.org if nothing else needs them

frontend/mcm-app/
├── src/bff-server/backup-driver-s3.ts, backup-request-signer.ts, src/types/backups.ts   # comments only
├── src/bff-server/unit-tests/backup-request-signer.test.ts                              # comments only
├── tests/integration/setup/preflight.global.js       # probe /health/ready, label
├── tests/integration/*.integration.test.ts (9 files) # endpoint default + comments
└── tests/e2e/web/backups.spec.ts                     # comments / endpoint

docs/runbooks/{local-dev,prod-control-tower,prod-reboot-resilience,Server-Setup-Runbook,renovate,
               infra-image-scanning,ci-diagnostics,devcontainer-sandbox-lifecycle}.md
README.md
openwiki/                                    # regenerated via `pnpm nx wiki-update infrastructure-as-code`
```

**Structure Decision**: no new project; tool and guards live beside their siblings in `scripts/`.

## Sequencing

1. **Item #642 merges first.** Rebase; the Langfuse image lines in both observability compose files
   will have moved.
2. **One implementation PR** (batched per `openwiki/process/pull-request-batching.md`: a red check
   here is not ambiguous — the backup-destination step, a guard, or the sweep each fail under their
   own name). It contains every in-repo change, including the migration tool.
3. **Before merge**: rehearsal (T009) and dev migration (T021) evidence on the PR; operator creates the
   Komodo Variable and runs the advance inventory (M0).
4. **Cutover = merge**, bracketed by M1–M3 before and M5 after (contracts/migration-procedure.md).
5. **Post-merge proofs**: Dependency Dashboard read (SC-007), a real scheduled sweep (SC-005).
6. **Nx-cache store** (M8) any time after the PR merges (the runbook text ships in the PR).
7. **Deferred cleanup PR** after the rollback window: delete the migration tool, its exemption, and
   the last MinIO image reference; operator deletes old volumes, Variable and registry package (M7).

## Complexity Tracking

| Added | Why needed | Simpler alternative rejected because |
|---|---|---|
| A migration tool (~temporary) | In-place migration of real data must be inventoried, refused on unreadable layouts, and verified object-by-object; a hand procedure cannot be rehearsed or reviewed | A runbook of shell commands: the feature-070 traps (volume auto-created by `docker run -v`, top-level `stat` mistaken for full ownership) were both hit by hand procedures |
| A no-MinIO guard | 72 files; a single missed runbook line sends an operator to `mc ready local` on a server without `mc` | Review alone: #560 is itself a case of prose describing a mechanism that did not exist |
