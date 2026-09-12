# Tasks: MinIO built from source

**Feature**: `specs/069-minio-from-source` | **Branch**: `408-minio-from-source`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Quickstart**: [quickstart.md](./quickstart.md)

Task detail blocks follow `docs/templates/feature-test-tasks-template.md`, mandatory per the
constitution's TDD Checkpoint Format.

> **Revised after `/speckit-analyze`.** Two findings changed this file:
> **F1 (critical)** — the first draft repointed compose at a registry digest that would not exist until
> a later phase, making US1's own acceptance untestable where it was scheduled. Publishing now happens
> **before** the repoint, which also removed a task (the separate "pin the real digest" step).
> **F2 (high)** — the first draft asserted a no-change rebuild produces a *different* digest. With both
> base images digest-pinned that is false, and it would have shipped a weekly job believed to be
> applying patches while changing nothing. See research §R8, now corrected.

**A note on what TDD means here.** The JavaScript changes (scanner scope, guards) get full RED→GREEN
treatment. The Dockerfile and workflow have no unit under test — their correctness is behavioural — so
they are covered by integration-level acceptance with exact expected output. Where a task is a control
assertion that is legitimately green before and after, it says so rather than pretending to be RED.

**Ordering principle**: where a guard's premise changes, the **guard is rewritten first** so it goes
RED against the current tree, and the tree change makes it GREEN. That converts three would-be
test-after edits into genuine RED→GREEN cycles.

---

## Phase 1: Setup

- [X] T001 Create the image directory and Dockerfile skeleton with pinned build args in `infrastructure-as-code/docker/minio/Dockerfile`

### T001 — Dockerfile skeleton with pinned inputs

**Type**: New file | **Time**: 15m | **Risk**: None
**Spec reference**: FR-006 (same versions as in service)

Create `infrastructure-as-code/docker/minio/Dockerfile` containing only the pinned inputs as `ARG`s, no
build logic yet. Values resolved in [research.md](./research.md) §R3/§R4:

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

**Verify**: `grep -c '^ARG' infrastructure-as-code/docker/minio/Dockerfile` → ≥ 4.

---

## Phase 2: Foundational — the scanner partition

**Blocking.** Fixes a latent hole that would let this feature's own artifact be published unexamined.
Must land before anything `jumbleknot/`-namespaced and non-cd-deploy is published.

- [X] T002 [P] Add scanner-scope assertions to `scripts/__tests__/infra-image-scan.test.mjs`
- [X] T003 Tighten the exclusion rule in `scripts/infra-image-scan.mjs`
- [X] T004 [P] Record the corrected scope rule in `docs/runbooks/infra-image-scanning.md`

### T002 — Assert the scanner partition is complete, not just disjoint

**Type**: Test | **Time**: 30m | **Risk**: Low
**Spec reference**: FR-010, FR-011 · [contracts/scanner-scope.md](./contracts/scanner-scope.md)

**Scenarios covered**: US2-AC1 · SC-006

**File(s)**: `scripts/__tests__/infra-image-scan.test.mjs`

Add, against **fixtures** rather than the live tree (a live-tree assertion silently stops testing
anything the day MinIO is the only such image and someone removes it):

1. **The regression case** — a fixture compose referencing `jumbleknot/minio:RELEASE.X@sha256:…`, not in
   `BUILT_IMAGE_NAMES`. Assert `enumerateImages` **includes** it.
2. **The control** — a fixture referencing `jumbleknot/mc-service:latest`, which *is* in
   `BUILT_IMAGE_NAMES`. Assert `enumerateImages` **excludes** it. Green before and after, deliberately:
   it catches over-correction into scanning everything, which would break disjointness.

**Verify RED**:
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected RED**: exactly **1** failing assertion — the regression case, reporting that
`jumbleknot/minio…` was not enumerated. The control passes.

> 0 failures means the exclusion rule was already correct and this feature's premise is wrong — stop and
> re-read `contracts/scanner-scope.md`.

### T003 — Exclude by cd-deploy coverage, not by name

**Type**: Implementation | **Time**: 15m | **Risk**: Medium
**Spec reference**: FR-010, FR-011
**Prerequisite**: T002 verified RED.

Replace `if (ref.includes('jumbleknot/')) continue;` with membership of `BUILT_IMAGE_NAMES` (already
declared in the same file). The existing comment — "our built images (cd-deploy owns them)" — becomes
true rather than aspirational.

