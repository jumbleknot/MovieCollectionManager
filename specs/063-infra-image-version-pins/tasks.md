# Tasks: Infra-image version pins

**Feature**: 063-infra-image-version-pins · **Branch**: `063-infra-image-version-pins`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Contract**: [contracts/renovate-rules.md](./contracts/renovate-rules.md)

TDD is NON-NEGOTIABLE per the constitution: every test task carries the acceptance scenarios it covers
and a **Verify RED** command with its expected failure; every paired implementation task carries a
**Verify GREEN**. A Verify RED showing 0 failures means the test is trivially passing and must be
fixed before implementation begins.

---

## Phase 1: Setup

- [ ] T001 Capture the pre-change digest baseline for all eight references into `specs/063-infra-image-version-pins/baseline-digests.txt`
  - **Spec reference**: SC-002, FR-002
  - Record `repository`, current floating tag, and the pinned `sha256:` from each compose file. This is
    the evidence SC-002 is measured against; without it, "the digests did not change" is unfalsifiable
    after the edit.
  - **Done when**: the file lists 8 rows, each matching a reference currently in
    `infrastructure-as-code/docker/**`.

---

## Phase 2: Foundational (blocking prerequisites)

- [ ] T002 Extend the package-rule model in `scripts/__tests__/renovate-workflow.guard.test.mjs` to accept `versioning` and to resolve docker-manager dependencies
  - **Spec reference**: FR-009 (enabling work)
  - `ruleMatches()` **throws** on any rule key it does not model — deliberately, so a new rule form
    cannot silently stop being asserted. Adding `versioning` to `renovate.json` therefore breaks every
    existing assertion in this file until the model knows the key. Add it to the known set, and add a
    `resolvedVersioning(dep)` helper mirroring `resolvedGroupName` / `resolvedAllowedVersions`.
  - **Done when**: the existing 43 assertions still pass unchanged, and `resolvedVersioning` is
    exported for use by later tasks.

> **Why this is foundational, not part of US1**: it changes no behaviour and asserts nothing new. It
> exists because the guard is intentionally fail-closed on unknown keys, and every later task in this
> feature would otherwise fail for that reason rather than for its own.

---

## Phase 3: User Story 1 — a reviewer can tell a major from a security patch (P1)

**Goal**: updates to these images resolve to a real update type and stay grouped, instead of arriving
as opaque digest changes.

**Independent test**: simulate an update per image and assert the resolved update type and group.
Delivers value even if Phases 4–5 never land.

### Tests (RED first)

- [ ] T003 [P] [US1] Assert the resolved update type per image in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Scenarios covered**: US1-AC1 (major separated), US1-AC2 (patch rides routine)
  - Assert contract C1 row by row: mailpit `v1.31.0`→`v2.0.0` is `major`; `v1.31.0`→`v1.32.0` is
    `minor`; curl `8.21.0`→`8.21.1` is `patch`; otel-lgtm, opa and unleash likewise. Assert that **no**
    reference resolves as digest-only.
  - **Verify RED**: `node --test --test-name-pattern 'update type' scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Expected RED**: assertions fail because the images are still floating — a floating ref has no
    version to classify. **If this reports 0 failures, the fixtures are not exercising the real config
    and must be corrected before proceeding.**

- [ ] T004 [P] [US1] Assert paired movement and variant exclusion in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Scenarios covered**: US1-AC1; FR-005, FR-006; contract C2, C3
  - Assert both `openpolicyagent/opa` refs resolve to the same group **and** the same proposed version;
    assert `-dev`, `-rootless` and pre-release tags are never allowed. Include the **control**: an
    unrelated docker image still lands in `docker base images`, so a rule that widened too far fails.
  - **Verify RED**: `node --test --test-name-pattern 'opa' scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Expected RED**: no rule constrains `openpolicyagent/opa`, so the variant-exclusion assertions fail.

- [ ] T005 [P] [US1] Assert the declared-exception count in `scripts/__tests__/infra-image-scan.test.mjs`
  - **Scenarios covered**: SC-006; contract C5
  - Assert the floating count equals the number of declared exceptions **exactly**. Assert both
    directions: more than the declared set fails, and **fewer** fails too — a count of 0 would mean the
    classifier was widened to hide the exceptions rather than declare them (research R4).
  - **Verify RED**: `node --test --test-name-pattern 'declared exception' scripts/__tests__/infra-image-scan.test.mjs`
  - **Expected RED**: 8 floating references against 2 declared — assertion fails naming the extra six.

