# Tasks: MinIO built from source

**Feature**: `specs/069-minio-from-source` | **Branch**: `408-minio-from-source`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Quickstart**: [quickstart.md](./quickstart.md)

Task detail blocks follow `docs/templates/feature-test-tasks-template.md`, mandatory per the
constitution's TDD Checkpoint Format.

**A note on what TDD means here.** The JavaScript changes (scanner scope, guards) get full RED→GREEN
treatment. The Dockerfile and workflow have no unit under test — their correctness is behavioural — so
they are covered by integration-level acceptance with exact expected output. Where a task is a control
assertion that is legitimately green before and after, it says so rather than pretending to be RED.

**Ordering principle used throughout**: where a guard's premise changes, the **guard is rewritten
first** so it goes RED against the current tree, and the tree change makes it GREEN. That gives genuine
RED→GREEN on changes that would otherwise be test-after.

---

## Phase 1: Setup

- [ ] T001 Create the image directory and Dockerfile skeleton with pinned build args in `infrastructure-as-code/docker/minio/Dockerfile`

### T001 — Dockerfile skeleton with pinned inputs

**Type**: New file | **Time**: 15m | **Risk**: None

Create `infrastructure-as-code/docker/minio/Dockerfile` containing only the pinned inputs as `ARG`s,
no build logic yet. Values resolved in [research.md](./research.md) §R3/§R4:

| ARG | Value |
|---|---|
| `MINIO_RELEASE` | `RELEASE.2025-09-07T16-13-09Z` |
| `MINIO_COMMIT` | `07c3a429bfed433e49018cb0f78a52145d4bedeb` |
| `MC_RELEASE` | `RELEASE.2025-08-13T08-35-41Z` |
| `MC_COMMIT` | `7394ce0dd2a80935aded936b09fa12cbb3cb8096` |
| builder | `golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59` |
| runtime | `alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b` |

The alpine digest is deliberately the one `backend/mc-service/Dockerfile` already uses — same lineage,
one thing for Renovate to move.

**Verify**: `test -f infrastructure-as-code/docker/minio/Dockerfile && grep -c '^ARG' …` → 4 or more.

---

## Phase 2: Foundational — the scanner partition

**Blocking.** Fixes a latent hole that would let this feature's own artifact be published unexamined.
Must land before anything `jumbleknot/`-namespaced and non-cd-deploy is published.

- [ ] T002 [P] Add scanner-scope assertions to `scripts/__tests__/infra-image-scan.test.mjs`
- [ ] T003 Tighten the exclusion rule in `scripts/infra-image-scan.mjs`
- [ ] T004 [P] Record the corrected scope rule in `docs/runbooks/infra-image-scanning.md`

### T002 — Assert the scanner partition is complete, not just disjoint

**Type**: Test | **Time**: 30m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) FR-010, FR-011 · [contracts/scanner-scope.md](./contracts/scanner-scope.md)

**Scenarios covered**:
- US2-AC1: a full sweep resolves every referenced image
- SC-006: every published image is examined by exactly one scanner

**File(s)**: `scripts/__tests__/infra-image-scan.test.mjs`

Add, against **fixtures** rather than the live tree (a live-tree assertion silently stops testing
anything the day MinIO is the only such image and someone removes it):

1. **The regression case** — a fixture compose referencing `jumbleknot/minio:RELEASE.X@sha256:…`, which
   is *not* in `BUILT_IMAGE_NAMES`. Assert `enumerateImages` **includes** it.
2. **The control** — a fixture referencing `jumbleknot/mc-service:latest`, which *is* in
   `BUILT_IMAGE_NAMES`. Assert `enumerateImages` **excludes** it. This one is green before and after,
   deliberately: it catches over-correction into scanning everything, which would break disjointness.

**Verify RED**:
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected RED**: exactly **1** failing assertion — the regression case, reporting that
`jumbleknot/minio…` was not enumerated. The control passes.

