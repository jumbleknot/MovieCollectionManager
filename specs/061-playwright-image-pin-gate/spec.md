# Feature Specification: Playwright image-pin consistency gate

**Feature Branch**: `061-playwright-image-pin-gate`

**Created**: 2026-08-17

**Status**: Draft

**Input**: Backlog item #204 (`type/tech-debt`, `priority/p2`) — "Playwright image pin drifts from the lockfile on every Renovate bump — nothing enforces it, and the symptom is a zero-test app-e2e run". The item's **Acceptance criteria** section is authoritative for this feature.

## Context — the measured failure this exists to prevent

On PR #199 (2026-08-15) a routine Renovate lock-file-maintenance PR moved `@playwright/test` **1.60.0 → 1.62.1** in `pnpm-lock.yaml`. The Playwright *container* pin in `.forgejo/workflows/app-ci.yml` stayed at `mcr.microsoft.com/playwright:v1.60.0-noble`. The image tag selects the baked browser build, so the browser never launched:

```
browserType.launch: Executable doesn't exist at
/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
```

**Zero tests ran.** Only the e2e result gate caught it, and only after a full ~35-minute `app-e2e` cycle:

```
[e2e-gate] failed=0 flaky=0 passed=0 did-not-run=0 skipped=0
[e2e-gate] FAIL: no Playwright summary found in the log — the run produced no counts,
          which is not the same as producing good ones
```

It presented as a generic "app-e2e failed" rather than "your image pin drifted from your lockfile"; the diagnosis required reading the container log.

The two halves are coupled in fact and uncoupled in the repository:

| Half | File | Who moves it today |
|---|---|---|
| Resolved test-runner version | `pnpm-lock.yaml` → `@playwright/test@<v>` | Renovate, on its own schedule |
| Baked browser build | `.forgejo/workflows/app-ci.yml` → `mcr.microsoft.com/playwright:v<v>-noble` (×2) | A human, by hand |

`docs/runbooks/devcontainer.md` already **states** the rule — *"Pin the image to the repo's Playwright version … so the browser build matches"* — but a documented rule with nothing enforcing it is exactly the shape that fails silently.

The fix applied on #199 was a manual literal bump. It unblocked that PR and changed nothing about the next one.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A drifted pin fails in seconds, not in 35 minutes (Priority: P1)

A maintainer (or the bot) opens a change in which the resolved Playwright test-runner version and the Playwright container image tag no longer agree. Instead of burning a full end-to-end cycle and surfacing as an unattributable "app-e2e failed", the change is rejected by a fast, cheap check whose message names the drift, both versions, and every file location that must move.

**Why this priority**: This is the whole point of the item and it stands alone. Even with no bot changes at all, this converts a ~35-minute mis-attributed failure into a seconds-long one that diagnoses itself. It is the deliverable that pays back on the very next Playwright bump regardless of how that bump arrives — bot, human, or rebase.

**Independent Test**: Deliberately edit one image tag to a version that differs from the lockfile's resolved `@playwright/test`, run the fast-tier check, and observe a non-zero exit whose message names both versions and the offending file location. Revert, re-run, observe success.

**Acceptance Scenarios**:

1. **Given** the resolved `@playwright/test` version and every Playwright image tag agree, **When** the fast-tier check runs, **Then** it exits successfully and reports the single agreed version.
2. **Given** the resolved `@playwright/test` version is `1.62.1` and an image tag reads `v1.60.0-noble`, **When** the fast-tier check runs, **Then** it exits non-zero and the message names `1.62.1`, `1.60.0`, and the file and line of the offending tag.
3. **Given** there are two image tag occurrences and **only one** has been bumped, **When** the fast-tier check runs, **Then** it exits non-zero — a partial bump is a failure, not a pass.
4. **Given** the check is invoked in its self-proving mode, **When** it runs, **Then** it demonstrates that a deliberately mismatched pair is rejected, and it exits non-zero if that demonstration does not fail as expected.
5. **Given** a change that drifts the pin is pushed, **When** CI runs, **Then** the failure appears in the fast guardrails tier — before, and independently of, the long end-to-end job.

