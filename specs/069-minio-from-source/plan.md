# Implementation Plan: MinIO built from source

**Branch**: `408-minio-from-source` | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/069-minio-from-source/spec.md`

## Summary

Replace the two deleted upstream MinIO images with **one** image the project builds from source,
`jumbleknot/minio`, carrying both the `minio` server and the `mc` client. Built by its own workflow on
a weekly cadence, published to the forge registry, and scanned by the existing infra-image sweep —
which requires tightening that sweep's scope rule so the new artifact cannot fall between the two
scanners.

Same upstream versions as today, same runtime identity, same health check, same init entrypoint. The
compose diff is four image references and nothing else. Everything that could confound a regression is
deliberately held constant.

## Technical Context

**Language/Version**: Go, sourced from the upstream modules — `minio` declares `go 1.24.0 / toolchain
go1.24.2`, `mc` declares `go 1.23.0 / toolchain go1.23.10`. One builder at ≥1.24.2 satisfies both.

**Primary Dependencies**: `golang:<pinned>` builder image, `alpine:3.24` runtime image, both digest-pinned.
Upstream sources `github.com/minio/minio` @ `RELEASE.2025-09-07T16-13-09Z` and `github.com/minio/mc` @
`RELEASE.2025-08-13T08-35-41Z`, each additionally pinned to its commit SHA.

**Storage**: Existing named volume `langfuse-minio-data` mounted at `/data`. Format unchanged by
construction — the version does not move in this change.

**Testing**: Node's built-in test runner for the guard and scanner changes
(`scripts/__tests__/*.test.mjs`, already run by `guardrails / naming`). Stack-level verification is a
real local bring-up plus a Langfuse ingestion round-trip. CI verification is a real Trivy sweep,
confirmed real by job duration.

**Target Platform**: linux/amd64 containers on the homelab Docker hosts (CI runner and the two rootless
production daemons).

**Project Type**: Infrastructure image + build workflow + scanner scope change. No application code.

**Performance Goals**: Not a throughput change. The only budget that matters is build time — the image
build runs on a capacity-1 runner shared with a ~28-minute app-e2e, which is why it is a separate
weekly workflow rather than part of cd-deploy.

**Constraints**: Must not change the on-disk object format. Must not change the runtime identity, or
the live root-owned data volume becomes unwritable. Must not require a shell-free base (the health
check is `CMD-SHELL`). Must not leave any published image outside every scanner.

**Scale/Scope**: One new Dockerfile, one new workflow, four compose image references, one scanner scope
rule, four allowlist deletions, one Renovate rule migration, and the guards that assert the premises
those changes invalidate.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Assessment |
|---|---|---|
| **Security — Secrets Management** | Yes | The Dockerfile takes no credentials. Registry push uses the existing Forgejo secret (`REGISTRY_TOKEN`) and vars (`REGISTRY`, `NS`, `REGISTRY_USER`), never a git literal — the same pattern as `devcontainer-image.yml`. `MINIO_ROOT_PASSWORD` continues to arrive from the stack env file, unchanged by this work. **PASS** |
| **Security — Classification** | Yes | Internal-only service, not internet-exposed. Unchanged by this work. **PASS** |
| **Security — supply chain** | Yes | Source pinned by commit SHA in addition to release tag; base and builder images digest-pinned; published image addressed by digest. Strictly stronger than the status quo, where the artifact came from a third party who has since deleted it. **PASS** |
| **Docker-Native Operations** | Yes | Health check and compose files already exist and are preserved verbatim. Graceful shutdown is upstream MinIO behaviour, unchanged. **PASS** |
| **Test-Driven Development** | Yes | Applies to the scanner scope rule and the guards — those are code and get RED-then-GREEN treatment in `tasks.md` per the mandatory checkpoint format. See the note below on what TDD means for a Dockerfile. **PASS with a stated boundary** |
| **Test Type Integrity** | Yes | The scanner/guard tests are genuine unit tests over fixture trees. The stack verification is a genuine integration exercise — real MinIO, real Langfuse, real Postgres, nothing mocked. No substitution anywhere. **PASS** |
| **Clean Architecture / API-First** | No | No service code, no API surface. Not applicable. |
| **Frontend / AI Agent principles** | No | Not applicable. |

**TDD boundary, stated explicitly.** A Dockerfile has no unit under test; its correctness is
*behavioural* and is proven by building it and running the service. So the TDD checkpoint format
applies in full to the JavaScript changes (scanner scope rule, floating-tag guard, disjointness test,
Renovate guard), and the Dockerfile/workflow are covered by integration-level acceptance with explicit
expected output. This is a boundary, not an exemption: the Dockerfile still has a failing-first check —
the scan cannot resolve the image before it is published, and can after.

**Post-Phase-1 re-check**: no new violations introduced. Complexity Tracking below is empty.

## Project Structure

### Documentation (this feature)

```text
specs/069-minio-from-source/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── image-contract.md        # what the published image guarantees to the stack
│   └── scanner-scope.md         # the built-vs-pulled partition, and its invariant
├── checklists/
│   └── requirements.md  # spec quality checklist (already written)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
infrastructure-as-code/docker/minio/
└── Dockerfile                          # NEW — multi-stage: golang builder -> alpine runtime

.forgejo/workflows/
└── minio-image.yml                     # NEW — dispatch + path change + weekly cron; build, scan, push

infrastructure-as-code/docker/observability/
├── compose.yaml                        # CHANGED — 2 image refs (minio, minio-init)
└── compose.prod.yaml                   # CHANGED — 2 image refs (minio, minio-init)

scripts/
└── infra-image-scan.mjs                # CHANGED — exclusion: 'jumbleknot/' prefix -> BUILT_IMAGE_NAMES

scripts/__tests__/
├── infra-image-scan.test.mjs           # CHANGED — floating-set premise; new exclusion; disjointness
└── renovate-workflow.guard.test.mjs    # CHANGED — minio moves off the docker date-tag rule

security/infra-images/
└── allowlist.yaml                      # CHANGED — delete 4 minio entries

renovate.json                           # CHANGED — date-tag rule scope; new customManager for the ARGs

docs/runbooks/
└── infra-image-scanning.md             # CHANGED — the scope rule and the floating-count premise
```

**Structure Decision**: The Dockerfile lives under `infrastructure-as-code/docker/minio/` rather than
beside application source, because there is no in-repo source for it to sit beside — it is
infrastructure, and that directory is where the stack's other infrastructure lives. The workflow sits
with the others in `.forgejo/workflows/`. No new top-level directory is introduced.

## Phase 0 — Research

See [research.md](./research.md). Resolves: the build recipe and version stamp, the toolchain
hermeticity question, source-pinning strategy, runtime identity evidence, and the scanner partition.

## Phase 1 — Design & Contracts

- [data-model.md](./data-model.md) — the entities the spec names, as they exist concretely here.
- [contracts/image-contract.md](./contracts/image-contract.md) — what the stack may rely on the image
  providing. This is the real interface: compose depends on it, not on our Dockerfile's internals.
- [contracts/scanner-scope.md](./contracts/scanner-scope.md) — the built-vs-pulled partition stated as
  an invariant with its enforcing test.
- [quickstart.md](./quickstart.md) — the runnable verification path, including how to tell a real scan
  from a skipped one.

## Complexity Tracking

No constitution violations. Table intentionally empty.

## Risks carried into implementation

| Risk | Why it matters | Mitigation in the plan |
|---|---|---|
| The live data volume's ownership is **inferred**, not observed | Inferred from the upstream image's published config (`User` unset ⇒ root). If the running volume is owned by something else, prod breaks on redeploy | A task verifies ownership against the actual volume **before** the production rollout, not after. This is the one unresolved fact in the spec's Assumptions |
| Upstream source could also disappear | We fetch from the organisation that just deleted its images | Build fails loudly; the last published image remains in our registry. Recorded as an accepted residual risk, not engineered around |
| A green scan that examined nothing | A skipped sweep reports the same success as a real one | Every acceptance criterion that claims "scan passed" also requires the job-duration evidence. Never the tick alone |
| The build succeeds but the artifact misbehaves | A binary that starts but misreports its version would pass a build check and fail the health check in service | Verification exercises the running stack, and asserts the version stamp explicitly |