**Medium risk**: this gates what gets scanned repo-wide. Too loose and images escape; too tight and
cd-deploy's images get double-scanned and disjointness fails.

**Verify GREEN**:
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected GREEN**: 0 failures.

**Also run the touched suite**:
```bash
node --test scripts/__tests__/*.test.mjs
```
**Expected**: 0 failures — the disjointness test must still pass.

### T004 — Runbook: the scope rule

**Type**: Documentation | **Time**: 15m | **Risk**: None
**Spec reference**: FR-011

Record why the rule is membership-based, and that the comment previously described an intent the code
did not implement. No RED/GREEN — documentation.

**Verify**: `node scripts/check-openwiki-governance.mjs && node scripts/check-openwiki-okf.mjs`

---

## Phase 3: User Story 1 — the stack starts from a cold cache (P1)

**Goal**: replace the deleted images with one we build, without changing anything else about the stack.

**Independent test**: on a host with no cached MinIO image, the observability stack starts and every
service reaches healthy.

> **Publishing is inside this story, not after it.** US1's acceptance is "starts from a cold cache",
> which is only meaningful against a real registry image. That is F1's correction.

- [X] T005 [US1] Implement the multi-stage build in `infrastructure-as-code/docker/minio/Dockerfile`
- [X] T006 [US1] Build locally and verify the image contract C1–C5 per [quickstart.md](./quickstart.md) §1–2
- [X] T007 [US1] Add the build workflow `.forgejo/workflows/minio-image.yml`, including its failure digest
- [X] T008 [US1] Publish the image and capture its digest
- [X] T009 [P] [US1] Rewrite the floating-tag premise in `scripts/__tests__/infra-image-scan.test.mjs`
- [X] T010 [US1] Repoint the four image refs in `infrastructure-as-code/docker/observability/compose.yaml` and `compose.prod.yaml`
- [X] T011 [US1] Update the discharge guard's image list in `scripts/__tests__/infra-image-scan.test.mjs`
- [X] T012 [US1] Delete the four MinIO entries from `security/infra-images/allowlist.yaml`
- [X] T013 [US1] Verify the live volume's ownership against the real volume
- [X] T014 [US1] Bring the stack up and prove Langfuse ingestion end to end per [quickstart.md](./quickstart.md) §3–6

### T005 — The multi-stage build

**Type**: Implementation | **Time**: 1h | **Risk**: Medium
**Spec reference**: FR-001, FR-002, FR-003, FR-004, FR-005, FR-007
**Scenarios covered**: US4-AC1

Builder stage: fetch each source at its `*_RELEASE` tag, **assert `HEAD` equals the pinned `*_COMMIT`
and fail the build on mismatch** (FR-003), then build with
`CGO_ENABLED=0 GOTOOLCHAIN=local go build -tags kqueue -trimpath --ldflags "<generated stamp>"`.
Preserve the upstream ldflags stamp — research §R2 explains why losing it is silent. `GOTOOLCHAIN=local`
satisfies FR-004 by suppressing the toolchain download the `toolchain` directives would trigger.

Runtime stage: alpine, copy both binaries to `/usr/bin/` (FR-002), `ENTRYPOINT ["minio"]`, **no `USER`
directive** (root, contract C5 / FR-007), no `CMD` (compose supplies it, contract C4).

**Verify GREEN** is T006.

### T006 — Image contract acceptance

**Type**: Integration acceptance | **Time**: 20m | **Risk**: Low
**Spec reference**: FR-002, FR-005 · contracts C1, C2, **C3**, C4, C5
**Scenarios covered**: US4-AC1

```bash
docker build -t mcm-minio:local infrastructure-as-code/docker/minio/
docker run --rm --entrypoint sh mcm-minio:local -c 'minio --version && mc --version && id -u'
```
**Expected**: `minio` reports `RELEASE.2025-09-07T16-13-09Z` (C3); `mc` reports
`RELEASE.2025-08-13T08-35-41Z` (C3); `id -u` reports `0` (C5); the command runs at all (C2); both
binaries resolve on `PATH` (C1).

**MEASURED LOCALLY 2026-09-12** — this task was first marked done on CI evidence, because the dev
container could not reach the Go module hosts. That was a reasonable substitution but not the task as
written; once `proxy.golang.org`, `sum.golang.org` and `storage.googleapis.com` were allowlisted it was
done properly:

```
minio version RELEASE.2025-09-07T16-13-09Z (commit-id=07c3a429bfed…)
Runtime: go1.25.14 linux/amd64
mc    version RELEASE.2025-08-13T08-35-41Z (commit-id=7394ce0dd2a…)
Runtime: go1.25.14 linux/amd64
uid: 0
```

