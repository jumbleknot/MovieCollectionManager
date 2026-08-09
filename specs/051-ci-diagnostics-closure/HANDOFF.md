# Handoff — 051 CI diagnostics closure, ready to implement

**Written**: 2026-08-09 · **Status**: spec → plan → tasks complete and analysed; **no implementation
started**

The SDD gate is satisfied. [spec.md](./spec.md) (7 user stories, FR-001–FR-031, SC-001–SC-010),
[plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md),
[quickstart.md](./quickstart.md), three [contracts/](./contracts/) and [tasks.md](./tasks.md)
(62 tasks) are written and have been through `/speckit-analyze` with all CRITICAL/HIGH/MEDIUM
findings remediated.

**Read [research.md](./research.md) before anything else.** It overturns the input PRD's headline
diagnosis. Implementing from the PRD without it builds the wrong thing.

## Current state

- **Branch**: `051-ci-diagnostics-closure`, cut from `main` at `89b8975`.
- **Six commits, all documentation.** `bd54ed7` spec → `c7ea5bd` plan → `9152052` → `543b9db`
  (§1.3 reopened) → `5dae9bf` tasks → `0fdc317` analyze remediation.
- **Working tree clean. Nothing pushed.** No remote branch exists yet.
- **No implementation started.** T001 onward is open, including the Phase 1 baselines.
- The `CLAUDE.md` SPECKIT pointer already points at this feature's plan.

## Decided — implement, do not relitigate