### Implementation

- [ ] T006 [US1] Add the version-pin package rules to `renovate.json`
  - **Prerequisite**: T003, T004 complete and verified RED.
  - Add rules keeping all eight in `docker base images`; constrain `openpolicyagent/opa` so both refs
    move together and no `-dev`/`-rootless`/pre-release tag is proposed. Comment each rule with the
    measured reason, following the existing house style.
  - **Verify GREEN**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Expected GREEN**: 0 failures; T003 and T004 assertions pass.

- [ ] T007 [US1] Add `regex` versioning for the date-tagged family to `renovate.json`
  - **Prerequisite**: T006.
  - Apply `versioning: "regex:^RELEASE\\.(?<major>\\d{4})-(?<minor>\\d{2})-(?<patch>\\d{2})T…"` to
    `minio/minio` and `minio/mc`. **The comment MUST state that the mapping is calendar-derived**: a
    January release reports `major` because the year advanced, not because anything broke (FR-004,
    research R2). Record that `loose` was measured and cannot parse these tags at all.
  - **Verify GREEN**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Expected GREEN**: 0 failures.

- [ ] T008 [US1] Substitute the six semver-tagged references in `infrastructure-as-code/docker/keycloak/compose.yaml` and `infrastructure-as-code/docker/observability/compose.yaml` and `compose.prod.yaml`
  - **Prerequisite**: T006, T007 GREEN.
  - Apply research R1: mailpit→`v1.31.0`, curl→`8.21.0`, otel-lgtm→`0.32.0`, opa→`1.20.1`,
    opa-debug→`1.20.1-debug`, unleash→`8.1.0`. Keep the existing `@sha256:` digests **unchanged** —
    that is what makes the change notational.
  - **Verify GREEN**: `node scripts/infra-image-scan.mjs --list`
  - **Expected GREEN**: those six no longer appear under `[floating tag]`.

- [ ] T009 [US1] Substitute the two date-tagged references in `infrastructure-as-code/docker/observability/compose.yaml` and `compose.prod.yaml`
  - **Prerequisite**: T008.
  - `minio/minio`→`RELEASE.2025-09-07T16-13-09Z`, `minio/mc`→`RELEASE.2025-08-13T08-35-41Z`, digests
    unchanged. Kept separate from T008 so a digest mismatch names one family rather than eight.
  - **Verify GREEN**: `node --test scripts/__tests__/infra-image-scan.test.mjs`
  - **Expected GREEN**: 0 failures; T005's exact-count assertion passes at 2 declared exceptions.

- [ ] T010 [US1] Verify digest equivalence for all eight against the live registry, updating `specs/063-infra-image-version-pins/baseline-digests.txt`
  - **Prerequisite**: T008, T009.
  - **Spec reference**: SC-002, FR-002
  - Use the quickstart recipe (`auth.docker.io` token → `HEAD /v2/<repo>/manifests/<tag>`); note
    `hub.docker.com` is unreachable here.
  - **Verify GREEN**: all 8 post-change digests equal the T001 baseline.
  - **Expected GREEN**: 8/8 identical. **Any mismatch stops the feature** — it means a content change
    was smuggled in and the "notational only" claim is false.

**Checkpoint**: US1 is independently shippable here.

---

## Phase 4: User Story 2 — a suppression can be discharged by an upgrade (P2)

- [ ] T011 [US2] Assert suppression dischargeability in `scripts/__tests__/infra-image-scan.test.mjs`
  - **Scenarios covered**: US2-AC1, US2-AC2; FR-007
  - Assert that a version-keyed entry stops matching when the image moves to a newer version, and that
    every entry for these images is either version-keyed or carries a recorded reason it cannot be.
    Use the existing unanchored-regex semantics — a key must still match its own digest-pinned ref.
  - **Verify RED**: `node --test --test-name-pattern 'discharge' scripts/__tests__/infra-image-scan.test.mjs`
  - **Expected RED**: the floating-keyed entries (otel-lgtm, minio ×2) fail the assertion.