---

### User Story 2 - The bot moves both halves in one pull request (Priority: P2)

Renovate proposes a Playwright update. Both the lockfile half and the workflow image-tag half arrive together in a single pull request, on a single branch, so the two can never land apart and the drift is never introduced in the first place.

**Why this priority**: This is prevention rather than detection, and it is what stops the gate from being a recurring chore. It is P2 rather than P1 because without it the P1 gate still holds the line — the bot's PR simply arrives red and is repaired by hand, which is visible and cheap. Landing it after P1 is safe; landing it *without* P1 would leave nothing enforcing the outcome.

**Independent Test**: Run the bot's configuration validation and a discovery/dry-run pass, and confirm by result that the image tag in the workflow is extracted as a dependency and that it shares a group with the `@playwright/test` package update.

**Acceptance Scenarios**:

1. **Given** the bot configuration, **When** the configuration validator runs, **Then** it reports the configuration valid.
2. **Given** the bot's dependency extraction runs over the repository, **When** the workflow file is processed, **Then** the Playwright image tag is discovered as an extractable dependency with the version currently pinned.
3. **Given** a Playwright update is proposed, **When** the resulting branches are computed, **Then** the workflow-tag half and the `@playwright/test` half resolve to the **same group**, not to two separate branches.
4. **Given** the existing rules that group generic JS patch/minor and JS major updates, **When** the new grouping is applied, **Then** it takes precedence over them so the two halves are not pulled apart — matching the mechanism already proven for the `nx` pair.

---

### User Story 3 - The operator docs name the gate, not just the rule (Priority: P3)

An operator reading the runbooks learns both that the pin must match the repository's Playwright version **and** which automated check now enforces that, so the rule is traceable to its enforcement rather than resting on a reader's diligence.

**Why this priority**: Documentation accuracy, valuable but not load-bearing — the gate works whether or not the runbooks mention it. It is included because a runbook that states a rule while omitting its now-existing enforcement is quietly out of date, which is the same failure mode in a different medium.

**Independent Test**: Read the two runbooks and confirm each names the enforcing check alongside the rule it already states.

**Acceptance Scenarios**:

1. **Given** the devcontainer runbook, **When** an operator reads the Playwright pin rule, **Then** the enforcing check is named there.
2. **Given** the E2E testing runbook, **When** an operator reads the Playwright pin rule, **Then** the enforcing check is named there.

---

### Edge Cases

