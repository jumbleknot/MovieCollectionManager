# Tasks: Python toolchain grouping

**Feature**: 067-python-toolchain-grouping · **Branch**: `067-python-toolchain-grouping`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md)
**Contract**: [contracts/rule-resolution.md](./contracts/rule-resolution.md) · **Invariants**: [data-model.md](./data-model.md)

TDD is NON-NEGOTIABLE per the constitution: every test task carries the acceptance scenarios it
covers and a **Verify RED** command with its expected failure; every paired implementation task
carries a **Verify GREEN**. A Verify RED showing 0 failures means the test is trivially passing and
must be fixed before implementation begins.

> ⚠️ **Two RED traps specific to this feature. Read before starting.**
>
> 1. **`node --test <file> --test-name-pattern 'x'` silently runs EVERYTHING** — everything after the
>    script path becomes the script's own `argv`. Node's flags go **BEFORE** the path. Every command
>    below is written in the correct order; do not "tidy" them.
> 2. **Several assertions here are trivially green when written.** This feature asserts invariants
>    that *already hold* (the pin and tags agree today; the floor is already excluded). Those tasks
>    are marked **INDUCED RED** and carry the exact edit to make first, the failure to expect, and the
>    revert. Skipping the inducement produces a test that was never RED, which the convention forbids
>    and which would leave the invariant unguarded. Tasks marked **NATURAL RED** fail on their own.

---

## Phase 1: Setup

- [ ] T001 Provision renovate 44 and capture the pre-change lookup baseline into `/tmp/.../baseline-lookup.log` (scratchpad, not the repo)
  - **Spec reference**: enabling work for SC-006; contract C4, C5
  - Install `renovate@44` into a scratch directory, then from the repo root run
    `RENOVATE_PLATFORM=local RENOVATE_DRY_RUN=lookup LOG_LEVEL=debug node <scratch>/node_modules/renovate/dist/renovate.js`.
    Record the branch tally:
    `grep -o '"branchName": "renovate/[a-z0-9.-]*"' <log> | sort | uniq -c | sort -rn`.
  - This is the evidence SC-006 is measured against. Without a baseline, "the digest refresh is still
    separated" is unfalsifiable after the edit.
  - **Done when**: the tally is recorded and shows `renovate/docker-digest-pins` carrying the eight
    python digest updates, and **no** `renovate/python-toolchain` branch.

- [ ] T002 [P] Re-resolve the current `python:3.14-slim` manifest digest
  - **Spec reference**: FR-011; research R7
  - Query the registry for the multi-arch index digest of `library/python:3.14-slim`. **Do not copy
    the digest from `research.md`** — `3.14-slim` is a moving tag and will have been rebuilt since
    2026-09-07.
  - Cross-check the instrument: the same query for `3.13-slim` must return the digest Renovate
    proposes as the pending refresh in T001's log. If those two disagree, the query is wrong and the
    3.14 digest cannot be trusted either.
  - **Done when**: one digest is recorded, and the 3.13 cross-check agrees with T001's log.

- [ ] T003 [P] Record the baseline guard-test count
  - **Spec reference**: enabling work
  - `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` and record `pass`/`fail`/`skip`.
  - **Done when**: counts recorded. A suite that later passes with the *same* count has not gained
    the assertions this feature exists for — and per the repository's own rule, watch the **skip**
    count, because a skipped test reads as a pass.

---

## Phase 2: Foundational (blocking prerequisites)

**⚠️ Blocks every test task in Phases 3-6.**