The `Runtime:` line is the bonus: upstream's release of this source declares `toolchain go1.24.2`, and
ours runs go1.25.14 from the same commits — the toolchain substitution is observable in the artifact,
not just intended.

> `DEVELOPMENT` or an empty version means the ldflags stamp was lost. The binaries work and the build
> exits 0 — this assertion is the only thing that catches it.

### T007 — The build workflow

**Type**: New file | **Time**: 1h | **Risk**: Medium
**Spec reference**: FR-001, FR-009

Model on `.forgejo/workflows/devcontainer-image.yml`: `workflow_dispatch` + `push` filtered to
`infrastructure-as-code/docker/minio/**` + `schedule` weekly. Host-free registry coordinates from
Forgejo vars (`REGISTRY`, `NS`, `REGISTRY_USER`) and `secrets.REGISTRY_TOKEN` — never a git literal.

**Comment the two triggers' distinct purposes** (research §R8): the push trigger is the patch path,
fired by Renovate bumping a pinned digest; the cron is a canary proving the build still works. Writing
this down is the fix for F2 — without it the next reader re-derives the wrong model.

**Must include a failure-digest step.** `check-ci-digest-coverage.mjs` asserts every job in every
workflow publishes a guarded digest; a tenth workflow without one reddens `guardrails / naming`.

**Verify RED** (add the workflow *without* the digest step first — a genuine RED):
```bash
node scripts/check-ci-digest-coverage.mjs
```
**Expected RED**: 1 failure naming the new workflow's job as uncovered.

**Verify GREEN** (after adding the digest step):
```bash
node scripts/check-ci-digest-coverage.mjs && node scripts/check-topology-scrub.mjs && node scripts/check-no-inline-secrets.mjs
```
**Expected GREEN**: all pass; coverage gate reports **10** workflows.

### T008 — Publish

**Type**: Operational | **Time**: 30m (build time) | **Risk**: Low
**Spec reference**: FR-001

Dispatch the workflow; capture the published `@sha256:` digest.

**Expected**: the image is listed in the forge registry under `${NS}/minio` with the release tag, and
the digest is recorded for T010.

### T009 — Rewrite the floating-tag guard to the new premise

**Type**: Test refactor | **Time**: 30m | **Risk**: Medium
**Spec reference**: FR-014 · [contracts/scanner-scope.md](./contracts/scanner-scope.md) "Consequence"
**Scenarios covered**: SC-006

The guard asserts the floating-tag exception set equals exactly the two MinIO refs, and the runbook
states *"a floating count of 0 is a FAILURE, not a success"*. This change empties the set
**legitimately** — by removing the images, not by weakening `isFloatingTag`. Rewrite it to assert the
set equals the **declared** exception list whatever that list contains, so an empty declared list and an
empty observed set agree, while a widened classifier still fails.

**Do not delete or relax this guard** — per CLAUDE.md, update at the cause.

**Verify RED** (before T010, against the tree that still references MinIO):
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected RED**: 1 failure — the declared list is empty while the tree still yields two floating refs.

### T010 — Repoint the four image references

**Type**: Implementation | **Time**: 20m | **Risk**: Medium
**Spec reference**: FR-008 · contract C6
**Prerequisite**: T008 published (real digest available), T009 verified RED.

Four references — `langfuse-minio` and `langfuse-minio-init`, in `compose.yaml` and `compose.prod.yaml`
— become `${REGISTRY_HOST}/jumbleknot/minio:RELEASE.2025-09-07T16-13-09Z@sha256:<T008's digest>`. Use
the **real** digest; there is no placeholder step.

**Change nothing else** (FR-008). Health check stays `CMD-SHELL "mc ready local || exit 1"`; the init
entrypoint stays the `/bin/sh -c "mc alias set … && mc mb …"` chain; prod's ready-marker logic is
untouched. If either needs editing, the image violates contract C1 or C2 — fix the image, not the stack.