> If this shows 0 failures the exclusion rule was already correct and this feature's premise is wrong —
> stop and re-read `contracts/scanner-scope.md` before continuing.

### T003 — Exclude by cd-deploy coverage, not by name

**Type**: Implementation | **Time**: 15m | **Risk**: Medium

**Prerequisite**: T002 complete and verified RED.

In `scripts/infra-image-scan.mjs`, replace the blanket prefix test

```js
if (ref.includes('jumbleknot/')) continue;
```

with membership of `BUILT_IMAGE_NAMES` (already declared in the same file). The existing comment
—"our built images (cd-deploy owns them)"— becomes true rather than aspirational.

**Risk is Medium** because this rule gates what gets scanned repo-wide: too loose and images escape,
too tight and cd-deploy's images get double-scanned and the disjointness test fails.

**Verify GREEN**:
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected GREEN**: 0 failures.

**Also run the touched suite**:
```bash
node --test scripts/__tests__/*.test.mjs
```
**Expected**: 0 failures. The disjointness test must still pass — if it now fails, the rule went too
far the other way.

### T004 — Runbook: the scope rule

**Type**: Documentation | **Time**: 15m | **Risk**: None

Record in `docs/runbooks/infra-image-scanning.md` why the rule is membership-based, and that the
comment previously described an intent the code did not implement. No RED/GREEN — documentation.

**Verify**: `node scripts/check-openwiki-governance.mjs && node scripts/check-openwiki-okf.mjs` → both pass.

---

## Phase 3: User Story 1 — the stack starts from a cold cache (P1)

**Goal**: replace the deleted images with one we build, without changing anything else about the stack.

**Independent test**: on a host with no cached MinIO image, the observability stack starts and every
service reaches healthy. Delivers the repair on its own, with or without Phases 4–6.

- [ ] T005 [US1] Implement the multi-stage build in `infrastructure-as-code/docker/minio/Dockerfile`
- [ ] T006 [US1] Build locally and verify the image contract (C1–C5) per [quickstart.md](./quickstart.md) §1–2
- [ ] T007 [P] [US1] Rewrite the floating-tag premise in `scripts/__tests__/infra-image-scan.test.mjs`
- [ ] T008 [US1] Repoint the four image refs in `infrastructure-as-code/docker/observability/compose.yaml` and `compose.prod.yaml`
- [ ] T009 [P] [US1] Update the discharge guard's image list in `scripts/__tests__/infra-image-scan.test.mjs`
- [ ] T010 [US1] Delete the four MinIO entries from `security/infra-images/allowlist.yaml`
- [ ] T011 [US1] Verify the live volume's ownership against the real volume
- [ ] T012 [US1] Bring the stack up and prove Langfuse ingestion end to end per [quickstart.md](./quickstart.md) §3–6

### T005 — The multi-stage build

**Type**: Implementation | **Time**: 1h | **Risk**: Medium

**Spec reference**: FR-001 … FR-005, FR-007 · [contracts/image-contract.md](./contracts/image-contract.md)

Builder stage: fetch each source at its `*_RELEASE` tag, **assert `HEAD` equals the pinned `*_COMMIT`
and fail the build on mismatch** (FR-003, US4-AC2), then build with
`CGO_ENABLED=0 GOTOOLCHAIN=local go build -tags kqueue -trimpath --ldflags "<generated stamp>"`.
Preserve the upstream ldflags stamp — see research §R2 for why a missing stamp is silent.

Runtime stage: alpine, copy both binaries to `/usr/bin/`, `ENTRYPOINT ["minio"]`, **no `USER`
directive** (root, matching upstream — contract C5), no `CMD` (compose supplies it — contract C4).

**Verify GREEN** is T006; this task's own check is that the build completes.

### T006 — Image contract acceptance

**Type**: Integration acceptance | **Time**: 20m | **Risk**: Low

**Scenarios covered**: US4-AC1 (provenance), and contracts C1–C5.