- [ ] T004 Parameterise the python dependency helper by manager in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Spec reference**: enabling work for FR-001, FR-004; contract C1
  - The existing `pythonImage(updateType, packageFile)` helper hard-codes `manager: 'dockerfile'`.
    Every assertion in this feature must run for `pyenv` too, and one for `docker-compose`. Add a
    manager parameter (or a sibling helper) without changing what the existing calls resolve to.
  - `ruleMatches()` **throws** on any rule key it does not model — deliberately. The new rule uses
    only `matchDatasources`, `matchPackageNames`, `groupName` and `automerge`, all already modelled,
    so no extension of `ruleMatches` is needed. If it throws anyway, a rule key was added that this
    plan did not anticipate: fix the model, do not loosen it.
  - **Done when**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` still passes with
    T003's counts unchanged. This task is a pure refactor and must change no outcome.

**Checkpoint**: the guard test can model any (manager, datasource, depName, updateType) tuple in contract C1.

---

## Phase 3: User Story 1 — An interpreter change arrives as its own reviewable change (P1) 🎯 MVP

**Goal**: A version change to the interpreter lands on its own branch, never inside the base-image sweep.

**Independent Test**: Resolve the rules for the pin and for an image reference on every version track
and confirm both give `python toolchain`, while an unrelated image still gives `docker base images`.

### Tests for User Story 1

- [ ] T005 [P] [US1] Assert the pin and the image references share one group, on every version track, and update the existing group test AT THE CAUSE, in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Scenarios covered**: US1-AC1; FR-001, FR-002, **FR-014**; INV-4; SC-002; contract C1 (rows 1-6)
  - Assert `resolvedGroupName` is `python toolchain` for **both** `pyenv` and `dockerfile`, for
    `patch`, `minor` and `major`. Assert both managers, not one — the whole point is that they move
    together, and asserting one proves nothing about the other.
  - **THIS TASK OWNS THE UPDATE AT THE CAUSE (FR-014), and it must happen HERE, not later.** The
    existing test *"python still rides the `docker base images` group, so its digest refresh is not
    stranded"* (`renovate-workflow.guard.test.mjs`, ~line 1174) opens with
    `assert.equal(resolvedGroupName(pythonImage('minor')), 'docker base images')`. That assertion
    breaks the instant T008 adds the rule. **Rewrite its version half to `python toolchain` as part of
    this task; leave its digest half (`docker digest pins`) exactly as it is** — T017 hardens that
    half and adds `pinDigest`.
  - **Do NOT delete the test.** It asserted a premise this feature deliberately reverses, which is
    precisely the case CLAUDE.md covers: such a guard gets updated at the cause, never removed. If it
    is deleted, the digest-stranding protection it carries goes with it and nothing replaces it until
    T017 — a window in which #350 could recur unnoticed.
  - **Verify RED**: `node --test --test-name-pattern 'python toolchain' scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **NATURAL RED**: no rule sets that group, so both managers resolve to `docker base images`. Expect
    6 assertion failures naming `docker base images` as the actual value, **plus** the rewritten half
    of the existing test failing for the same reason — that failure is the proof the rewrite is wired
    to the real config rather than to a stale expectation.