**Verify GREEN**:
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs && node scripts/check-resource-naming.mjs --section=all
```
**Expected GREEN**: 0 failures; declared exception list and observed floating set both empty; no
reference to this image lacking `@sha256:`.

### T011 — Update the discharge guard's image list

**Type**: Test refactor | **Time**: 20m | **Risk**: Low
**Spec reference**: FR-014

The `(063) every allowlist entry for a formerly-floating image can be discharged by an upgrade` test
carries a `NEXT` map naming `minio/minio` and `minio/mc`, asserting each is still referenced under
`infrastructure-as-code/**`. After T010 they are not. Remove those two, leaving `grafana/otel-lgtm`.

**Verify RED** (after T010, before T012):
```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```
**Expected RED**: 2 failures — `minio/minio is not referenced in infrastructure-as-code/** any more`, and
the same for `minio/mc`.

### T012 — Delete the four MinIO allowlist entries

**Type**: Implementation | **Time**: 15m | **Risk**: Low
**Spec reference**: **FR-012** · **SC-007**
**Prerequisite**: T011 verified RED.

Delete `minio/mc` × `CVE-2025-68121`, `minio/mc` × `CVE-2026-33186`, `minio/minio` × `CVE-2025-68121`,
`minio/minio` × `CVE-2026-33186`. Leave a comment recording why, in the style of the file's other
removals.

**Do not pre-emptively add entries for the new image.** Whether the from-source build still carries
`CVE-2025-68121` is what the first real sweep answers — research §R3 predicts a newer Go clears it.
Writing a suppression now could hide a success.

**Verify GREEN**:
```bash
node --test scripts/__tests__/*.test.mjs && node scripts/check-infra-image-findings.mjs --selftest
```
**Expected GREEN**: 0 failures; selftest passes.

### T013 — Verify the live volume's ownership

**Type**: Verification | **Time**: 10m | **Risk**: **High if skipped**
**Spec reference**: FR-007 · contract C5

The one inferred fact in the whole design (spec Assumptions, plan Risks, research §R5).

```bash
docker volume ls | grep -i minio        # find the REAL name first — compose prefixes it
docker run --rm -v observability-langfuse-minio-data:/data alpine:3.24 \
  sh -c 'stat -c "%u:%g %n" /data; ls -la /data'
```
**Expected**: `0:0 /data`, **and a non-empty `/data`**.

**MEASURED on the production host 2026-09-12 — C5's premise holds:**

```
0:0 /data
drwxr-xr-x  .minio.sys   Aug 30 15:52
drwxr-xr-x  langfuse     Jul  4 13:54
```

> **The `ls` is not decoration.** `docker run -v <name>:/data` CREATES the volume if it does not
> exist, and a fresh volume is `0:0` — so ownership alone cannot distinguish "the production volume is
> root-owned" from "nothing by that name existed and you measured an empty one Docker just made".
>
> That is not hypothetical: the first attempt used the unprefixed `langfuse-minio-data`, which did not
> exist, and Docker duly created it and reported `0:0`. The real volume is
> `observability-langfuse-minio-data` — compose prefixes with the project name. The stray was removed.
> Ownership plus real contents is the measurement; ownership alone is a command reporting its own
> side effect.

**If not `0:0`**: STOP before any production rollout. Contract C5's premise is wrong for this host and
the rollout needs an ownership step this change deliberately excludes. Record the value on item #420.

### T014 — Stack acceptance: Langfuse ingestion end to end

**Type**: Integration acceptance | **Time**: 45m | **Risk**: Medium
**Spec reference**: FR-002, FR-006, FR-008
**Scenarios covered**: US1-AC1, US1-AC2, US1-AC3, US1-AC4 · SC-001, SC-002, SC-003

Follow [quickstart.md](./quickstart.md) §3–6, against the **published** image via the repointed compose.

**Expected**: `langfuse-minio` reaches `healthy`; `langfuse-minio-init` exits 0 logging
`langfuse bucket ready`; a recorded trace produces **no** `Failed to upload JSON to S3`; and — run
against a volume already written by the current image — the pre-existing object count is unchanged.

> §6 is the one that tests what would break production. §5 passes on an empty volume.

---

## Phase 4: User Story 2 — the change gate stops being blocked (P1)

**Goal**: prove the sweep resolves every image and is real.

- [X] T015 [US2] Verify a **real** CI sweep and confirm the blocked pull request proceeds, per [quickstart.md](./quickstart.md) §9

### T015 — Prove the sweep was real

**Type**: Verification | **Time**: 15m | **Risk**: Low
**Spec reference**: FR-010
**Scenarios covered**: US2-AC1, US2-AC2 · SC-004, SC-005

Read the **job duration from the commit status description**.

**Expected**: `infra-image-scan / infra-image-scan` reports `Successful in 2m30s`–`3m`.

> `Successful in 2s`–`14s` means Trivy never ran and the green proves nothing. Never compute this from
> `/actions/runs` timestamps — workflow-level and inflated by queueing.

Also confirm `node scripts/infra-image-scan.mjs --list | grep -i minio` lists `jumbleknot/minio`
(quickstart §8) and that PR #415 is no longer blocked by an unfetchable image (SC-005).

---

## Phase 5: User Story 3 — security updates become possible (P2)

- [X] T016 [US3] Prove the canary rebuild works and produces an equivalent image
- [X] T017 [US3] Record the observed findings for the from-source image

### T016 — Canary rebuild

**Type**: Verification | **Time**: 30m | **Risk**: Low
**Spec reference**: FR-009
**Scenarios covered**: US3-AC1 · SC-008

Dispatch the workflow with **no** input change.

**Expected**: the build **succeeds**. That is the whole assertion — the canary property.

**Do NOT assert anything about the digest.** This task has now had its expectation wrong twice, in
opposite directions, and the second time was settled by measurement rather than argument:

| draft | claimed | outcome |
|---|---|---|
| first | a rebuild yields a **different** digest, proving patches were picked up | wrong — base images are digest-pinned |
| second | a rebuild yields an **identical** digest, proving reproducibility | **also wrong** — runs 3115 and 3117 built identical source and produced `sha256:7038b9e9…` and `sha256:1e981fa1…` |

The cause is in our own Dockerfile: `apk add --no-cache ca-certificates` and `apk add --no-cache git`
resolve against Alpine's live package index at build time. The image is **not bit-reproducible**, and
the weekly cron therefore does pick up Alpine package updates — a real but narrow patch path, distinct
from base-image and Go-toolchain patches, which are digest-pinned and arrive via Renovate.

Research §R8 carries the per-input table. If bit-reproducibility is ever wanted, the apk installs need
pinning too — a separate decision with its own maintenance cost, not part of this feature.

**Also verify the patch path exists**: `renovate.json`'s docker rules cover the new Dockerfile's `FROM`
lines, so a base digest bump is proposed. Confirm in T018's validator run.

### T017 — Record what the from-source image actually carries

**Type**: Verification | **Time**: 20m | **Risk**: Low
**Spec reference**: FR-009
**Scenarios covered**: US3-AC2 · SC-009

From the first real sweep (T015), record the findings for `jumbleknot/minio`.

**Expected**: `CVE-2025-68121` (Go stdlib) is **absent** — research §R3 predicts the newer toolchain
clears it. If present, the builder pin is too old. If a *different* Critical appears, triage it on its
merits and add a justified allowlist entry then — not before.

---

## Phase 6: User Story 4 — provenance (P3)

- [X] T018 [US4] Prove the commit assertion fails the build on a mismatch

### T018 — Commit-pin negative test

**Type**: Test | **Time**: 20m | **Risk**: Low
**Spec reference**: FR-003
**Scenarios covered**: US4-AC2

```bash
docker build --build-arg MINIO_COMMIT=0000000000000000000000000000000000000000 \
  -t mcm-minio:badpin infrastructure-as-code/docker/minio/
```
**Expected**: the build **fails** with a clear mismatch message. A successful build means the assertion
is not wired up and FR-003 is unmet.

---

## Phase 7: Polish & cross-cutting

- [X] T019 [P] Migrate MinIO version tracking in `renovate.json` to a `github-releases` customManager
- [X] T020 [P] Update the Renovate guard in `scripts/__tests__/renovate-workflow.guard.test.mjs`
- [X] T021 [P] Update `docs/runbooks/infra-image-scanning.md` for the emptied exception set
- [X] T022 [P] File the non-root follow-up and close the loop on item #420
- [X] T023 Full gate sweep before opening the pull request

### T019 — Renovate tracking follows the source

**Type**: Implementation | **Time**: 45m | **Risk**: Medium
**Spec reference**: FR-013

Remove `minio/minio` and `minio/mc` from the docker-datasource date-tag `versioning` rule; add a
`customManagers` regex over the Dockerfile's `*_RELEASE` / `*_COMMIT` ARGs using the `github-releases`
datasource, **preserving date versioning** — without it `RELEASE.2025-10-15…` is not recognised as newer
than `RELEASE.2025-09-07…` and the security bump this feature enables is never proposed.

Tag and commit args MUST move together (data-model E2) — a rule that moves one is the half-bump shape
this repository has paid for four times.

**Verify GREEN**:
```bash
npx --yes --package renovate@44 -- renovate-config-validator --strict --no-global renovate.json
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected**: validator passes; 0 test failures.

### T020 — Renovate guard follows

**Type**: Test refactor | **Time**: 30m | **Risk**: Low
**Spec reference**: FR-014

Whatever asserts MinIO's date-tag rule membership now asserts the new premise. Update at the cause.

**Verify RED** (before T019 lands, or by reverting it locally):
```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```
**Expected RED**: failure naming the MinIO date-tag rule.

### T021 — Runbook: the emptied exception set

**Type**: Documentation | **Time**: 20m | **Risk**: None
**Spec reference**: FR-014

The runbook states *"a floating count of 0 is a FAILURE, not a success"*. Now wrong as written.
Restate: **0 is correct when it results from removing the images; 0 is a failure when it results from
widening the classifier.** A runbook contradicting the codebase is worse than either alone. Also update
the feature-063 pin table, which lists the two MinIO refs.

**Verify**: `node scripts/check-openwiki-governance.mjs && node scripts/check-openwiki-okf.mjs`

### T022 — Follow-ups

**Type**: Documentation | **Time**: 20m | **Risk**: None
**Spec reference**: **FR-015**

File the non-root migration as its own backlog item — the one-time volume `chown`, the `USER` directive,
and contract C5's renegotiation — with T013's observed ownership recorded. Comment the outcome on item
#420 and close it when the sweep is green.

### T023 — Full gate sweep

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
  └─> Phase 2 (T002 → T003 → T004)              [BLOCKING — the scanner partition]
        └─> Phase 3 / US1
              T005 → T006 → T007 → T008 → T009 → T010 → T011 → T012 → T013 → T014
                                    ^publish before repoint (F1)
              └─> Phase 4 / US2 (T015)
                    ├─> Phase 5 / US3 (T016, T017)
                    └─> Phase 6 / US4 (T018)
                          └─> Phase 7 (T019 → T020, T021, T022, T023)
```

**Hard orderings** (each a RED that a later task turns GREEN):

- T002 before T003 — the exclusion fix must be RED first
- T007's no-digest state before its digest step
- **T008 before T010** — publish before repointing, or US1's acceptance runs against a digest that does
  not exist (F1)
- T009 before T010 — the floating premise must be RED before the refs move
- T011 before T012 — the discharge guard must be RED before the entries go
- T020 before T019 — the Renovate guard must be RED before the rule changes
- **T013 before any production rollout** — not before T014, but absolutely before prod

**Story independence**: US1 is self-contained *including publishing*, and delivers the repair alone.
US2, US3 and US4 all verify properties of what US1 produced, so they follow it; US3 and US4 are
independent of each other.

## Parallel opportunities

- T002 and T004 (different files)
- T009 and T011 touch the **same file** — run sequentially in the stated order despite the `[P]`
  eligibility, because their RED states are distinguishable only in sequence
- T019, T020, T021, T022 (different files)

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3.** That repairs the latent production failure and leaves the stack
startable from a cold cache. Phase 4 is required before merge, since `infra-image-scan` is a required
context.

**Pull-request shape**: one PR. The changes are mutually dependent — compose needs the published image,
the guards need compose, the allowlist needs the guards — so splitting produces intermediate states red
for uninteresting reasons. Per `openwiki/process/pull-request-batching.md`: batch by default, split only
when a red would be ambiguous. Here a red is *less* ambiguous batched.

## Task count

**23 tasks** — Setup 1, Foundational 3, US1 10, US2 1, US3 2, US4 1, Polish 5.

## Requirement coverage

| Requirement | Tasks |
|---|---|
| FR-001 | T005, T007, T008 |
| FR-002 | T005, T006, T014 |
| FR-003 | T005, T018 |
| FR-004 | T005 |
| FR-005 | T005, T006 |
| FR-006 | T001, T014 |
| FR-007 | T005, T013 |
| FR-008 | T010, T014 |
| FR-009 | T007, T016, T017 |
| FR-010 | T002, T003, T015 |
| FR-011 | T002, T003, T004 |
| FR-012 | T012 |
| FR-013 | T019 |
| FR-014 | T009, T011, T020, T021 |
| FR-015 | T022 |
| SC-001, SC-002, SC-003 | T014 |
| SC-004, SC-005 | T015 |
| SC-006 | T002, T009 |
| SC-007 | T012 |
| SC-008 | T016 |
| SC-009 | T017 |

All 15 FRs and all 9 SCs have at least one task, by explicit ID.