- [ ] T012 [US2] Re-key the suppressions in `security/infra-images/allowlist.yaml`
  - **Prerequisite**: T011 verified RED.
  - Version-key what can be keyed. For any that genuinely cannot, record the reason in the
    `justification` — the otel-lgtm entry already states its own case and may only need re-pointing.
  - **Verify GREEN**: `node --test scripts/__tests__/infra-image-scan.test.mjs`
  - **Expected GREEN**: 0 failures.

- [ ] T013 [US2] Confirm the CVE gate still suppresses for the right reason via `scripts/check-infra-image-findings.mjs`
  - **Prerequisite**: T012.
  - **Spec reference**: FR-007
  - Run a real scan and confirm the re-keyed entries appear under **Allowlisted**, not merely that the
    gate is green. An entry matching nothing is reported as *unmatched* — that is the signal a re-key
    went wrong, and a green gate alone would hide it.
  - **Verify GREEN**: `node scripts/check-infra-image-findings.mjs`
  - **Expected GREEN**: gate passes **and** each re-keyed entry is listed as allowlisted, none unmatched.

---

## Phase 5: User Story 3 — the release-age cooldown can be satisfied (P3)

- [ ] T014 [US3] Record the cooldown observation for the next infra-image update PR in `specs/063-infra-image-version-pins/quickstart.md`
  - **Scenarios covered**: US3-AC1
  - **Type**: Observation — no RED/GREEN cycle, because the behaviour is upstream-timed and cannot be
    forced without falsifying it.
  - On the next update proposal for a formerly-floating image, record whether
    `renovate/stability-days` settles on its own rather than being reset by an unrelated rebuild.
  - **Done when**: the observation is recorded, with the PR number, and item #298 is updated with the
    result — it is the item that decides the merge policy and this is its evidence.

---

## Phase 6: Polish & cross-cutting

- [ ] T015 [P] Document the pins and the declared exceptions in `docs/runbooks/infra-image-scanning.md`
  - **Spec reference**: FR-010
  - Record why minio is pinned to a 2025 release (upstream stopped publishing after 2025-09 — the
    newest tag *is* the one running, so the pin is not neglect), and why its two references remain
    declared floating exceptions rather than the classifier being widened (research R4).
  - **Done when**: a reader meeting a 2025 date or a `[floating tag]` line finds the reason without
    reading this spec.

- [ ] T016 [P] Update item #297 with the outcome and close it using `scripts/backlog.mjs`
  - **Done when**: acceptance criteria are verified against the merged result and the item records the
    declared exceptions.

- [ ] T017 Run the full verification set across `scripts/__tests__/*.test.mjs` and the gate scripts
  - **Verify GREEN**: `node --test scripts/__tests__/*.test.mjs` · `node scripts/check-infra-image-findings.mjs --selftest` · `node scripts/check-toolchain-consistency.mjs`
  - **Expected GREEN**: 0 failed, **0 skipped** — a skip reads as a pass and is the failure mode this
    repository has been bitten by.

---

## Dependencies

```text
T001 (baseline) ─┐
T002 (model)  ───┴─→ T003,T004,T005 [P] ─→ T006 ─→ T007 ─→ T008 ─→ T009 ─→ T010  (US1, shippable)
                                                                          └─→ T011 ─→ T012 ─→ T013  (US2)
                                                                                        └─→ T014  (US3)
                                                                                              └─→ T015,T016 [P] ─→ T017
```

- **T002 blocks everything**: the guard throws on the unmodelled `versioning` key.
- **T001 blocks T010**: without the baseline, SC-002 cannot be measured.
- **US2 depends on US1** only for ordering convenience; the allowlist re-key would work standalone, but
  doing it after the pins means the version keys are written against their final values.

## Parallel opportunities

- T003, T004, T005 — three different assertions, two different files.
- T015, T016 — documentation and backlog, no shared file.
- T008/T009 are deliberately **not** parallel: sequencing them means a digest mismatch names one image
  family rather than eight.

## Implementation strategy

**MVP = Phase 3 (US1).** It removes the defect the item was filed for: updates become classifiable.
Phases 4–6 raise the value but the feature is coherent and shippable after T010.

**The riskiest step is T008/T009** — the only steps that can change what runs. Everything before them
is configuration and tests, so an unexpected CI failure at T008 is attributable to the substitution
itself. T010 is the gate: any digest mismatch stops the feature rather than being explained away.