- [ ] T006 [P] [US1] Assert an unrelated image is untouched, and that a future compose reference joins the group, in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Scenarios covered**: US1-AC2; FR-009; contract C1 (row 9), C3
  - Two assertions, opposite directions. **Control**: `node`, `postgres`, `redis`,
    `ghcr.io/astral-sh/uv` and `hashicorp/vault` must NOT resolve to `python toolchain` — this is what
    catches a rule that widened past its own dependency. **Coverage**: a `docker-compose` dep named
    `python` on the docker datasource MUST resolve to `python toolchain`.
  - The compose row has no site in the repository today (`grep` over `infrastructure-as-code/` finds
    no python image). It is asserted precisely because no lookup can exercise it: it encodes the
    spec's "a future image in any file" edge case, and it is the reason the rule carries no
    `matchManagers` (research R4).
  - **Verify RED**: `node --test --test-name-pattern 'python toolchain' scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **NATURAL RED**: the compose assertion fails (`docker base images`). The controls pass already —
    that is correct and expected; a control's job is to keep passing.

- [ ] T007 [US1] Assert the language-version floor acquires neither the group nor the ceiling, in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Scenarios covered**: US1-AC3; FR-007; contract C2
  - Assert a dep `{manager: 'pep621', datasource: 'python-version', depName: 'python'}` resolves to
    `allowedVersions` `null` and to a group that is **not** `python toolchain`.
  - **This task asserts TWO exclusions and therefore needs TWO induced REDs.** They cannot both run
    now: the group rule does not exist until T008, so the group half is unfalsifiable at this point.
    Write both assertions here — the test must precede the implementation — and run the second
    inducement the moment T008 lands. T008's Done-when will not be satisfied until you have.
  - **Verify RED (a) — the ceiling half, now.** **INDUCED.** Temporarily delete
    `"matchDatasources": ["docker"]` from the python ceiling rule in `renovate.json`, run
    `node --test --test-name-pattern 'floor' scripts/__tests__/renovate-workflow.guard.test.mjs`,
    confirm the ceiling assertion **fails** with the floor picking up `<3.14`, then **revert
    `renovate.json`** and confirm with `git diff renovate.json` before continuing.
  - **Verify RED (b) — the group half, immediately after T008.** **INDUCED.** Temporarily delete
    `"matchDatasources": ["docker"]` from the **new `python toolchain` rule**, re-run the same
    command, confirm the group assertion **fails** with the floor picking up `python toolchain`, then
    revert and confirm clean.
  - **Expected RED**: 1 failure from each inducement. **If either produces 0 failures that assertion
    is not wired to the real config and must be fixed before proceeding** — an exclusion that holds
    by coincidence rather than by assertion is exactly what this task exists to prevent, and the
    group half is the one that would otherwise never have been seen to fail at all.

### Implementation for User Story 1

- [ ] T008 [US1] Add the `python toolchain` rule to `renovate.json`, after `uv pin` and before `docker digest pins`
  - **Scenarios covered**: US1-AC1, US1-AC2; FR-001, FR-002, FR-008
  - `{"matchDatasources": ["docker"], "matchPackageNames": ["python"], "groupName": "python toolchain", "automerge": false}`.
    **No `matchManagers`** — deliberately the same match set as the ceiling rule, so the group and the
    ceiling can never drift into matching different sites (research R4).
  - The `description` MUST record: (a) that the position is load-bearing, with research R3's measured
    numbers — after `docker digest pins` the eight digest refreshes migrate off
    `renovate/docker-digest-pins` (tally 37→29) onto `renovate/python-toolchain` (9→17), recreating
    items #308/#350; (b) that the neighbouring `rust toolchain` / `uv pin` rules say "ordered last"
    meaning last *among the grouping rules*, not last in the file — a later reader will otherwise
    move this one to match them; (c) why the floor is excluded (FR-008), in the form
    `renovate.json` already uses for `rust:alpine3.21`.
  - **Verify GREEN**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Then run T007's deferred inducement (b) before calling this task done** — the floor's
    group-exclusion assertion has not yet been seen to fail, and until it has it is a trivially
    passing test guarding nothing.
  - **Regression**: the suite's `pass` count must exceed T003's baseline, with `fail` 0 and `skip`
    unchanged. The rewritten half of the pre-existing group test (T005) must be **green** here — if
    it is still red, T005's rewrite was not applied and this task is not done.

- [ ] T009 [US1] Validate the config and confirm the resolution against the real bot
  - **Scenarios covered**: SC-001; contract C4, C5
  - `npx --yes --package renovate@44 -- renovate-config-validator --strict --no-global renovate.json`.
    **Both flags are load-bearing** — without `--no-global` the file is validated as a global
    self-hosted config, and without `--strict` a needed migration exits 0 (runbook §9).
  - Then re-run T001's lookup. With the ceiling still at `<3.14` nothing python is proposed, so to see
    the group work, raise the ceiling to `<3.16` **temporarily**, re-run, and confirm the eight
    `minor` updates land on `renovate/python-toolchain` while the eight `digest` updates stay on
    `renovate/docker-digest-pins`. **Restore `renovate.json` from a backup and confirm with
    `git status --porcelain renovate.json`** — this probe edits a file that gates every PR.
  - **Done when**: validator exits 0; the branch split is observed; `renovate.json` is confirmed clean.

**Checkpoint**: an interpreter version change now has its own branch. The version has not moved yet.

---

## Phase 4: User Story 2 — The four services run the interpreter that was chosen (P1)

**Goal**: pin, eight image references and ceiling all name 3.14, and all four images build on it.

**Independent Test**: read the three, confirm they agree; build all four images and confirm each
installs from its existing lockfile.

> **Task order here is deliberate.** T010 moves the pin *alone*, which drives the existing ceiling
> assertion RED — a natural RED for INV-2 that needs no inducement. Do not collapse T010 and T011.

- [ ] T010 [US2] Raise the pin in `agents/movie-assistant/.python-version` from `3.13` to `3.14`
  - **Scenarios covered**: US2-AC1; FR-010; INV-2
  - **Verify RED**: `node --test --test-name-pattern 'pinned minor' scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **NATURAL RED**: the existing ceiling assertion derives `<3.15` from the pin and finds `<3.14`.
    Expect failures on all three update tracks. This is the intermediate red state
    [data-model.md](./data-model.md) describes; there is no edit order that avoids it, which is what
    stops a half-move merging.