**Verify**:
```bash
docker build -t mcm-minio:local infrastructure-as-code/docker/minio/
docker run --rm --entrypoint sh mcm-minio:local -c 'minio --version && mc --version && id -u'
```
**Expected**: `minio` reports `RELEASE.2025-09-07T16-13-09Z`; `mc` reports
`RELEASE.2025-08-13T08-35-41Z`; `id -u` reports `0`.

> A version of `DEVELOPMENT` or empty means the ldflags stamp was lost. The binaries still work and the
> build still exits 0 — this assertion is the only thing that catches it.

### T007 — Rewrite the floating-tag guard to the new premise

**Type**: Test refactor | **Time**: 30m | **Risk**: Medium

**Spec reference**: FR-014 · [contracts/scanner-scope.md](./contracts/scanner-scope.md) "Consequence"

**Scenarios covered**: SC-006, and the invariant that the classifier is never widened to hide an
exception.

The guard currently asserts the floating-tag exception set equals exactly the two MinIO refs, and the
runbook states *"a floating count of 0 is a FAILURE, not a success"*. This change empties the set
**legitimately** — by removing the images, not by weakening `isFloatingTag`. Rewrite it to assert the
set equals the **declared** exception list whatever that list contains, so an empty declared list and
an empty observed set agree, while a widened classifier still fails.

**Do not delete or relax this guard.** Per CLAUDE.md, a guard that fails because you changed what it
protects gets updated at the cause.

**Verify RED** (run **before** T008, against the tree that still references MinIO):
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected RED**: 1 failure — the declared list is now empty while the tree still yields two floating
refs.

### T008 — Repoint the four image references

**Type**: Implementation | **Time**: 20m | **Risk**: Medium

**Prerequisite**: T007 verified RED, T006 passed.

Four references — `langfuse-minio` and `langfuse-minio-init`, in `compose.yaml` and `compose.prod.yaml`
— become `${REGISTRY_HOST}/jumbleknot/minio:RELEASE.2025-09-07T16-13-09Z@sha256:…`.

**Change nothing else.** Health check stays `CMD-SHELL "mc ready local || exit 1"`; the init entrypoint
stays the `/bin/sh -c "mc alias set … && mc mb …"` chain; prod's ready-marker logic is untouched. If
either needs editing, the image violates contract C1 or C2 — fix the image, not the stack.

**Verify GREEN**:
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected GREEN**: 0 failures — the declared exception list and the observed floating set are both
empty.

### T009 — Update the discharge guard's image list

**Type**: Test refactor | **Time**: 20m | **Risk**: Low

The `(063) every allowlist entry for a formerly-floating image can be discharged by an upgrade` test
carries a `NEXT` map naming `minio/minio` and `minio/mc`, and asserts each is still referenced under
`infrastructure-as-code/**` ("is this list stale?"). After T008 they are not. Remove those two entries
from the map, leaving `grafana/otel-lgtm`.

**Verify RED** (after T008, before T010):
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected RED**: 2 failures — `minio/minio is not referenced in infrastructure-as-code/** any more` and
the same for `minio/mc`.

### T010 — Delete the four MinIO allowlist entries

**Type**: Implementation | **Time**: 15m | **Risk**: Low

**Prerequisite**: T009 verified RED.

Delete from `security/infra-images/allowlist.yaml`: `minio/mc` × `CVE-2025-68121`, `minio/mc` ×
`CVE-2026-33186`, `minio/minio` × `CVE-2025-68121`, `minio/minio` × `CVE-2026-33186`. Leave a comment
recording why, in the style of the file's other removals.

**Do not pre-emptively add entries for the new image.** Whether the from-source build still carries
`CVE-2025-68121` is what the first real sweep answers — and research §R3 predicts a newer Go clears it.
Writing a suppression now could hide a success.

**Verify GREEN**:
```bash
node --test scripts/__tests__/*.test.mjs && node scripts/check-infra-image-findings.mjs --selftest
```
**Expected GREEN**: 0 failures; selftest passes.