| Decision | Where |
|---|---|
| All four backlog items (#155, #156, #157, #158) ship as **one feature, one PR** | Operator direction. #158's own comment argued for separation; considered and overridden |
| **PRD §3.1 is REJECTED** — do **not** relocate step logs. The premise is false | [research.md § R1](./research.md) |
| **PRD §1.3 is REOPENED** — it was never resolved; the cause is CRLF | [research.md § R8a](./research.md) |
| Line endings fixed at **both** layers — `.gitattributes` *and* tolerant parsing | Operator direction, [R8c](./research.md) |
| All **seven** Windows sweep findings are in scope, not just item #157's one | Operator direction, [R8](./research.md) |
| SC-002/SC-005 proven by **deliberately breaking CI on this branch**, reverted before merge | Operator direction, spec Assumptions |
| The nine `ci-log-step` Windows failures become **reasoned skips**, not passes | spec SC-006, T049 |
| Item #157 stays **open** until the operator's Windows re-run | spec Assumptions, T049 |
| FR-004 and FR-009 are **retired in place** — numbering kept so the change stays visible | spec Story 2 note |

## Mechanism facts — established by verification, not assumption

These cost real time to pin down. Trust them; re-verify only if something contradicts them.

- **The digest reads step captures IN-JOB.** `Publish failure digest` is a step inside the same job,
  and every step of a container-executor job runs in the **same container**. Reproduced end to end:

  ```bash
  tmp=$(mktemp -d)
  HOME="$tmp" GITHUB_RUN_ID=999 bash scripts/ci-log-step.sh probe sh -c 'echo "REAL FAILURE"; exit 3'
  T="$tmp" node -e 'import("./scripts/ci-failure-digest.mjs").then(m=>{
    const home=process.env.T, env={HOME:home,GITHUB_RUN_ID:"999"};
    console.log(m.readFailingStep(env,home));
    console.log(m.collectEvidence({home,cwd:process.cwd(),env}).excerpts);})'
  # -> probe ; [ { source: 'step:probe', text: 'REAL FAILURE\n' } ]
  ```

  **Note the `T=` assignment goes before `node`.** After it, it is argv and `process.env.T` is
  undefined — the probe then prints nothing and looks like it disproved the point.

- **The PRD's "no container-job logs on the runner" measurement is true and irrelevant.** Host-executor
  jobs leave leftovers; container jobs consume theirs in-job. Absence of leftovers is not evidence
  about diagnosability.

- **The real gap: 48 of 83 `run:` steps across 14 containerized jobs produce no capture.** In
  `guardrails / naming`, **every** gate step is bare — only `Script unit tests` and `DAST leak-scan
  guard` are wrapped. A naming-gate failure publishes two unrelated logs.

- **`check-ci-digest-coverage.mjs` passes anyway because it requires only ONE wrapped step per job.**
  That is why the gate is green while the jobs are undiagnosable.

- **There are TWO exemption markers with distinct semantics.** `ci-digest-exempt` (job publishes no
  digest, job-scoped, keep it that way) and `ci-log-step-exempt` (nothing worth capturing; this is the
  one extended to step level). Separate blank-reason checks. Do not conflate them.

- **`parseExemptions` is CRLF-broken.** `text.split('\n')` leaves a trailing `\r`; the marker pattern
  `#\s*<marker>:(.*)$` cannot match because `.` will not consume `\r` and non-multiline `$` demands
  end-of-input. The adjacent job-header pattern survives because its `\s*` absorbs it — **that
  asymmetry is the bug**. Reproducible on Linux: `parseExemptions(LF) -> Map(1)`,
  `parseExemptions(CRLF) -> Map(0)`.

- **`check-openwiki-okf.mjs` has the same class and fails OPEN.** Its V12 guard calls
  `Date.parse(fields.timestamp)` **untrimmed** → `NaN` on CRLF → the drift check silently never runs
  and the gate prints `✅ conformant`. V5 escapes only because it trims first. Fix by normalizing where
  the field is read, not by adding a second `.trim()` at the call site.

- **`.gitattributes` declares `eol=lf` for `*.sh` only.** `.yml`/`.yaml`/`.md` are unmanaged, so
  `core.autocrlf=true` produces CRLF working trees. That is the shared root of both gate bugs.

- **`app-e2e` runs on `kvm` (HOST executor), not a container** — but its Playwright step runs inside a
  container, which is where the flags fail to cross.

- **Two silent skips in `app-e2e`, not one.** `E2E_AGENT_PRODUCTION` is set at job level but not
  forwarded (item #158). `KEYCLOAK_SERVICE_CLIENT_SECRET` is absent from **both** the job `env:` block
  and the `-e` list, so `admin-card.spec.ts` and `admin-registration.spec.ts` skip too — the fix needs
  both. The secret exists; the same workflow uses it at `app-ci.yml:575`.

- **The agent-stack gate is correct** — only its input was missing. Do not change
  `tests/e2e/web/setup/agent-stack-gate.ts`.

- **`js-yaml` is NOT available to CI scripts.** Verified absent from the root `node_modules`. The
  guardrails suite runs `node --test scripts/__tests__/*.test.mjs` before any install step, so parsing
  stays line-oriented.

- **`pathToFileURL` appears nowhere in the repository.** The `wiki-maintain.test.mjs` absolute-path
  dynamic import is likely not the only instance — T045 sweeps for it.

- **`ci-log-step.test.mjs` case `(e)` covers per-run scoping. There is NO pruning test.** FR-007 is
  preserved by non-action and is genuinely unverified; T025 requires recording that honestly rather
  than claiming coverage.

- **`frontend/mcm-app/.env.example` is gitignored** (`.gitignore:13`) and absent here. The guard tests
  filesystem presence when its own message says it watches for the file being *added to the repo*.

## Open items — need a decision or a measurement

1. **T034 — the auto-token probe. The one true unknown.** Is the automatically-provisioned token
   populated on a run whose Actions secrets are empty, and can it write
   `POST /repos/{owner}/{repo}/statuses/{sha}`? The repository uses it nowhere for API calls, so this
   is unanswerable off-CI. **If negative: STOP. Do not implement T036.** Renegotiate SC-004 with the
   operator; do not weaken it silently. Print the token's **length** and an HTTP status only — never
   the value.
2. **T017 — the agent specs may fail once they finally run.** Item #150 asks whether
   `agent-navigate-movie` / `agent-disambiguation` are green on the Anthropic surface; this feature is
   why that could not be answered. Failures are pre-existing, not regressions. **Reverting to a skip
   is prohibited.**
3. **T049 — the operator's Windows re-run.** Needs T004 landed *and* the operator to re-normalize
   their clone (`git rm --cached -r . && git reset --hard`). Target: 15 failures → 0 (nine reasoned
   skips, six passes), with the collected total **rising** above 408 because `wiki-maintain.test.mjs`
   currently aborts at load.

## Work order

Only three hard dependencies: **US7 → US2**, **T034 → T036**, **T004 + re-normalization → T049**.

1. **Phase 1 baselines (T001–T003)** — cheap, and T003's reproductions are US7's RED evidence.
2. **Phase 2 (T004)** — `.gitattributes`. **Commit alone**; the re-normalization it causes elsewhere
   must be reviewable in isolation.
3. **US7 (T005–T012)** — first of the stories. Small, no CI needed, closes PRD §1.3, and unblocks US2.
4. **US1 (T013–T018)** — **this is the MVP.** One workflow edit plus a permanent guard; closes a p1
   false green on a required gate. If the branch had to stop after one story, this is the one.
5. **US3 (T028–T033)**, then **US2 (T019–T027)** — US2 is the largest and riskiest; T025 is the
   highest-risk task in the feature.
6. **T034 probe**, then **US4** if it returns positive.
7. **US5 / US6** — independent, no CI. Pull forward any time the CI-dependent work stalls.
8. **Phase 10** — rehearsals, then **T058: revert every temporary commit and verify the branch tip**.

## Environment traps in this dev container

- **`pwsh` is NOT installed** and the core Spec Kit scripts (`.specify/scripts/`) are PowerShell-only.
  Resolve the feature directory from `.specify/feature.json` instead. The *git extension* scripts do
  have a `bash/` variant — invoke as `bash <script>`, the files are not executable.
- **RTK is mandatory** — the hook rewrites commands transparently; do not bypass it.
- **Opening the PR**: push a **real branch** (`git push origin HEAD:051-ci-diagnostics-closure`) then
  `POST …/pulls` with the **`git credential fill`** credential, never `MCM_FORGE_TOKEN` and never an
  AGit push. An AGit-headed PR runs with **no Actions secrets** and fails as a bogus nx
  "Misconfigured remote cache endpoint". See [docs/runbooks/ci-diagnostics.md](../../docs/runbooks/ci-diagnostics.md).
- **`cargo` needs `--offline`** here (crates.io is outside the egress allowlist), and
  `cargo fmt -- <file>` formats the **whole crate** — use `rustfmt <path>`. Documenting both is US6's
  entire job, so you will be writing this down anyway.
- **A skipped test reads as a pass.** `MCM_REQUIRE_LIVE_STACK=1`, `E2E_REQUIRE_AGENT_STACK=1`,
  `MCM_REQUIRE_LIVE_MODEL=1` convert a skip to a failure. Watch the **skip count**, not the exit code.

## How to work

- **Follow [tasks.md](./tasks.md) in order within a phase.** Every test task carries a Verify RED;
  every implementation task a Verify GREEN.
- **A Verify RED showing 0 failures is a failed task**, not a passed one. Check the *collected* count
  too — a selector matching nothing also reports no failures.
- **Three tasks cannot be RED on Linux** (T040, T044, T047) and say so, citing the operator's measured
  Windows evidence. **Do not manufacture a local RED for them** — that would satisfy the letter of the
  TDD rule while defeating its purpose, which is the exact failure class this feature closes.
- **Per FR-031, every pass claim names the platform it was observed on.** This spec already asserted a
  Linux-only result as a general one once (§1.3) and was wrong.
- Mark tasks `[X]` as you go and record **measured** RED/GREEN counts inline, as feature 050 did.

## Prompt for the fresh session

```text
Implement feature 051 in /workspaces/mcm on the existing branch 051-ci-diagnostics-closure.

Read specs/051-ci-diagnostics-closure/HANDOFF.md first, then research.md — research
overturns the input PRD's headline diagnosis, and implementing from the PRD without it
builds the wrong thing (it rejects relocating step logs; the real gap is that 48 of 83
run-steps are never instrumented).

Then work tasks.md in order. Start with Phase 1 baselines and Phase 2 (.gitattributes,
committed alone), then User Story 7 — it closes PRD §1.3 and unblocks US2. US1 is the MVP
if you need to stop early.

Rules that matter here more than usual:
- A Verify RED showing 0 failures is a failed task. Check the collected count too.
- T040, T044 and T047 cannot be RED on Linux. They say so and cite measured Windows
  evidence. Do not fabricate a local RED for them.
- Every pass claim must name the platform it was observed on (FR-031).
- T034 is a hard gate: if the auto-token probe comes back negative, STOP and ask before
  implementing T036.
- Nothing is pushed. Do not open a PR without asking.
```