- [ ] T011 [US2] Raise `allowedVersions` from `<3.14` to `<3.15` in `renovate.json` and rewrite its description
  - **Scenarios covered**: US2-AC1; FR-004; contract C1
  - The current description forward-references this feature as future work ("raise this under a spec
    that also re-locks … makes the three sites one dependency"). Rewrite it to describe the grouping
    that now exists, over **four** site kinds, and keep the standing instruction that the ceiling
    moves only together with the pin.
  - **Verify GREEN**: `node --test --test-name-pattern 'pinned minor' scripts/__tests__/renovate-workflow.guard.test.mjs`

- [ ] T012 [P] [US2] Retag all eight `FROM python:` lines to `3.14-slim@<T002 digest>`
  - **Scenarios covered**: US2-AC1; FR-010, FR-011; INV-1, INV-3
  - `agents/movie-assistant/Dockerfile` (build + runtime), `mcp-servers/movie-mcp/Dockerfile`,
    `mcp-servers/spreadsheet-mcp/Dockerfile`, `mcp-servers/web-api-mcp/Dockerfile` (build + runtime
    each). **One identical digest across all eight** — verify with
    `grep -h 'FROM python:' <the four Dockerfiles> | sort -u | wc -l`, which must print `1`.
  - Change nothing else in these files. `agents/movie-assistant/Dockerfile`'s `build-essential` stanza
    stays: `annoy` still has no matching wheel and still compiles from source.
  - **Done when**: the `sort -u` count is 1, and
    `git diff --stat -- agents/movie-assistant/Dockerfile 'mcp-servers/*/Dockerfile'` shows exactly 8
    changed lines. **Scope the pathspec** — by this point T010 and T011 have also changed
    `.python-version` and `renovate.json`, so a bare `git diff --stat` will not show 8 and reads as a
    failure.

- [ ] T013 [US2] Build all four images on 3.14 and confirm each installs from its existing lockfile
  - **Scenarios covered**: US2-AC2, US2-AC3; FR-012; INV-8; SC-005
  - `pnpm nx up-agents-prod` builds all four (`scripts/agent-stack.mjs` lines 54-57).
    `uv sync --frozen --no-dev` is the assertion: uv defines `--frozen` as *do not update the
    lockfile; error if it is out of date*, so a build that passes under it proves the lock resolves.
  - **Do NOT verify this with `docker build -q`.** It suppresses output, leaving exit 0 as the only
    evidence, which cannot distinguish "uv resolved N packages" from "a cached layer replayed". Use
    `--progress=plain`, and `--no-cache` if layers are warm.
  - **Bind mounts do not work in this dev container** — a `-v` source resolves on the sandbox VM and a
    missing one is created empty (item #382). Build from a context directory.
  - **Done when**: all four build, **and** each build's output shows uv reporting a package count
    (e.g. `Installed 44 packages`). A build with no such line has not proved anything.

- [ ] T014 [US2] Confirm no lockfile moved
  - **Scenarios covered**: FR-012; SC-005
  - **Done when**: `git status --porcelain '**/uv.lock'` is empty, and the four `requires-python`
    values are still `>=3.13` (FR-007 — the floor is not part of this move).

**Checkpoint**: pin, tags and ceiling all say 3.14; all four services build; no lockfile touched.

---

## Phase 5: User Story 3 — The pin and the running images cannot silently disagree (P2)

**Goal**: a hand edit that leaves the pin and the images on different minors fails the gate.

**Independent Test**: change one image tag, run the guards, see them fail and name the file.

- [ ] T015 [US3] Assert every `FROM python:` tag equals `.python-version`, by reading both off disk, in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Scenarios covered**: US3-AC1, US3-AC2; FR-006, **FR-011**; INV-1, **INV-3**; SC-003, SC-004
  - Rule resolution cannot provide this — a configured ceiling constrains what the *bot* proposes and
    is silent about a hand edit. Read the four Dockerfiles, extract every `FROM python:X.Y-slim` tag,
    and assert each equals the pin. Model it on the existing *"the devcontainer bakes the SAME Rust
    the workflows resolve"* test. The failure message MUST name the disagreeing file(s), or SC-004 is
    not met.
  - Assert the count too: exactly 8 references found. A regex that silently matches 0 would pass.
  - **Assert digest equality in the same pass (FR-011 / INV-3).** All eight references must carry one
    identical `@sha256:` digest. T012 checks this once by hand at edit time, which guards nothing
    afterwards: a later hand edit could give the eight references different digests and no gate would
    notice. The parse here already has all eight lines, so comparing the digest costs one extra
    assertion and converts INV-3 from "review" into an enforced invariant.
  - **Verify RED**: **INDUCED.** By this phase the move has landed and the invariant holds.
    Temporarily change one `FROM python:3.14-slim` to `3.13-slim`, run
    `node --test --test-name-pattern 'agrees with the pin' scripts/__tests__/renovate-workflow.guard.test.mjs`,
    confirm it fails **and names that file**, then revert and confirm with `git diff`.
  - **Expected RED**: 1 failure naming the edited Dockerfile. 0 failures means the assertion is not
    reading the real files.
  - **Verify RED, digest half**: **INDUCED**, separately — change one reference's `@sha256:` to a
    different valid-looking digest (leaving the tag alone) and confirm a *distinct* failure. Doing
    both inducements at once cannot distinguish an assertion that checks tags from one that checks
    both.

- [ ] T016 [US3] Extend the ceiling assertion to the `pyenv` manager in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Scenarios covered**: US3-AC3; FR-004, FR-005; INV-2; contract C1 (rows 1-3)
  - The existing assertion models `dockerfile` only. Run the same derivation for `pyenv`, so the
    ceiling is proved to reach the pin's own site and not merely the images.
  - **Verify RED**: **INDUCED.** Temporarily add `"matchManagers": ["dockerfile"]` to the ceiling
    rule, run `node --test --test-name-pattern 'pinned minor' scripts/__tests__/renovate-workflow.guard.test.mjs`,
    confirm the `pyenv` assertions fail with `null`, then revert `renovate.json` and confirm clean.
  - **Expected RED**: 3 failures (patch, minor, major) for `pyenv` only.

**Checkpoint**: pin, tags and ceiling are now mutually enforcing in both directions.

---

## Phase 6: User Story 4 — The security-patch stream keeps flowing (P3)

**Goal**: the weekly digest refresh of the running image is never absorbed into the interpreter group.

**Independent Test**: resolve the digest track for a python image reference and confirm it gives
`docker digest pins`.

- [ ] T017 [US4] Assert the `digest` and `pinDigest` tracks still resolve to `docker digest pins`, in `scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Scenarios covered**: US4-AC1, US4-AC2; FR-003; INV-5; contract C1 (rows 7-8), C4
  - **T005 already rewrote that test's version half** (FR-014). This task hardens what remains: keep
    its `digest` assertion, add the `pinDigest` track beside it, and — the part that did not exist
    before — make both **sensitive to the rule's position**, which is what the induced RED below
    proves. Without that inducement this is a test that has never failed and guards nothing.
  - **Verify RED**: **INDUCED.** Temporarily move the `python toolchain` rule to sit *after* the
    `docker digest pins` rule, run
    `node --test --test-name-pattern 'digest' scripts/__tests__/renovate-workflow.guard.test.mjs`,
    confirm it fails with `python toolchain`, then move it back and confirm `renovate.json` is clean.
  - **Expected RED**: 2 failures (`digest`, `pinDigest`). **This is the single most important RED in
    the feature** — it is the only check that catches the rule being reordered, and reordering is
    invisible to the validator, to CI, and to a reading of the diff.

- [ ] T018 [US4] Confirm against the real bot that the digest updates are still separated
  - **Scenarios covered**: SC-006; contract C4, C5
  - Re-run the lookup and compare the branch tally with T001's baseline: `renovate/docker-digest-pins`
    must still carry the eight python digest updates.
  - **Done when**: the tally matches the baseline for that branch, and the count of proposals
    discarded by collision has not risen.

**Checkpoint**: all four stories independently verified.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T019 Rewrite the python row of the pinned-toolchains table in `docs/runbooks/renovate.md` §8
  - **Scenarios covered**: FR-013; SC-007
  - The row currently reads `grouped? **no — item #366**` and "three unrelated dependencies today".
    It becomes **yes — `python toolchain`**, with the site count corrected to 1 pin + 8 image refs +
    4 floors + 4 lockfiles.
  - It MUST answer the re-lock question in one place: **no re-lock is required** while the floor stays
    a floor, because a uv lock is universal across its `requires-python` range and that range already
    admits the new minor; and the check that fails if the interpreter and the locks ever disagree is
    **`uv sync --frozen --no-dev` inside the four image builds** driven by `pnpm nx up-agents-prod`
    in `app-ci`. Name that existing check — do not introduce a gate.
  - Extend §8's "grouping is needed when a SECOND manager sees the other half" note with python's
    reason, which is a **new one**: not a second manager claiming a half (both halves already share a
    datasource), but a *routine group* claiming the whole dependency. Record the R3 ordering
    constraint here too, so it is findable without reading `renovate.json`.
  - Do **not** hand-edit `openwiki/`; it regenerates from this runbook.
  - **Done when**: the row states the group, the four site kinds, the re-lock answer and the named
    check; §8's note carries python's reason and the ordering constraint.

- [ ] T020 Run the test tiers this diff touches
  - **Scenarios covered**: final validation
  - Derive from the diff, not from memory: `renovate.json` and `scripts/__tests__/` →
    `node --test scripts/__tests__/*.test.mjs` (`guardrails / naming`) and the config validator
    (`guardrails / renovate-config`); the four Dockerfiles and `.python-version` → the image builds
    and agent tiers in `app-ci`; `docs/` → no test tier.
  - **Done when**: all pass, with the **skip** count checked, not just the absence of red.

- [ ] T021 Walk [quickstart.md](./quickstart.md) end to end
  - **Scenarios covered**: SC-001 … SC-007
  - Confirm the "What done looks like" table matches reality on all six rows.
  - **Done when**: every row matches, and `git status --porcelain` shows no stray probe edits —
    several steps in this feature temporarily modify `renovate.json`.

- [ ] T022 Close backlog item #366 against its own acceptance criteria
  - Verify each of the item's four criteria, then close. Note in the closing comment that criterion 1
    turned out to be **already satisfied by accident** (both halves share a datasource, so they were
    never going to drift) and that the real defect was the *destination* branch — plus that the item
    named three sites where there are four, the fourth being the language-version floor.
  - Do not close before T020 and T021 pass: closure is an explicit act after verification, not a
    consequence of a merge.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies. T002 and T003 are parallel with each other and with T001.
- **Phase 2 (Foundational)**: needs Phase 1. **Blocks every test task in Phases 3-6.**
- **Phase 3 (US1)**: needs Phase 2. Independently shippable — it changes no version.
- **Phase 4 (US2)**: needs Phase 2. Independent of US1 in principle (the move is made by hand, not by
  the bot), but T011's rewritten description refers to the group, so land US1 first.
- **Phase 5 (US3)**: needs Phase 4 — its assertions compare the pin to the tags, so the move must
  have happened for the induced REDs to be meaningful.
- **Phase 6 (US4)**: needs Phase 3 (the rule must exist to be mis-ordered).
- **Phase 7**: needs all of the above.

### Within each story

- Tests before implementation, always. RED before GREEN, and an induced RED where the invariant
  already holds.
- Within Phase 4 specifically: **T010 before T011**, so INV-2's RED is natural rather than induced.

### Parallel opportunities

- T002 ∥ T003 (different instruments, no shared state).
- T005 ∥ T006 — different test names in the same file; if one agent owns the file, do them in
  sequence rather than risk a conflicting edit.
- T012's eight edits span four files and can be made together.
- Nothing else parallelises usefully: this feature is one config file, one test file and four
  Dockerfiles, and most tasks contend on `renovate.json`.

---

## Implementation Strategy

### MVP (User Story 1 only)

Phases 1-3 alone are a coherent, shippable change: the interpreter gains its own branch while staying
on 3.13. If the 3.14 move had to be deferred, this is the increment that still delivers the item's
main value — the next minor arrives reviewably regardless of when it arrives.

### Full delivery

Phases 1-3 → 4 → 5 → 6 → 7, in order. The whole feature is one pull request: splitting it would put
the ceiling raise and the pin raise in different PRs, and every guard here exists to make exactly that
state fail.

---

## Notes

- **Several steps temporarily edit `renovate.json`** (T007, T009, T016, T017). Every one carries a
  revert instruction; confirm with `git status --porcelain renovate.json` before moving on. This file
  gates every pull request in the repository.
- **An induced RED is not optional.** Four assertions here are trivially green when written. A test
  that was never RED is not a TDD test, and — worse for this feature — an invariant that holds by
  coincidence is one edit away from not holding.
- Commit after each task or logical group.