### T011 — Verify the live volume's ownership

**Type**: Verification | **Time**: 10m | **Risk**: **High if skipped**

**Spec reference**: the one unresolved assumption in [spec.md](./spec.md) Assumptions, carried through
plan.md Risks and research §R5.

```bash
docker run --rm -v langfuse-minio-data:/data alpine:3.24 stat -c '%u:%g %n' /data
```
**Expected**: `0:0 /data`.

**If not `0:0`**: STOP before any production rollout. Contract C5's premise is wrong for this host and
the rollout needs an ownership step this change deliberately excludes. Record the observed value on
item #420.

### T012 — Stack acceptance: Langfuse ingestion end to end

**Type**: Integration acceptance | **Time**: 45m | **Risk**: Medium

**Scenarios covered**: US1-AC1 … US1-AC4, SC-001, SC-002, SC-003.

Follow [quickstart.md](./quickstart.md) §3–6.

**Expected**: `langfuse-minio` reaches `healthy`; `langfuse-minio-init` exits 0 logging
`langfuse bucket ready`; a recorded trace produces **no** `Failed to upload JSON to S3`; and — run
against a volume already written by the current image — the pre-existing object count is unchanged.

> §6 is the one that tests what would break production. §5 passes on an empty volume.

---

## Phase 4: User Story 2 — the change gate stops being blocked (P1)

**Goal**: publish the image so the sweep can resolve it, and prove the sweep is real.

**Independent test**: a full sweep completes with a findings verdict rather than a fetch failure.

- [ ] T013 [US2] Add the build workflow `.forgejo/workflows/minio-image.yml`, including its failure digest
- [ ] T014 [US2] Publish the image to the forge registry and capture its digest
- [ ] T015 [US2] Pin the published digest in both compose files
- [ ] T016 [US2] Verify a **real** CI sweep per [quickstart.md](./quickstart.md) §9

### T013 — The build workflow

**Type**: New file | **Time**: 1h | **Risk**: Medium

**Spec reference**: FR-001, FR-009.

Model on `.forgejo/workflows/devcontainer-image.yml`: `workflow_dispatch` + `push` filtered to
`infrastructure-as-code/docker/minio/**` + `schedule` weekly. Host-free registry coordinates from
Forgejo vars (`REGISTRY`, `NS`, `REGISTRY_USER`) and `secrets.REGISTRY_TOKEN` — never a git literal
(topology-scrub and inline-secret gates both enforce this).

**Must include a failure-digest step.** `check-ci-digest-coverage.mjs` asserts *every job in every
workflow* publishes a guarded digest; a tenth workflow without one reddens `guardrails / naming`. Add
the digest step, or a justified `# ci-digest-exempt: <reason>` — the former, since this job can fail in
ways worth diagnosing.

**Verify RED** (add the workflow *without* the digest step first — this is a genuine RED):
```bash
node scripts/check-ci-digest-coverage.mjs
```
**Expected RED**: 1 failure naming the new workflow's job as uncovered.

**Verify GREEN** (after adding the digest step):
```bash
node scripts/check-ci-digest-coverage.mjs && node scripts/check-topology-scrub.mjs && node scripts/check-no-inline-secrets.mjs
```
**Expected GREEN**: all pass; the coverage gate reports 10 workflows.

### T014 — Publish

**Type**: Operational | **Time**: 30m (build time) | **Risk**: Low

Dispatch the workflow; capture the published `@sha256:` digest from its output.

**Expected**: the image is listed in the forge registry under `${NS}/minio` with the release tag.

### T015 — Pin the published digest

**Type**: Implementation | **Time**: 10m | **Risk**: Low

Replace the placeholder digest from T008 with the real one in both compose files (contract C6).

**Verify GREEN**:
```bash
node scripts/check-resource-naming.mjs --section=all && node --test scripts/__tests__/*.test.mjs
```
**Expected**: 0 failures, and no reference to this image anywhere lacking `@sha256:`.

### T016 — Prove the sweep was real

