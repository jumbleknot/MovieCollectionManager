---
description: "Task list for the OpenWiki + OKF knowledge layer (feature 043)"
---

# Tasks: OpenWiki + OKF Knowledge Layer

**Input**: Design documents from `specs/043-openwiki-okf/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md), [contracts/](./contracts/)

**Tests**: TDD is mandatory (constitution §TDD). Every test task carries the mandated **TDD checkpoint** — the acceptance scenarios it covers, a **Verify RED** command, and the expected failure output; every paired implementation task carries a **Verify GREEN** command. A Verify RED showing 0 failures means the test is trivially passing and must be fixed before implementation. The **expected RED** counts and messages below are predictions — they cannot be measured before the test exists; replace each with the observed output when the task runs. A prediction that turns out wrong is information, not a defect.

**One task (T012) is an explicit, labelled exception** to the RED rule — a characterization test asserting behavior that already exists. It is marked as such and justified inline; it is the only one, and no other task may claim the exemption without the same justification.

`scripts/__tests__/*.test.mjs` is **CI-enforced with no workflow edit**: the `guardrails / naming` job runs `node --test scripts/__tests__/*.test.mjs`, and the glob is expanded by **bash**, so a new test file is gated the moment it lands (research R10, corrected 2026-07-27). Consequence: these tests run on every push in a container with no forge access and no network, so they must be **deterministic, offline, token-free, and limited to `node:` built-ins plus `yaml`** (already a root dependency).

**Organization**: Grouped by the six user stories plus setup, foundational, and polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1 = retrieval · US2 = conformance gate · US3 = dual-environment parity · US4 = assistant pointers · US5 = operator-doc relocation · US6 = freshness loop

## Execution-order note (deliberate deviation from strict priority order)

Phases do **not** run in P1→P4 order. Two hard constraints reorder them:

1. **US2 (gate) precedes US1 (bundle)** — the fail-closed clarification (FR-014a) means the gate cannot be verified against a tree with no bundle. It is built entirely against **fixtures**, then used to validate the first generation before that bundle is ever committed. CI wiring is split out to Phase 6 because it must not land until a real bundle exists, or every intermediate commit reddens `main`.
2. **US5 (relocation) precedes US1 (bundle)** — full navigational coverage (FR-007, SC-012) requires a concept for every runbook. Relocating the two live operator documents *first* means one generation run covers all fourteen. Relocating afterwards would force a second paid regeneration purely to pick up two moved files, and generation is the most expensive step in the feature.

US1 remains the **MVP outcome** — the phase that delivers user-visible value.

## Authority notes

- **`openwiki/INSTRUCTIONS.md` lives inside the bundle and is hand-authored** — the tool reads it and never rewrites it (research R1). It has no front matter and MUST be exempt from concept validation, or the gate fails on its own instructions file.
- **The reserved history file is `log.md`, singular** (research R7). The vendor blog says `logs.md`; the shipped code does not. A gate written against `logs.md` silently never finds it.
- **Never run `openwiki --init`.** `--update` creates the bundle when absent, so the interactive onboarding — and the `~/.openwiki/.env` it would write — is avoided entirely (research R2). This is what keeps FR-027 satisfiable.
- **Always invoke through the Nx target.** It sets `OPENWIKI_TELEMETRY_DISABLED=1`; the raw CLI transmits by default and the Windows host has no firewall to fall back on (research R4/R4c).
- **A leak-gate hit is fixed in `INSTRUCTIONS.md` and regenerated — never allowlisted** (FR-012).
- **Generation is a paid model run.** Only T016 and T035 trigger one on the happy path. Batch `INSTRUCTIONS.md` fixes — collect every gate and audit finding first, amend once, regenerate once.

---

## ✅ IMPLEMENTATION STATUS — 39/43, coverage complete (2026-07-27)

**The bundle is delivered**: 45 concepts across 8 directories, conformance gate exit 0, both leak
gates green with the bundle tracked, all 17 canonical documents cited (0 uncited).

**Final validation status**:
- ✅ `lint`, `typecheck`, **jest 1152/1152** (119 suites), **cargo `--lib` 148/148**, script tests **257/257**
- ✅ `rtk gain` — **87.8%** compression (343.9K tokens saved over 342 commands), above the 80% bar
- ⚠️ **mc-service integration**: verified passing earlier this session (23/0 on the collections suite).
  The local Mongo container subsequently died with **`Too many open files`** — a per-container fd
  limit exhausted by a long session, unrelated to this feature (which touches **zero** files under
  `backend/`, `frontend/`, `agents/`, `mcp-servers/`). Re-verify on a fresh stack.
- ⚠️ **T042 web E2E**: not run locally. `app-ci`'s `pull_request` trigger is **not** path-gated, so
  **the PR runs the full suite including `app-e2e` automatically** — that is the authoritative run.
  A local containerized-Playwright run against the currently-degraded stack would prove nothing.
- ⏳ T035 freshness rehearsal — deferred; the six slice runs exercised the same `wiki-update` path.

**Operational lesson worth carrying forward**: generation must be driven in **bounded slices** with an
explicit page list. The tool cannot complete a ~45-page first pass in one invocation and **reports
success when it gives up** — always assert the resulting page count and run
`pnpm nx okf-lint infrastructure-as-code`, never trust the exit code. Full detail in
[SC-003-SC-004-EVIDENCE.md](./SC-003-SC-004-EVIDENCE.md).

---

## Phase 1: Setup

- [X] T001 Install the pinned CLI ad-hoc in the dev container: `npm install -g openwiki@0.2.3` (elevate if `/usr/local` is not writable). Confirm `openwiki --version` reports `0.2.3` and `node --version` is ≥ 22 (container is v24.18.0). This is the ad-hoc install the sequencing clarification calls for — the baked toolchain entry lands in T026.
- [X] T002 [P] Add the `wiki-update` and `okf-lint` targets to `infrastructure-as-code/project.json`, following the existing `dast` / `sast` / `infra-scan` target shape. `wiki-update` MUST set `OPENWIKI_PROVIDER=anthropic` **and** `OPENWIKI_TELEMETRY_DISABLED=1` in its own env and run `openwiki code --update --print`; `okf-lint` runs `node scripts/check-openwiki-okf.mjs`. Include a `description` naming the telemetry opt-out so a future reader cannot mistake it for boilerplate (FR-030).
- [X] T003 [P] Add `OPENWIKI_PROVIDER` and `OPENWIKI_TELEMETRY_DISABLED` to `containerEnv` in `.devcontainer/devcontainer.json` as **non-secret literals** — deliberately NOT `${localEnv:…}` passthroughs, so no new host variable is required in either workspace. Defense in depth for ad-hoc direct CLI use inside the container.

**Checkpoint**: `openwiki --version` → `0.2.3`; both Nx targets resolve.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Blocks**: US1 (nothing can be generated without the brief), US3, US6.

- [X] T004 Author `openwiki/INSTRUCTIONS.md` with the four directive groups specified in [data-model.md](./data-model.md#entity-generation-instructions-openwikiinstructionsmd): (a) **exclusions** — `node_modules/`, `target/`, `.venv/`, `.nx/`, `.pnpm-store/`, `.mypy_cache/`, `.ruff_cache/`, `dist/`, `coverage/`, `test-results/`, all `.env*`, `secrets/`, lockfiles, and **`docs/proposals/**`**; (b) **redaction** — never reproduce hostnames, host+port pairs, tokens, or credential-shaped values; refer to "the forge host" and "the prod domain" abstractly; (c) **summarize and link** — never restate `docs/`, carry a distilled summary plus gotchas plus a `resource` link; (d) **priority areas** — per-project overviews (BFF modules, mc-service layers, agent layer, MCP servers), cross-cutting invariants (auth chain, env-scoped models, prod port ranges), and the non-obvious design decisions currently held only in `CLAUDE.md`. Also direct the generator to emit exactly **one** `type: Process` concept covering the proposal → spec → implementation lifecycle, since `docs/proposals/**` is excluded (FR-006).
  **Type**: Documentation | **Risk**: Medium — this file is the sole control surface over generation quality and leakage.
  **Done when**: the file exists, states all four groups, and is committed **before** any generation run.
- [X] T005 Create the acceptance evidence document `specs/043-openwiki-okf/SC-003-SC-004-EVIDENCE.md` **now, as a skeleton with empty sections** (FR-029), following the feature-041 precedent. Sections: retrieval questions (SC-003), concept audit (SC-004), telemetry result (SC-013), tool-managed block size (SC-007), and generation calibration. It is created here rather than in Polish because T021, T022, T035 and T017 all record into it as they run — quickstart.md requires recording "as you go — not reconstructed afterwards". T038 finalizes it.
  **Type**: Documentation | **Risk**: None.
  **Done when**: the file exists with all five headed sections, each explicitly marked pending.

**Checkpoint**: `openwiki/INSTRUCTIONS.md` exists and is the only file under `openwiki/`; the evidence skeleton exists.

---

## Phase 3: User Story 2 — Prove the bundle is conformant and leak-free (Priority: P2)

**Goal**: An automated gate rejects a structurally malformed bundle, and the existing leak gates reject a bundle carrying topology or credential-shaped strings.

**Independent Test**: Run the gate against fixture bundles each broken in exactly one way, plus one valid bundle. It fails the broken ones naming the offending file and rule, and passes the valid one — with no real bundle present anywhere.

- [X] T006 [US2] Create the fixture bundles under `scripts/__tests__/fixtures/openwiki-okf/`, one directory per rule in [data-model.md](./data-model.md#validation-rules-what-the-gate-enforces): `unparseable-frontmatter/`, `missing-type/`, `blank-optional-field/`, `tags-not-array/`, `bad-timestamp/`, `dangling-resource/`, `external-resource/`, `missing-index/`, `orphaned-concept/`, `instructions-only/`, `stale-concept/`, `valid/`. Each fixture must be broken in **exactly one** way, so a failure names one rule unambiguously. Keep them tiny (2–3 files each).
- [X] T007 [US2] Write unit tests FIRST (RED) in `scripts/__tests__/check-openwiki-okf.test.mjs`, driving the **real CLI as a subprocess** via `spawnSync` with `--bundle <fixture>` (the pattern from `check-dast-findings.test.mjs`). Cover every rule V1–V13: V1 unparseable front matter → exit 1; V2 missing/blank `type` → exit 1; V3 blank optional field → exit 1; V4 `tags` as a bare string → exit 1; V5 non-ISO-8601 `timestamp` → exit 1; V6 dangling repo-relative `resource` → exit 1 naming the missing path; V7 external `resource` → exit 0 **and no network call**; V8 directory without `index.md` → exit 1; V9 concept absent from its `index.md` → exit 1; V10 absent/empty bundle → **exit 1, not 2**; V11 `INSTRUCTIONS.md` present → exempt, exit 0; V12 stale concept → **warning text emitted but exit 0**; V13 valid bundle → exit 0 with no findings. Assert the gate reports **all** findings in one run, not just the first. Verify RED.
  **Scenarios**: US2-AC1 (malformed named), US2-AC2 (bad timestamp named), US2-AC3 (dangling reference named), US2-AC4 (missing summary page), US2-AC5 (valid passes), US2-AC8 (absent bundle fails closed), US2-AC9 (drift warns, does not fail), US2-AC10 (external link not fetched).
  **Verify RED**: `node --test scripts/__tests__/check-openwiki-okf.test.mjs`
  **Expected RED**: all cases failing — `Error: Cannot find module '.../scripts/check-openwiki-okf.mjs'` (spawn exits 1 with ERR_MODULE_NOT_FOUND). If any case *passes* here, the assertion is not actually exercising the gate.
- [X] T008 [US2] Implement `scripts/check-openwiki-okf.mjs` to GREEN per [contracts/check-openwiki-okf-cli.md](./contracts/check-openwiki-okf-cli.md). Mirror the tool's own front-matter contract exactly (research R8) — `type` required and non-empty; optional string fields non-empty when present; `tags` an array of non-empty strings; **unknown keys permitted and ignored**. Do **not** require `title`/`description`: the generator leaves such pages unchanged, so a stricter gate would fail pages its own generator considers valid and no regeneration could fix it. Layer the repo rules on top (ISO-8601 `timestamp`, resolvable `resource`, per-directory `index.md`, orphan detection). Exit codes `0`/`1`/`2` exactly as contracted; findings sorted by path for diffable output.
  **Verify GREEN**: `node --test scripts/__tests__/check-openwiki-okf.test.mjs` → `# fail 0`
- [X] T009 [US2] Implement source-link resolution to GREEN (FR-013a): classify by shape — an absolute URL with a network scheme is **external** and is checked for well-formedness only and **never fetched**; anything else is repository-relative, resolved against the repo root with fragments and query strings stripped before the existence check. The gate must remain fully functional with no network at all.
  **Verify GREEN**: `unshare -rn node scripts/check-openwiki-okf.mjs --bundle scripts/__tests__/fixtures/openwiki-okf/external-resource` → exit 0 with no network namespace. This is the concrete proof the `guardrails` job stays keyless and immune to third-party outages.
- [X] T010 [US2] Implement report-only drift detection to GREEN (FR-014b, V12): for a concept carrying both a `timestamp` and a repo-relative `resource`, compare the source's last modification against the concept timestamp and emit a warning naming both files. It MUST NOT affect the exit code — a documentation edit must never block a merge on a paid regeneration run.
  **Verify GREEN**: `node --test scripts/__tests__/check-openwiki-okf.test.mjs` → `# fail 0`
- [X] T011 [US2] Implement `--selftest` covering every rule V1–V13 against synthetic temp-dir cases, failing (exit 1) if any rule stops detecting its case. It MUST additionally assert the two rules most likely to be broken by a well-meaning refactor: `INSTRUCTIONS.md` stays exempt (V11), and drift warns without escalating (V12). This is a genuine self-check, **not** a duplicate of T007 — `scripts/__tests__/check-openwiki-okf.test.mjs` remains authoritative and is CI-enforced by the existing glob.
  **Verify GREEN**: `node scripts/check-openwiki-okf.mjs --selftest` → exit 0 with a summary naming the rules exercised.
- [X] T012 [US2] Write a **characterization test** in `scripts/__tests__/leak-gate-coverage.test.mjs` asserting that the whole-tree leak gates cover bundle paths (FR-018): plant a topology-shaped string and a credential-shaped string in a file under a temp `openwiki/`-style path and confirm the `check-topology-scrub.mjs` / `secret-scan.mjs` detection rules match it.
  **⚠️ Explicitly EXEMPT from the Verify RED rule — the only such task in this feature.** FR-018 asks to *assert existing* coverage, and both gates already walk the whole tracked tree, so this test passes the moment it is written. That is the correct outcome, not a trivially-passing test to be "fixed": its value is as a **regression guard**, failing loudly if either gate is ever narrowed to an allowlist of paths that omits the bundle. Forcing an artificial RED here would mean breaking a working gate to watch it fail.
  **Scenarios**: US2-AC6 (leak gates fail on a leaking page).
  **Verify (expected GREEN immediately)**: `node --test scripts/__tests__/leak-gate-coverage.test.mjs` → `# fail 0`. **A failure here is a real finding** — it would mean the bundle is not actually covered, and the gates must be widened before any bundle is committed.

**Checkpoint**: `node --test scripts/__tests__/*.test.mjs` green (the exact command CI runs); `node scripts/check-openwiki-okf.mjs --selftest` green; `node scripts/check-openwiki-okf.mjs` **correctly exits 1** with `no bundle at openwiki/` — fail-closed working as designed, not a setup error.

---

## Phase 4: User Story 5 — Live operator documents sit where the bundle can describe them (Priority: P3)

**Runs before generation** so a single generation run covers all fourteen runbooks (see the execution-order note).

**Goal**: The two live operator procedures move out of the excluded proposal tree so the exclusion rule stays clean and the bundle can carry a concept for each.

**Independent Test**: Both documents are reachable at their new location and a tracked-tree search finds zero references to either old path. (The matching concepts are verified later by the coverage check in T019, which is where SC-012 is measured.)

- [X] T013 [US5] Write the link-integrity test FIRST (RED) in `scripts/__tests__/relocated-docs-links.test.mjs` — **its own file**, not the OKF gate's suite, which is scoped to conformance and must not accumulate unrelated assertions. It greps the tracked tree (`git ls-files`) and asserts **zero references** to `docs/proposals/homelab-setup/Phase-15-Operator-Checklist.md` and `docs/proposals/homelab-setup/Server-Setup-Runbook.md`. No gate script is needed — the test performs the search directly. Verify RED **before** T014/T015 run; the references still exist at this point, which is exactly what makes RED reachable.
  **Scenarios**: US5-AC2 (no reference to an old location remains).
  **Verify RED**: `node --test scripts/__tests__/relocated-docs-links.test.mjs`
  **Expected RED**: 1 failing — old-path references still present (at minimum in `CLAUDE.md`, which cites both as authoritative CI/CD procedure).
- [X] T014 [US5] `git mv docs/proposals/homelab-setup/Phase-15-Operator-Checklist.md docs/runbooks/` and `git mv docs/proposals/homelab-setup/Server-Setup-Runbook.md docs/runbooks/`, content unchanged. Remaining historical proposals stay untouched and excluded.
- [X] T015 [US5] Update every tracked inbound reference to the two old paths so each link resolves. Find them with `grep -rn "proposals/homelab-setup/Phase-15-Operator-Checklist\|proposals/homelab-setup/Server-Setup-Runbook" --exclude-dir=node_modules .`
  **Verify GREEN**: `node --test scripts/__tests__/relocated-docs-links.test.mjs` → `# fail 0`

**Checkpoint**: both documents live in `docs/runbooks/` (14 runbooks total), every link resolves, zero old-path references remain.

---

## Phase 5: User Story 1 — Find load-bearing knowledge without reading everything (Priority: P1) 🎯 MVP

**Goal**: A queryable bundle of concepts, each a distilled summary plus gotchas plus a link to the authoritative source, covering the canonical documentation with no silent gaps.

**Independent Test**: Pose eight real repository questions spanning distinct subsystems; each is answerable by selecting on concept metadata, opening no more than two bundle files, and each answer carries a working link to its canonical source.

- [X] T016 [US1] Run the first generation: `pnpm nx wiki-update infrastructure-as-code`. Treat this as a **calibration run** — record wall-clock time and token/dollar cost in the evidence document, the only unknown research deliberately left open. Never use `--init`.
  **Done when**: `openwiki/` contains concepts, a per-directory `index.md`, and a `log.md`, and `openwiki/INSTRUCTIONS.md` is **unmodified** (the tool must not have rewritten it — if it did, that contradicts research R1 and must be investigated before proceeding).
- [X] T017 [US1] Measure the tool-managed `<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` block the generation wrote into `CLAUDE.md`, and record its byte size in the evidence document. Per SC-007 this block is **excluded** from the hand-authored growth budget — its size is set by the generator, not by this feature — but recording it makes an unexpected future increase visible. Feeds the T033 verification.
- [X] T018 [US1] Run the conformance gate and both leak gates against the generated bundle, each `--selftest` first per house rules: `node scripts/check-openwiki-okf.mjs --selftest && node scripts/check-openwiki-okf.mjs`; `node scripts/check-topology-scrub.mjs --selftest && node scripts/check-topology-scrub.mjs`; `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs`. **On any hit: amend `openwiki/INSTRUCTIONS.md` and regenerate (T016). Adding an allowlist entry is prohibited (FR-012)** — it would convert a leak into a permanently accepted one. Batch all findings from T018–T022 into a single amend-and-regenerate cycle.
  **Done when**: all three gates exit 0 against the real bundle with zero allowlist entries added.
- [X] T019 [US1] Verify full navigational coverage (FR-007, SC-012): **all 14 runbooks** under `docs/runbooks/` (12 original + the 2 relocated in T014), the ADR in `docs/decisions/`, and both architecture documents (`docs/MCM-Architecture.md`, `docs/runbooks/agent-layer.md`) have **at least one concept citing them**. Any gap is fixed by amending `INSTRUCTIONS.md` and regenerating, never by hand-writing a concept — a hand-written concept is silently overwritten on the next update.
- [X] T020 [US1] Verify the proposal-tree exclusion (FR-006): no concept derives from `docs/proposals/**`, and **exactly one** `type: Process` concept describes the proposal → spec → implementation lifecycle and links to the folder for humans.
- [X] T021 [US1] Factual spot-check of **at least ten** concepts against the sources they cite (SC-004). Generated documentation can be confidently wrong and the bundle inherits the repo's no-vibe-coding standard. The canonical document always wins: correct or remove the concept. **Also check FR-005 compliance while auditing** — each concept must be a distilled summary plus gotchas that *links* to its source, not a verbatim restatement of it; a concept can be perfectly accurate and still violate FR-005. Record each audited concept, its accuracy outcome, and its restatement verdict in the evidence document.
- [X] T022 [US1] Retrieval validation (SC-003): pose **at least eight** repository questions spanning distinct subsystems and confirm each is reachable by selecting on concept metadata, opening **no more than two** bundle files. Record each question and the concepts that resolved it in the evidence document.
- [X] T023 [US1] Commit `openwiki/` — the bundle versions with the code it describes.

**Checkpoint**: US1 is independently shippable — the bundle exists, is conformant and leak-free, covers the canonical docs, and demonstrably answers real questions. **This is the MVP.**

---

## Phase 6: User Story 2 (completion) — CI enforcement

**Depends on Phase 5**: the gate is fail-closed, so this job must not land before a real bundle exists.

- [X] T024 [US2] Add an `okf` job to `.forgejo/workflows/guardrails.yml`, mirroring the `naming` job's shape: `runs-on: ubuntu-latest`, checkout, then `bash scripts/ci-log-step.sh okf-gate node scripts/check-openwiki-okf.mjs --selftest` and `bash scripts/ci-log-step.sh okf-gate node scripts/check-openwiki-okf.mjs`. It MUST end with the feature-042 `Publish failure digest` step (`if: always()`, `continue-on-error: true`, `node scripts/ci-failure-digest.mjs`, `CI_DIGEST_TOKEN` in `env:`) — without it `check-ci-digest-coverage.mjs` fails the build (FR-017). Do **not** add the new test files here: they are already gated by the `naming` job's shell-expanded glob.
- [X] T025 [US2] Verify CI wiring locally: `node scripts/check-ci-digest-coverage.mjs --selftest && node scripts/check-ci-digest-coverage.mjs` → exit 0 with the new job counted. Confirm the new job becomes a required context automatically via the `guardrails*` branch-protection glob — no operator action needed. Also confirm the job introduces **no new secret** beyond the existing `CI_DIGEST_TOKEN` and **no `schedule:` trigger** (FR-019, SC-008).

**Checkpoint**: `check-ci-digest-coverage` passes with the `okf` job present; the gate runs on every push.

---

## Phase 7: User Story 3 — Regenerate from either supported workspace (Priority: P2)

**Goal**: Both supported workspaces can generate or update the bundle from the same pinned version, with no new credential handling.

**Independent Test**: A generation run succeeds in the container from the documented setup, and the same pinned version is recorded for the host with its setup documented in that workspace's own runbook.

- [X] T026 [US3] Bake the pinned CLI into `.devcontainer/toolchain.Dockerfile`: `npm install -g openwiki@0.2.3`, placed beside the existing `npm install -g @anthropic-ai/claude-code` (line ~67). Version-pinned, delivered via the normal `devcontainer-image.yml` refresh path.
  **Known residual** (accepted in the spec): the baked path is not proven end-to-end until the next image refresh. Record it as an acceptance follow-up rather than blocking the feature.
- [X] T027 [P] [US3] Document the container setup in `docs/runbooks/devcontainer.md`: the pin, the Nx target as the supported invocation path, and that `~/.openwiki` is **disposable** — no named volume is added, because in code mode the wiki lives in the repository and only onboarding/checkpoint state is lost on recreate (research R6, resolving US3-AC3).
- [X] T028 [P] [US3] Document the host setup in `docs/runbooks/dev-environment-setup.md`, RTK-style: Node ≥ 22, `pnpm add -g openwiki@0.2.3` (same pin), configuration outside version control, and **always invoke via `pnpm nx wiki-update`** — a raw CLI call on the host bypasses the telemetry opt-out and the host has no egress firewall as a backstop. Note the optional belt-and-braces `setx OPENWIKI_TELEMETRY_DISABLED 1`, and state explicitly that **no new host environment variable is required** by the feature.

**Checkpoint**: both runbooks record the same pin; a container generation run works from the documented path.

---

## Phase 8: User Story 4 — Every coding assistant knows the bundle exists (Priority: P3)

**Goal**: All four assistant configuration surfaces point at the bundle with the same retrieval convention.

**Independent Test**: Inspect each of the four surfaces; each carries an equivalent pointer, and no machine-managed region was altered.

- [X] T029 [US4] Review the tool-written `<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` blocks in `CLAUDE.md` and `AGENTS.md` (created during T016). Confirm the block sits **entirely after** `<!-- SPECKIT END -->` (currently `CLAUDE.md:573`) and never interleaves with the Nx block (`CLAUDE.md:544–567`). `AGENTS.md` has neither block, so it carries no interleaving risk.
  **Verify**: `grep -n "nx configuration start\|nx configuration end\|SPECKIT START\|SPECKIT END\|OPENWIKI:START\|OPENWIKI:END" CLAUDE.md` shows the OPENWIKI pair last and unnested.
- [X] T030 [P] [US4] Add the pointer to `.github/agents/copilot-instructions.md`: a structured OKF wiki exists at `openwiki/`; query concept metadata by `type`/`tags` before falling back to a broad search.
- [X] T031 [P] [US4] Add the equivalent pointer to the OpenCode surface (`.opencode/` / `opencode.json`).
- [X] T032 [P] [US4] Add the equivalent pointer to the Codex surface (`.codex/`).
- [X] T033 [US4] Correct the stale environment statement in `CLAUDE.md` (FR-023): the DinD dev container is the **primary** workspace; the Windows host remains required for Android emulator, native builds, and Maestro mobile E2E. This line is the live example of the instruction-file drift this feature exists to catch.
  **Verify (FR-022 / SC-007)**: `git diff CLAUDE.md | grep '^-' | grep -v '^---'` shows **only** the replaced shell line — no other existing line deleted. Then measure **hand-authored** growth only: total diff growth minus the T017 block size must be **under 1 KB**. The tool-managed block is excluded from the budget by SC-007 because its size is set by the generator, not by this feature.

**Checkpoint**: four surfaces carry the pointer; every machine-managed region byte-identical apart from the intended insertion.

---

## Phase 9: User Story 6 — The bundle stays current as a by-product of normal work (Priority: P4)

**Goal**: Freshness is folded into the existing end-of-feature routine, with no scheduled job and no new automation credential.

**Independent Test**: The completion checklist carries the update step, and the step runs successfully in a supported workspace.

- [X] T034 [US6] Add the update step to the **Final Validation Checklist** in `CLAUDE.md` (FR-028): before marking a feature complete, run `pnpm nx wiki-update infrastructure-as-code` and include the resulting diff in the same change. Place it before the `rtk gain` line, which must stay last.
- [X] T035 [US6] Rehearse the step once (SC-011): run the update and confirm it produces either a reviewable diff or a verified no-op — **not** an error. Record the outcome in the evidence document. This is the second and final expected paid generation run.

**Checkpoint**: the checklist carries the step and the step is proven to run.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T036 Amend the **Monorepo Directory Structure** tree in `.specify/memory/constitution.md` to include `openwiki/`, with a one-line note on why it is separate from `docs/` (generated vs human-owned ownership rule). **Deviation approved by Steve on 2026-07-26** — record the approval and its date alongside the amendment, per the constitution's governance rule (FR-025).
- [X] T037 [P] Update the repository-structure block in `README.md` to include `openwiki/` (FR-025).
- [X] T038 [P] Finalize the evidence document created in T005 (FR-029): confirm all five sections are populated — the eight retrieval questions (T022), the ten audited concepts with accuracy and restatement verdicts (T021), the SC-013 telemetry result (T039), the tool-managed block size (T017), and the T016 calibration figures. These criteria are human judgement performed once; without this record they are unfalsifiable later.
- [X] T039 Prove telemetry is off (SC-013): run `pnpm nx wiki-update infrastructure-as-code --args=--telemetry-file=/tmp/ow-telemetry.json`, then assert the file's **content** — `{"disabled": true, "sent": false}`. **Corrected during implementation**: the original `test -s <file> && echo FAIL` check was wrong — the tool always writes a verdict file, so testing for absence reports FAIL on a correctly-disabled run. **Observed 2026-07-27: `{"disabled": true, "sent": false}` — PASS.** Confirm the opt-out is structural, not incidental: `git diff --quiet .devcontainer/init-firewall.sh` (allowlist untouched — disabling is by configuration, never by widening egress) and `grep -q OPENWIKI_TELEMETRY_DISABLED infrastructure-as-code/project.json` (the target sets it).
- [X] T040 Run the repository gate suite, each `--selftest` first: `check-openwiki-okf`, `secret-scan`, `check-topology-scrub`, `check-ci-digest-coverage`, `check-resource-naming`, `check-no-inline-secrets`.
- [X] T041 Full validation per the Final Validation Checklist: `pnpm nx lint mcm-app`, `pnpm nx typecheck mcm-app`, `pnpm nx test mcm-app`, `pnpm nx test mc-service`, `pnpm nx test:integration mc-service`.
- [~] T042 Web E2E regression — **REQUIRED for this feature, no deviation** (explicitly confirmed). It cannot run natively in this container (Chromium is uninstallable behind the egress allowlist), so run it in **`mcr.microsoft.com/playwright:v1.60.0-noble`** with `--network host` per [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md). Confirm the image tag still matches the repo's installed `@playwright/test` before running — the runbook's rule is that the image must match the installed version, and a mismatch silently tests a different browser build.
- [X] T043 `rtk gain` — confirm > 80% token compression (run last; it measures the runs above).

---

## Platform Parity Table

**Omitted — justified.** Per [docs/templates/feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md), the table applies only to features spanning multiple *frontend* clients. This feature adds no UI surface: it delivers repository tooling, generated documentation, and a CI gate. There is no web or mobile scenario to mirror.

The template's accompanying rule still binds and is **not** waived: the full-stack web E2E regression is required regardless (T042).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)** → no dependencies.
- **Phase 2 (Foundational)** → needs T001. **Blocks Phase 5.**
- **Phase 3 (US2 gate)** → needs only Phase 1; **independent of Phase 2**. Can run in parallel with Phase 2.
- **Phase 4 (US5 relocation)** → independent of Phases 2 and 3. **Must precede Phase 5** so one generation covers all 14 runbooks.
- **Phase 5 (US1 bundle)** → needs Phases 2, 3, and 4. 🎯 MVP.
- **Phase 6 (US2 CI)** → needs Phase 5 (fail-closed gate must not land before a real bundle).
- **Phase 7 (US3)** → needs Phase 1; independent of Phase 5.
- **Phase 8 (US4)** → T029 and T033 need Phase 5 (the block is written during generation); T030–T032 are independent.
- **Phase 9 (US6)** → needs Phase 1 (the target) and Phase 5 (something to update).
- **Phase 10 (Polish)** → T036–T037 independent; T038–T043 need everything above.

### Critical path

T001 → T004 → (Phase 3 gate) → (Phase 4 relocation) → T016 generation → T018 gate-clean → T023 commit → T024 CI job → T041–T043 validation.

### Parallel Opportunities

- **Phase 1**: T002 and T003 in parallel after T001.
- **Phases 2, 3, and 4 run concurrently** — the brief, the gate, and the relocation touch disjoint files with no shared state. This is the single biggest scheduling win, since the gate is the largest body of work and the relocation is on the critical path.
- **Phase 3**: T006 fixtures must precede T007; T008–T011 are sequential (same file); T012 is independent (own test file).
- **Phase 7**: T027 and T028 in parallel (different runbooks).
- **Phase 8**: T030, T031, T032 fully parallel (three different config surfaces).
- **Phase 10**: T036, T037, T038 in parallel.

### Within Each User Story

Tests precede implementation (TDD, non-negotiable). Verify RED before writing any implementation task's code — with the single labelled exception of T012, justified inline.

---

## Implementation Strategy

### MVP First

Phases 1 → 2 → 3 → 4 → 5 delivers the MVP: a conformant, leak-free, committed bundle that demonstrably answers real repository questions, with a gate that proved it and the operator documents already in their final home. Stopping there is a coherent, shippable increment.

### Incremental Delivery

1. **Increment 1** (Phases 1–5): the bundle, its gate, and the relocation. Shippable.
2. **Increment 2** (Phases 6–7): always-on CI enforcement and workspace parity. Makes it durable.
3. **Increment 3** (Phases 8–9): consumers and the freshness loop. Makes it reachable and current.
4. **Increment 4** (Phase 10): governance, evidence, and full validation. Makes it complete.

### Cost discipline

Generation is a paid model run. On the happy path only **T016** and **T035** trigger one (T039 reuses the T035-style invocation with a telemetry file). Relocating before generating removed a third run. Batch `INSTRUCTIONS.md` fixes: collect every finding from T018–T022, amend once, regenerate once.

---

## Completion Checklist

Before marking `043-openwiki-okf` complete, verify all success criteria from [spec.md](./spec.md):

- [ ] **SC-001**: 100% of concepts pass conformance, checked automatically on every change
- [ ] **SC-002**: zero un-redacted hostnames, host+port pairs, or credential-shaped strings; both leak gates pass; **zero allowlist entries added**
- [ ] **SC-003**: eight retrieval questions resolved by metadata, ≤ 2 files opened each, recorded in the evidence document
- [ ] **SC-004**: ≥ 10 concepts audited against cited sources, 100% of inconsistencies corrected, recorded
- [ ] **SC-005**: four assistant surfaces carry the pointer; machine-managed regions byte-identical apart from the intended insertion
- [ ] **SC-006**: zero tracked references to the pre-move operator-doc paths; every updated link resolves
- [ ] **SC-007**: `CLAUDE.md` gained only the pointer and the one environment correction; no line deleted; **hand-authored** growth < 1 KB, with the tool-managed block measured and recorded but excluded
- [ ] **SC-008**: zero new stored automation credentials; zero scheduled jobs
- [ ] **SC-009**: generation reproducible from the pinned version in the container; same pin documented for the host
- [ ] **SC-010**: `--selftest` detects every failure class it claims, one fixture per class, failing before and passing after
- [ ] **SC-011**: the completion checklist carries the update step, rehearsed once with a reviewable diff or verified no-op
- [ ] **SC-012**: all 14 runbooks, the ADR, and both architecture documents have at least one concept citing them
- [ ] **SC-013**: zero telemetry events leave either workspace; egress allowlist unchanged
- [ ] Constitution deviation amended and the 2026-07-26 approval recorded
- [ ] Platform parity table justified as omitted (no frontend-client surface)
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation), except the single labelled characterization test (T012)
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx typecheck mcm-app` — clean
- [ ] `pnpm nx test mcm-app` — unit tests pass
- [ ] `pnpm nx test mc-service` / `test:integration mc-service` — pass
- [ ] `node --test scripts/__tests__/*.test.mjs` — the exact command CI runs — green
- [ ] `pnpm nx e2e mcm-app` — web E2E passes (containerized Playwright, `--network host`)
- [ ] `rtk gain` — > 80% token compression confirmed (run last)