- **Only one of the two occurrences bumped** — must FAIL (covered explicitly by criterion 2 of the item). Checking only the first occurrence would pass a half-bump.
- **A third occurrence added later** — the check must derive its locations by scanning, so a newly added occurrence is covered automatically rather than needing the check to be edited. A hardcoded count of two would silently ignore a third.
- **The image tag disappears entirely** (renamed, refactored, or the variant suffix changes from `-noble` to something else) — the check must fail loudly rather than vacuously pass on having found nothing to compare. A gate that passes when it finds zero occurrences is a gate that has stopped working without saying so.
- **`@playwright/test` cannot be resolved** from the lockfile (key renamed, file moved, multiple conflicting resolutions) — the check must fail with a message that names what it could not resolve, rather than comparing against `undefined`.
- **The lockfile resolves more than one `@playwright/test` version** — the check must treat that as a failure to be reported, not silently pick one.
- **A vulnerable-version (security) bump** — Renovate reroutes these onto an ungrouped security branch, so the grouping in User Story 2 does not apply. The P1 gate is what covers this path, which is a further reason the gate is P1 and the grouping is P2.
- **The check's own demonstration stops demonstrating** — if the self-proving mode's deliberately-broken input somehow passes, the check must exit non-zero. A gate that cannot fail is not a gate.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The repository MUST carry an automated consistency check that fails when the `@playwright/test` version resolved in `pnpm-lock.yaml` disagrees with the Playwright container image tag in `.forgejo/workflows/app-ci.yml`.
- **FR-002**: The check MUST run in the fast guardrails tier — seconds, gating a pull request before and independently of the ~35-minute `app-e2e` job. It MUST NOT depend on the end-to-end job having run.
- **FR-003**: The check MUST examine **every** occurrence of the image tag in `.forgejo/workflows/app-ci.yml` (currently 2), discovering them by scan rather than by a hardcoded count, and MUST fail if any single occurrence disagrees.
- **FR-004**: The check MUST fail if it finds **zero** image-tag occurrences, or if it cannot resolve exactly one `@playwright/test` version from the lockfile — a vacuous pass is prohibited.
- **FR-005**: A failure message MUST name the resolved lockfile version, the disagreeing tag version, and the file and line of each disagreeing occurrence, so the diagnosis needs no log archaeology.
- **FR-006**: The check MUST provide a self-proving mode (`--selftest` or equivalent) that constructs a deliberately mismatched pair, asserts the check REJECTS it, and exits non-zero if that rejection does not occur.
- **FR-007**: CI MUST invoke both the self-proving mode and the real check, mirroring how the existing toolchain-consistency gate is invoked in `guardrails.yml` (once with `--selftest`, then once for real).
- **FR-008**: The dependency bot's configuration MUST extract the Playwright image tag in `.forgejo/workflows/app-ci.yml` as an updatable dependency, sourced from the same version stream as the `@playwright/test` package.
- **FR-009**: The bot MUST place the extracted image-tag update and the `@playwright/test` package update in the **same group**, so a Playwright bump can only ever arrive as one pull request containing both halves.
- **FR-010**: The new grouping MUST take precedence over the pre-existing generic JS grouping rules that would otherwise split the two halves onto separate branches, and MUST cover the major track as well as patch/minor.
- **FR-011**: The bot configuration change MUST be verified **by result** — a configuration-validator pass plus a discovery/dry-run showing the tag is extracted and grouped — not by reading the configuration and asserting it looks right.
- **FR-012**: Any existing guard that asserts the ordering or presence of bot configuration rules MUST be extended to cover the new rule, so a later reorder that would re-split the halves fails by name.
- **FR-013**: `docs/runbooks/devcontainer.md` and `docs/runbooks/e2e-testing.md` MUST name the enforcing check alongside the pin rule they already state.
- **FR-014**: The literal image string in `.forgejo/workflows/app-ci.yml` MUST be preserved as a literal, because `scripts/__tests__/app-e2e-env.guard.test.mjs` locates the Playwright `docker run` by that literal string.

### Key Entities

- **Resolved test-runner version**: the single `@playwright/test` version that `pnpm-lock.yaml` resolves to. The source of truth for what the runner expects.
- **Image tag occurrence**: one appearance of `mcr.microsoft.com/playwright:v<version>-noble` in `.forgejo/workflows/app-ci.yml`, carrying a file path, a line number, and a version. There are currently two; the count is not fixed.
- **Drift**: any state in which the resolved test-runner version and at least one image tag occurrence name different versions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A drifted Playwright pin is rejected in **under 30 seconds** of check runtime, versus the ~35 minutes the same drift previously took to surface.
- **SC-002**: Diagnosing a drift failure requires **reading only the failure message** — zero container logs, zero external files — because the message names both versions and every offending location.
- **SC-003**: A **partial** bump (one of two occurrences moved) is rejected with the same certainty as an untouched one; there is no combination of occurrences that produces a false pass.
- **SC-004**: The check is demonstrated to be capable of failing, by a self-proving mode that runs in CI on every pull request — so "it passed" cannot mean "it did nothing".
- **SC-005**: A Playwright version bump proposed by the dependency bot arrives as **exactly one** pull request containing both halves; the count of pull requests in which only one half moves is **zero**.
- **SC-006**: The bot behaviour is confirmed by an executed validation/discovery run, not by inspection of configuration text.
- **SC-007**: On the current repository state the new check **passes**, and it passes for the right reason — the lockfile resolves `1.62.1` and both occurrences read `v1.62.1-noble`.
- **SC-008**: Both named runbooks state the rule **and** name its enforcement; neither states the rule alone.