**Type**: Verification | **Time**: 15m | **Risk**: Low

**Scenarios covered**: US2-AC1, US2-AC2, SC-004, SC-005.

Per [quickstart.md](./quickstart.md) §9, read the **job duration from the commit status description**.

**Expected**: `infra-image-scan / infra-image-scan` reports `Successful in 2m30s`–`3m`.

> `Successful in 2s`–`14s` means Trivy never ran and the green proves nothing. Never compute this from
> `/actions/runs` timestamps — those are workflow-level and include queueing.

Also confirm PR #415 is no longer blocked by an unfetchable image (SC-005).

---

## Phase 5: User Story 3 — security updates become possible (P2)

**Goal**: prove a rebuild can be produced without an upstream release.

**Independent test**: trigger a rebuild with no version change; a new digest is produced.

- [ ] T017 [US3] Trigger a no-change rebuild and confirm a new digest
- [ ] T018 [US3] Record the observed findings for the from-source image

### T017 — No-change rebuild

**Type**: Verification | **Time**: 30m | **Risk**: Low

**Scenarios covered**: US3-AC1, SC-008.

Dispatch the workflow with no source-version change.

**Expected**: a build succeeds and publishes a **different** digest from T014 — the base and toolchain
layers moved. An identical digest means the build is not picking up base updates and the weekly cron is
doing nothing.

### T018 — Record what the from-source image actually carries

**Type**: Verification | **Time**: 20m | **Risk**: Low

**Scenarios covered**: US3-AC2, SC-009.

From the first real sweep (T016), record the findings for `jumbleknot/minio`.

**Expected**: `CVE-2025-68121` (Go stdlib) is **absent** — research §R3 predicts the newer toolchain
clears it. If it is present, the builder pin is too old; if a *different* Critical appears, triage it
on its merits and add a justified allowlist entry then — not before.

---

## Phase 6: User Story 4 — provenance (P3)

**Goal**: a moved upstream tag fails the build rather than silently changing the artifact.

- [ ] T019 [US4] Prove the commit assertion fails the build on a mismatch

### T019 — Commit-pin negative test

**Type**: Test | **Time**: 20m | **Risk**: Low

**Scenarios covered**: US4-AC2.

Build with a deliberately wrong `MINIO_COMMIT`.

**Verify RED-equivalent** (the failure IS the expected behaviour):
```bash
docker build --build-arg MINIO_COMMIT=0000000000000000000000000000000000000000 \
  -t mcm-minio:badpin infrastructure-as-code/docker/minio/
```
**Expected**: the build **fails** with a clear mismatch message. A successful build here means the
assertion is not wired up and FR-003 is unmet.

---

## Phase 7: Polish & cross-cutting

- [ ] T020 [P] Migrate MinIO version tracking in `renovate.json` to a `github-releases` customManager
- [ ] T021 [P] Update the Renovate guard in `scripts/__tests__/renovate-workflow.guard.test.mjs`
- [ ] T022 [P] Update `docs/runbooks/infra-image-scanning.md` for the emptied exception set
- [ ] T023 [P] File the non-root follow-up and close the loop on item #420
- [ ] T024 Full gate sweep before opening the pull request

### T020 — Renovate tracking follows the source

**Type**: Implementation | **Time**: 45m | **Risk**: Medium

**Spec reference**: FR-013.

Remove `minio/minio` and `minio/mc` from the docker-datasource date-tag `versioning` rule; add a
`customManagers` regex over the Dockerfile's `*_RELEASE` / `*_COMMIT` ARGs using the `github-releases`
datasource, **preserving the date versioning** — without it `RELEASE.2025-10-15…` is not recognised as
newer than `RELEASE.2025-09-07…` and the security bump this feature exists to enable is never proposed.

The tag and commit args MUST move together (data-model E2). A rule that moves one is the half-bump
shape this repository has paid for four times.

**Verify GREEN**:
```bash
npx --yes --package renovate@44 -- renovate-config-validator --strict --no-global renovate.json
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected**: validator passes; 0 test failures.

### T021 — Renovate guard follows

**Type**: Test refactor | **Time**: 30m | **Risk**: Low

Whatever in `renovate-workflow.guard.test.mjs` asserts MinIO's date-tag rule membership now asserts the
new premise. Update at the cause; do not delete.

**Verify RED** (before T020 lands, or by reverting it locally):
```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected RED**: failure naming the MinIO date-tag rule.

### T022 — Runbook: the emptied exception set

**Type**: Documentation | **Time**: 20m | **Risk**: None

`docs/runbooks/infra-image-scanning.md` states *"a floating count of 0 is a FAILURE, not a success"*.
That is now wrong as written. Restate it: **0 is correct when it results from removing the images; 0 is
a failure when it results from widening the classifier.** A runbook contradicting the codebase is worse
than either alone.

Also update the feature-063 pin table, which lists the two MinIO refs as pinned exceptions.

**Verify**: `node scripts/check-openwiki-governance.mjs && node scripts/check-openwiki-okf.mjs`

### T023 — Follow-ups

**Type**: Documentation | **Time**: 20m | **Risk**: None

**Spec reference**: FR-015.

File the non-root migration as its own backlog item — the one-time volume `chown`, the `USER`
directive, and contract C5's renegotiation — with T011's observed ownership recorded. Comment the
outcome on item #420 and close it when the sweep is green.

### T024 — Full gate sweep

**Type**: Verification | **Time**: 20m | **Risk**: None

```bash
node --test scripts/__tests__/*.test.mjs
node scripts/check-resource-naming.mjs --section=all
node scripts/check-no-inline-secrets.mjs && node scripts/check-topology-scrub.mjs
node scripts/check-ci-digest-coverage.mjs && node scripts/check-toolchain-consistency.mjs
node scripts/check-openwiki-governance.mjs && node scripts/check-openwiki-okf.mjs
node scripts/secret-scan.mjs
```
**Expected**: every command exits 0.

---

## Dependencies

```
Phase 1 (T001)
  └─> Phase 2 (T002 → T003 → T004)        [BLOCKING — the scanner partition]
        └─> Phase 3 / US1 (T005 → T006 → T007 → T008 → T009 → T010 → T011 → T012)
              └─> Phase 4 / US2 (T013 → T014 → T015 → T016)
                    ├─> Phase 5 / US3 (T017, T018)
                    └─> Phase 6 / US4 (T019)
                          └─> Phase 7 (T020 → T021, T022, T023, T024)
```

**Hard orderings** (each is a RED that a later task turns GREEN):

- T002 before T003 — the exclusion fix must be RED first
- T007 before T008 — the floating premise must be RED before the refs move
- T009 before T010 — the discharge guard must be RED before the entries go
- T013's no-digest state before its digest step
- **T011 before any production rollout** — not before T012, but absolutely before prod

**Story independence**: US1 delivers the repair alone. US2 requires US1's compose refs to exist. US3
and US4 are independent of each other and both require US2's published image.

## Parallel opportunities

- T002 and T004 (different files)
- T007 and T009 touch the **same file** — despite both being `[P]`-eligible by story, run them
  sequentially in the stated order, because their RED states are distinguishable only in sequence
- T020, T021, T022, T023 (different files)

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1).** That repairs the latent production failure and leaves the
stack startable. Phase 4 makes the gate green and is required before merge, since `infra-image-scan` is
a required context.

**Suggested pull-request shape**: one PR. The changes are mutually dependent — the compose refs need
the published image, the guards need the compose refs, the allowlist needs the guards — so splitting
them produces intermediate states that are red for uninteresting reasons. This matches
`openwiki/process/pull-request-batching.md`: batch by default, split only when a red would be ambiguous.
Here a red would be *less* ambiguous batched.

## Task count

**24 tasks** — Setup 1, Foundational 3, US1 8, US2 4, US3 2, US4 1, Polish 5.