## Out of Scope

- **Rewriting `specs/**` references to the old image tag.** Those are point-in-time records of what was measured during past features; editing them would falsify the record rather than update it. The check must therefore confine its scan to the workflow file and not treat historical spec text as a pin.
- **Widening the check to other image pins or other tools.** This feature closes the Playwright pair. Other pins are a separate question.
- **Auto-merging** any Playwright update. Nothing in this repository auto-merges; that stands unchanged.

## Alternative Considered and Rejected

**Deriving the tag in the workflow from `pnpm exec playwright --version` instead of pinning a literal.** Self-consistent by construction, and it would make drift structurally impossible rather than merely detected.

Rejected for now, on two measured grounds: it breaks `scripts/__tests__/app-e2e-env.guard.test.mjs`, which locates the Playwright `docker run` by the **literal** image string — so that guard would have to be updated at the cause, not deleted (see FR-014) — and it removes the pin's reviewability, since a reader of the workflow could no longer see which browser build will run. It is a materially larger change to a critical workflow than FR-001…FR-012 require.

Worth revisiting if the gate proves noisy in practice.

## Assumptions

- **The lockfile is the authority for the runner version**, not `package.json`, whose `^1.36.0` range does not identify the version that actually installs. This mirrors the measured failure, where the range never changed and the resolution did.
- **Extending `scripts/check-toolchain-consistency.mjs` is the expected home.** It exists for precisely this class of bug — its own header records that it was written after the pnpm 10.33 → 11.x bump broke CI twice, "because this class of bug is invisible to review" — and it already runs in `guardrails.yml` with the `--selftest`-then-real invocation pattern this feature requires. A separate script is acceptable **only** if wired into the same guardrails step; the item states this explicitly.
- **The `nx` pair is the working precedent for the bot half.** `renovate.json` already couples `package.json`'s `nx` devDependency with `nx.json`'s `installation.version` via a `customManagers` regex entry plus a `packageRules` entry matching **both** managers and ordered **after** the generic JS rules so it wins. Its own description records that extraction alone is not grouping — measured on PR #141 and PR #193, which each moved one half and left the other. The Playwright pair has the same shape and the same trap.
- **The generic JS grouping rules are the thing that will split the halves.** `js patch/minor` and `js majors` match `matchManagers: ["npm"]`, and later rules override earlier ones — so a Playwright grouping rule must be ordered after them, exactly as the `nx monorepo` rule is.
- **The `docker base images` group is not the right home** for the extracted tag, because that rule matches `matchDatasources: ["docker"]` and would group Playwright with unrelated base images rather than with its own npm half.
- **The gate starts green.** Measured on `main` @ `68a40784`: `pnpm-lock.yaml` resolves `@playwright/test@1.62.1` and both occurrences read `v1.62.1-noble`. This feature therefore adds enforcement without needing to also repair a live drift.
- **Bot verification runs locally**, against the repository configuration, without opening a live pull request. Known traps to respect: the validator with no arguments reads the repository config; `matchPackageNames` keys on `packageName` (absent ⇒ no match); and a vulnerable-version bump reroutes to an ungrouped security branch, so grouping cannot be verified on the security path.
- **No spec-gate exemption is being claimed.** The touched paths (`scripts/`, `.forgejo/workflows/`, `renovate.json`, `docs/runbooks/`) fall outside the CLAUDE.md SDD gate's enumerated implementation directories, but the lifecycle is being followed at the operator's explicit request.
