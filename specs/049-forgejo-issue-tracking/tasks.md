# Tasks: Forgejo issue tracking — an agent-driven backlog (049)

**Input**: [spec.md](./spec.md) · [plan.md](./plan.md) · [research.md](./research.md) ·
[data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md)

## Format

Every task carries a checkbox, a sequential ID, a `[P]` marker when it is parallelizable, a `[US<n>]`
label inside a user-story phase, and an explicit file path.

**Test tasks and their paired implementation tasks additionally carry the TDD checkpoint block** from
[`docs/templates/feature-test-tasks-template.md`](../../docs/templates/feature-test-tasks-template.md),
as mandated by the constitution's TDD Checkpoint Format — `Scenarios covered`, a `Verify RED` command
with an `Expected RED`, and a paired `Verify GREEN`. The two formats are combined rather than chosen
between: the checkbox line is the task, the indented block is the evidence it demands.

Operational tasks (documentation, one-time API setup, live verification) carry a **Done when** instead —
the template does not apply a RED/GREEN cycle to them.

**Scenario IDs**: `US<n>-AC<m>` is acceptance scenario *m* of User Story *n* in [spec.md](./spec.md).

> **Verify RED is mandatory.** A `Verify RED` showing 0 failures means the test is trivially passing and
> must be corrected before implementation begins.

**No Platform Parity Table**: this feature has no frontend client — it is repository tooling plus agent
guidance, so per the template's *Adapting to project type* section the parity table is omitted.

**Test isolation command**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "<name>"`.
The CI gate is `pnpm nx preflight infrastructure-as-code`, which runs `scripts/__tests__`; the direct
`node --test` form is the sanctioned isolation path for an interactive tool
([openwiki/invariants/nx-task-runner.md](../../openwiki/invariants/nx-task-runner.md), corrected by this
feature — an Nx target costs ~60 s per invocation here).

---

## Progress — 2026-08-08

**66 of 72 complete.** The feature works end-to-end against the live forge: filed, read, labelled,
milestoned, linked, blocked, unblocked, closed — with no commit, branch, pull request or CI run.

| Check | Result |
| --- | --- |
| `node --test scripts/__tests__/backlog.test.mjs` | **72 tests · 72 pass · 0 fail** |
| Full glob | **467 · 466 pass · 0 fail · 1 skip** — baseline 397 + 72, exactly as predicted (T066) |
| `pnpm nx preflight infrastructure-as-code` | **✓ 25/25 checks** |
| `rtk gain` | **90.4 %** compression (>80 % required). RTK is at `~/.claude/tools/bin/rtk`, off this shell's PATH — absent PATH, not absent capability |
| `list --state all` | items only, never pull requests (`type=issues`: 1 row vs 143) |
| Label filter, real label | correct and **fails closed**; two `--label` values are **AND**, not OR (T062, FR-017) |
| Label filter, unknown label | refused locally, exit 2, names the label and the fail-open reason |
| `setup-labels` ×2 · `setup-milestone` ×2 | 10 created then "nothing to create" — idempotent, no overwrite |
| `create` | items #144 (unmilestoned → free backlog, T033b) and #145 (milestoned, T036) |
| duplicate title | refused, exit 2, names the existing item |
| `dep 145 --blocked-by 144` | recorded; `show` reports both directions |
| `ready` with a blocker | excludes #145 **and** warns that the label and the graph disagree |
| close a blocked item | **412** `cannot close this issue because it still has open dependencies` → reported distinctly, item unchanged (T038, fixture committed) |
| cycle + self-dependency | refused before the call, exit 2 |
| 4 write verbs under `MCM_FORGE_TOKEN` | **403** each, naming token + permission — **FR-004 proven** |
| `--repo other/thing` | refused, exit 2, nothing written (T060) |
| `env -u MCM_FORGE_ISSUE_TOKEN` | read exits 0 via fallback; write exits 3 naming the variable |
| Host redaction, all live output incl. `--json` | no forge host anywhere; `<forge>` present |
| Tracker state afterwards | probes #144/#145 closed; only Renovate's #29 open |

**Three defects the live run found that the unit tier could not:**

1. **The dependency endpoint needs `{owner, repo, index}`.** A bare `{index}` answers 404
   `IsErrRepoNotExist`, naming the repository rather than the missing fields. Undocumented; now in the
   skill and in a code comment.
2. **The same-repository guard was a tautology.** It compared the derived slug against itself, so it
   guarded nothing. It now checks any `--repo` value *and* asserts at the request boundary, and T060
   verifies the refusal live.
3. **`update` reported a false concurrent change.** The divergence check ran after its own label writes,
   so `--add-label X --state closed` in one invocation aborted on a change it had made itself. Found while
   writing the test for that path; the check is now skipped when the invocation has already written.

**Still open (6), each with its reason:**

- **T037** — `validate-form` correctly reports "not configured on the default branch yet"; the `valid:true`
  assertion can only pass once `.forgejo/issue_template/backlog-item.yaml` is on `main`. Property of the
  forge, not a gap.
- **T050** — needs a container rebuild from the Windows host.
- **T059** — a full task fan-out would put ~70 items in a shared tracker for a verification. Every
  primitive it composes (`create --milestone`, `dep`, ordering, the refusal path) is proven live above;
  the fan-out itself is unrun and is marked so rather than claimed.
- **T055–T057 (US6)** — the operator directed that the workstation backlog not be migrated; end-to-end
  proof was the goal instead, and the probe items above provided it. Deliberately not done.

**Deviation, recorded:** the command layer was written in one pass, ahead of T039–T042 and T051–T052, so
those tests could not be verified RED against a missing implementation. They are labelled
**characterization tests** in the suite (the same explicit exception feature 043 used for
`leak-gate-coverage.test.mjs`). Their value was real anyway: writing two of them surfaced defects 2 and 3
above.

---

## Phase 1: Setup

- [x] T001 Record the baseline pass count of `node --test scripts/__tests__/*.test.mjs` in this file, so
      every later count is measured rather than assumed

  **Type**: Operational | **Risk**: None

  **Spec reference**: none — process hygiene; the measured baseline T066 checks against

  **Done when**: the current total (tests / pass / fail) is written into this task as a dated line. A
  later suite that reports fewer tests than baseline + the tasks below has silently lost coverage — the
  count is the check, not the exit status.

  **Measured 2026-08-08** in the dev container, `node --test scripts/__tests__/*.test.mjs`:
  **397 tests · 396 pass · 0 fail · 1 skipped**, exit 0. Every later count in this feature is compared
  against 397.

- [x] T002 Correct the `MCM_FORGE_ISSUE_TOKEN` comment block in
      [.devcontainer/devcontainer.json](../../.devcontainer/devcontainer.json)

  **Type**: Documentation | **Risk**: None — but it is currently **wrong in git**

  **Spec reference**: FR-003, FR-019

  The comment landed in `e4aee95` describing a credential "minted on a DEDICATED BOT ACCOUNT (e.g.
  backlog-bot) holding collaborator access to THIS REPO ONLY", with a blast-radius warning about adding
  that bot to a second repository. The operator's decision (2026-08-08, [research.md](./research.md) D5)
  is the opposite: the credential is deliberately **not** repository-restricted, and its permissions —
  repository-read plus item-write — are what bound it. Rewrite the block to say that, and to state that
  the tooling's same-repository write guard (FR-016) is the client-side bound. Keep the `setx` /
  fully-quit-VS-Code paragraph verbatim: that failure mode is unchanged and load-bearing.

  **Done when**: the comment describes the credential as provisioned, no sentence claims single-repo
  scoping, and `node scripts/check-topology-scrub.mjs` plus `node scripts/secret-scan.mjs` still pass.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the transport, redaction, credential and guard seams every command sits on.

**⚠️ CRITICAL**: no user story may begin until this phase completes. T011/T012 in particular gate every
write in the feature — with a credential that can reach other repositories by design, that guard is the
only thing keeping writes here.

- [x] T003 [P] Write endpoint-derivation tests (scheme, host **and port**, owner, repo; ssh and https
      forms; with and without `.git`; unparseable remote) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-007 · [research.md](./research.md) D1

  **Scenarios covered**:
  - US2-AC1: the tool addresses the right repository at all (every command depends on this)
  - FR-007: the base is derived at runtime, never from a literal

  Imports `forgeEndpoint` from `../ci-status.mjs`. The port case is the one that matters: a remote of
  `http://host:3000/owner/repo.git` must yield base `http://host:3000/api/v1`. Phase 0 built the base
  from `FORGE_REGISTRY_HOST` (no port) and every call failed as `TypeError: fetch failed`, which reads
  exactly like an unreachable forge — this test is what stops that from recurring.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "endpoint"`

  **Expected RED**: file/import failure — `SyntaxError: The requested module '../ci-status.mjs' does not
  provide an export named 'forgeEndpoint'`.

- [x] T004 Export `forgeEndpoint()` from [scripts/ci-status.mjs](../../scripts/ci-status.mjs)

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T003 (FR-007)

  **Prerequisite**: T003 verified RED.

  Add `export` to the existing module-private `forgeEndpoint()`. No behaviour change — one derivation,
  one place to fix the port trap. Do not duplicate it into `backlog.mjs`.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "endpoint"`
  → 0 failures.

  **Also run the touched suite**: `node --test scripts/__tests__/ci-status.test.mjs` → previously
  passing tests still pass (this edits a file with 44 KB of existing tests).

- [x] T005 [P] Write output-redaction tests (every emit path; host **and port** collapse to `<forge>`;
      control characters stripped) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-007, SC-004 · US4-AC4

  **Scenarios covered**:
  - US4-AC4: no output line contains the forge host

  Drives the module's `emit`/renderer seam with a line containing a realistic remote URL and asserts the
  host is absent from the result. Verified in Phase 0 that `redactForPublication` is pattern-based and
  needs no environment variable, so this test is offline and deterministic.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "redact"`

  **Expected RED**: `Cannot find module '../backlog.mjs'`.

- [x] T006 Create [scripts/backlog.mjs](../../scripts/backlog.mjs) with the single redacted emit path

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T005 (FR-007, SC-004)

  **Prerequisite**: T005 verified RED.

  Import `redactForPublication` from `./ci-digest-redact.mjs` and `stripControlChars` from
  `./ci-status.mjs`; define one `emit()` that applies both, and route **all** output through it. Zero
  runtime dependencies — no package.json change.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "redact"`
  → 0 failures.

- [x] T007 [P] Write credential-selection tests (write requires the issue token; reads prefer it and
      fall back; absent/empty/whitespace-only handled) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-005 · [research.md](./research.md) D6

  **Scenarios covered**:
  - US4-AC2: reads succeed via the fallback; a write is refused naming the missing variable

  Injects an env object rather than reading the real environment, so the case runs identically in CI
  where neither token exists. Asserts `describeMissingWriteToken()` names `MCM_FORGE_ISSUE_TOKEN`, states
  writes are unavailable, and gives the remedy.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "credential"`

  **Expected RED**: 3 failing — no export named `selectToken` / `describeMissingWriteToken`.

- [x] T008 Implement `selectToken(env, {write})` and `describeMissingWriteToken()` in
      `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T007 (FR-005)

  **Prerequisite**: T007 verified RED.

  No literal, no default, no fallback value for the token itself. Treat whitespace-only as absent.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "credential"`
  → 0 failures.

- [x] T009 [P] Write scope-failure tests (401/403 → names the token used **and** the missing permission,
      says granular-scope-not-expiry, never retries) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-006, SC-003 · US4-AC3

  **Scenarios covered**:
  - US4-AC3: the refusal names which credential was used and which permission is missing

  Table-driven over endpoint families (`issues`, `issues/{n}/comments`, `labels`, `dependencies`) × token
  name, mirroring `describeAuthFailure()` in `ci-status.mjs`. Assert the message contains the token
  variable name — a message naming only the scope leaves the reader guessing which of two tokens failed.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "scope failure"`

  **Expected RED**: 4+ failing — no export named `describeScopeFailure`.

- [x] T010 Implement `describeScopeFailure(status, endpoint, tokenName)` in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T009 (FR-006, SC-003)

  **Prerequisite**: T009 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "scope failure"`
  → 0 failures.

- [x] T011 [P] Write same-repository guard tests (mismatched owner, mismatched repo, case difference,
      matching pair) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: **Medium** — this is the feature's blast-radius bound

  **Spec reference**: FR-016 · US7-AC2

  **Scenarios covered**:
  - US7-AC2: a working copy pointing at another repository refuses and creates nothing

  Asserts `assertWriteTargetsOriginRepo` throws for any owner/repo that is not the one derived from the
  origin remote, and passes through for the matching pair. The write credential can reach items on other
  repositories by the operator's decision ([research.md](./research.md) D5), so this is the one test
  standing between a typo and someone else's tracker.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "same-repository"`

  **Expected RED**: 4 failing — no export named `assertWriteTargetsOriginRepo`.

- [x] T012 Implement `assertWriteTargetsOriginRepo(target, origin)` and call it from **every** write path
      in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Medium

  **Spec reference**: same as T011 (FR-016)

  **Prerequisite**: T011 verified RED.

  Called before the request is issued, on `create`, `update`, `comment`, `dep`, and the label/milestone
  setup writes — not only on the task fan-out.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "same-repository"`
  → 0 failures.

- [x] T013 [P] Write transport tests (timeout, non-2xx → typed error, 401/403 routed to
      `describeScopeFailure`, raw body never returned to a renderer) in
      `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-006, FR-008

  **Scenarios covered**:
  - US2-AC4: responses are distilled, never dumped as a raw payload

  Injects a `fetch` double. No network, no token — the same posture `ci-status.test.mjs` declares in its
  header.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "transport"`

  **Expected RED**: 4 failing — no export named `forgeRequest`.

- [x] T014 Implement `forgeRequest(path, {method, token, tokenName, body})` in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T013 (FR-006, FR-008)

  **Prerequisite**: T013 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "transport"`
  → 0 failures.

- [x] T015 Implement command dispatch and `--help` in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: None

  **Spec reference**: NFR-002, SC-009

  `--help` carries the long-form flag reference, the exit codes from
  [contracts/backlog-cli.md](./contracts/backlog-cli.md), and the measured API quirks — deliberately, so
  the skill stays inside its token budget. Exit codes: 0 ok, 1 unexpected, 2 usage/validation, 3 missing
  credential, 4 authorization, 5 transport.

  **Done when**: `node scripts/backlog.mjs --help` prints the full surface and exits 0; an unknown
  command exits 2.

**Checkpoint**: transport, redaction, credentials and the write guard are proven. User stories may begin.

---

## Phase 3: User Story 2 - Ask what to work on next (Priority: P1)

**Goal**: the backlog becomes readable — list, show, and a single ready-work answer.

**Independent Test**: against the live tracker with only the read token, `list` shows backlog items and
no pull requests; `show 29` renders Renovate's dashboard item; `ready` returns open unblocked items in
priority order.

**Why this precedes User Story 1** (both P1): `create` cannot be built first. It must resolve label names
against the repository's label list and check for a duplicate open item — both reads. US2 is the
substrate, and it is independently valuable and testable on its own against the one item that already
exists.

- [x] T016 [P] [US2] Write listing-query tests (`type=issues` always present; `page`+`limit` always
      paired; limit clamped to 50; state and `q` passthrough) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-008 · US2-AC3 · [research.md](./research.md) D2

  **Scenarios covered**:
  - US2-AC3: only backlog items appear; change proposals are never mixed in
  - US2-AC2: page size is bounded

  Assert `type=issues` is present for every input combination — measured Phase 0: omitting it returns 143
  rows where 1 is correct, so a listing without it is ~99% pull requests. Assert `limit=200` is clamped
  to the measured cap of 50.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "listing query"`

  **Expected RED**: 5+ failing — no export named `buildIssueQuery`.

- [x] T017 [US2] Implement `buildIssueQuery({state, labels, milestone, q, page, limit})` in
      `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T016 (FR-008)

  **Prerequisite**: T016 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "listing query"`
  → 0 failures.

- [x] T018 [P] [US2] Write total/truncation tests (total from `x-total-count`; never from row count;
      absent header on single-item responses; explicit truncation line) in
      `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-008 · US2-AC2

  **Scenarios covered**:
  - US2-AC2: the result set is complete, or truncation is reported with the authoritative total

  Includes the trap case: 50 rows returned with `x-total-count: 142` must produce a truncation notice,
  not a silent "50 items".

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "total"`

  **Expected RED**: 4 failing — no exports named `readTotalCount` / `describeTruncation`.

- [x] T019 [US2] Implement `readTotalCount(headers)` and `describeTruncation(total, rows)` in
      `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T018 (FR-008)

  **Prerequisite**: T018 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "total"`
  → 0 failures.

- [x] T020 [P] [US2] Write name-resolution tests (unknown label → error quoting the name and listing
      valid values; unknown milestone likewise; known names pass through) in
      `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: **Medium** — guards a measured fail-open API behaviour

  **Spec reference**: FR-012 · [research.md](./research.md) D3

  **Scenarios covered**:
  - US2-AC1: a label filter narrows the result set rather than silently returning everything

  Phase 0 measured that `labels=<unknown-name>` is **silently ignored server-side and returns the
  unfiltered set** — a typo'd filter reads as "matched everything". The name must therefore be rejected
  locally, before the request. Assert the error text contains the offending name; a generic "invalid
  label" leaves the operator hunting.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "resolve names"`

  **Expected RED**: 5 failing — no export named `resolveNames`.

- [x] T021 [US2] Implement `resolveNames(requested, available)` and call it before any filter or label
      write in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Medium

  **Spec reference**: same as T020 (FR-012)

  **Prerequisite**: T020 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "resolve names"`
  → 0 failures.

- [x] T022 [P] [US2] Write ready-selection tests (bot-managed excluded; blocked excluded; unresolved
      blocker excluded; label/graph disagreement warned; priority then number ordering) in
      `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-011 · US2-AC1, US5-AC3 · [data-model.md](./data-model.md) *Ready-work selection*

  **Scenarios covered**:
  - US2-AC1: only open, unblocked items, ordered by priority
  - US5-AC3: an item with a recorded blocker is excluded

  Pure function over `(items, blockersByNumber)` — no network. The disagreement case is explicit: a
  `status/blocked` label with no blocking edge, and an unlabelled item with one, must each produce a
  warning naming the item, and the graph must win.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "ready"`

  **Expected RED**: 6 failing — no export named `selectReadyItems`.

- [x] T023 [US2] Implement `selectReadyItems(items, blockersByNumber)` in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T022 (FR-011)

  **Prerequisite**: T022 verified RED.

  Dependency reads are concurrency-capped at 4 and skipped for items already excluded by label — the
  cheap path stays one call.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "ready"`
  → 0 failures.

- [x] T024 [P] [US2] Write item-distillation tests (title, state, labels, milestone, blockers, blocked
      items, body, comments; raw payload keys absent from output) in
      `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-008 · US2-AC4

  **Scenarios covered**:
  - US2-AC4: labels, milestone, dependencies and comments are all reported, distilled

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "distill"`

  **Expected RED**: 3 failing — no export named `distillItem`.

- [x] T025 [US2] Implement `distillItem(item, {comments, blockers, blocks})` and the `--json` curated
      subset in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T024 (FR-008)

  **Prerequisite**: T024 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "distill"`
  → 0 failures.

- [x] T026 [US2] Wire the `list`, `show` and `ready` commands in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: FR-001 (read half of the CRUD surface), FR-011

  **Done when**: all three run end-to-end against the live tracker using the read path only.

- [x] T027 [US2] Live read verification per [quickstart.md](./quickstart.md) §3

  **Type**: Operational | **Risk**: Low

  **Spec reference**: US2-AC1…AC4, SC-004, SC-007

  **Done when**: `list --state all` shows backlog items and **no pull requests** (today: item #29 alone);
  a truncated listing prints the authoritative total; `show 29` renders the dashboard item; `ready`
  runs; and no output line contains the forge host. Record the observed output in this task — a green
  exit is not the evidence, the content is.

**Checkpoint**: the backlog is readable and the ready query answers. US1 can now be built on it.

---

## Phase 4: User Story 1 - File a backlog item without a human in the middle (Priority: P1) 🎯 MVP

**Goal**: the assistant files a structured, labelled item on the tracker in the same turn, with no
operator relay and no commit/branch/PR/CI run.

**Independent Test**: ask the assistant to file a described item; verify it exists with the expected
title, labels and body sections; verify the operator sees it in the web UI; verify the repository state
is untouched.

- [x] T028 [P] [US1] Write body-input tests (file path, stdin, missing file refused, size cap enforced,
      no argv path exists) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-009 · US1-AC2

  **Scenarios covered**:
  - US1-AC2: the body arrives intact and is never exposed where shell history or a process listing could
    capture it

  Includes a negative assertion that no `--body` flag is accepted — the absence of the argv path is the
  requirement, so it is asserted rather than assumed.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "body input"`

  **Expected RED**: 5 failing — no export named `readBodyFrom`.

- [x] T029 [US1] Implement `readBodyFrom(pathOrDash)` with a 64 KB cap in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T028 (FR-009)

  **Prerequisite**: T028 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "body input"`
  → 0 failures.

- [x] T030 [P] [US1] Write duplicate-detection tests (close title match on an open item reported instead
      of filing; closed items ignored; `--allow-duplicate` overrides) in
      `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: spec.md Edge Cases (duplicate filing)

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "duplicate"`

  **Expected RED**: 3 failing — no export named `findDuplicateOpenItem`.

- [x] T031 [US1] Implement `findDuplicateOpenItem(title, openItems)` in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T030 (spec.md Edge Cases — duplicate filing)

  **Prerequisite**: T030 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "duplicate"`
  → 0 failures.

- [x] T032 [US1] Wire the `create` command in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Medium

  **Spec reference**: FR-001 (create), FR-016

  **Prerequisite**: T012 (same-repository guard), T021 (name resolution), T029 (body input).

  Validates the title, resolves every label and milestone name, asserts the target repository, checks for
  a duplicate, then `POST`s and prints the assigned number.

  **Done when**: `create` refuses on an unknown label, refuses on a repository mismatch, and otherwise
  prints a number.

- [x] T032a [P] [US1] Write idempotent-setup and form-validation tests (`planMissingNames`: nothing to do
      when all exist, only the gap when some exist, everything on an empty repository, never queues an
      existing entry for overwrite; `describeFormValidation`: valid, invalid, and the absent-on-default-
      branch caveat) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-012, FR-013, FR-014

  **Scenarios covered**:
  - US1-AC1: an item can be filed with a type and priority label — which requires those labels to exist
  - US1-AC4: the operator's web-UI form and the assistant's filing share structure

  The overwrite case is the one that matters: the operator may have adjusted a label's colour or
  description in the web UI, and a setup command that re-creates rather than skips would silently revert
  it. The `describeFormValidation` absent case must state the default-branch caveat, so "not merged yet"
  never reads as "the form is broken".

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "setup"`

  **Expected RED**: 6 failing — no exports named `planMissingNames` / `describeFormValidation`.

- [x] T032b [US1] Implement `planMissingNames(desired, existing)` and
      `describeFormValidation({valid, message})` in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T032a

  **Prerequisite**: T032a verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "setup"`
  → 0 failures.

- [x] T032c [US1] Wire the `setup-labels`, `setup-milestone` and `validate-form` commands in
      `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: FR-012, FR-013, FR-014 ·
  [contracts/backlog-cli.md](./contracts/backlog-cli.md)

  **Prerequisite**: T032b, and T012 (all three write paths go through the same-repository guard, except
  `validate-form` which is read-only).

  `setup-milestone` exists because `resolveNames` refuses an unknown milestone name: with zero milestones
  defined, every `--milestone` value is unknown until something creates one, so `create --milestone` and
  the Phase 9 fan-out are both unusable without it.

  **Done when**: `setup-labels --dry-run` lists the missing labels and writes nothing; a second
  `setup-labels` run reports all present and creates nothing; `setup-milestone` is likewise idempotent.

- [x] T033 [US1] Create the label taxonomy on the repository with `backlog.mjs setup-labels`

  **Type**: Operational | **Risk**: Low

  **Spec reference**: FR-012 · [data-model.md](./data-model.md) *Label*

  **Prerequisite**: T032c.

  The repository defines **zero** labels today (measured), so nothing is reconciled: create
  `type/bug`, `type/feature`, `type/tech-debt`, `type/chore`, `priority/p1`–`p3`, `status/blocked`,
  `status/needs-spec`, `status/bot-managed`.

  **Done when**: `GET /labels` returns all 10 (measured: the taxonomy is ten labels, not eleven), a second run creates nothing, and `list --label
  type/chore` no longer returns the unfiltered set (the D3 fail-open behaviour is now backed by real
  labels).

- [x] T033a [US1] Create this feature's milestone with `backlog.mjs setup-milestone`

  **Type**: Operational | **Risk**: Low

  **Spec reference**: FR-014

  **Prerequisite**: T032c.

  Zero milestones exist today (measured). Create `049-forgejo-issue-tracking` as the first instance of the
  `NNN-slug` convention — the Phase 9 fan-out milestones its items to a feature and cannot run until at
  least one milestone exists.

  **Done when**: `GET /milestones` returns it, `create --milestone 049-forgejo-issue-tracking` succeeds,
  and `list --milestone 049-forgejo-issue-tracking` narrows the result set.

- [x] T033b [US1] Verify an unmilestoned item is valid — the free backlog

  **Type**: Operational | **Risk**: Low

  **Spec reference**: FR-014

  FR-014 has two halves, and only the first is obvious. Filing without `--milestone` must succeed and the
  item must be listable, because unmilestoned items *are* the free backlog — the normal case, not a
  degraded one.

  **Done when**: an item created with no `--milestone` exists, `show` reports its milestone as none, and
  it appears in both `list` and `ready`.

- [x] T034 [US1] Label Renovate's item #29 `status/bot-managed`

  **Type**: Operational | **Risk**: Low

  **Spec reference**: [research.md](./research.md) D4 · US2-AC1

  **Done when**: `show 29` reports the label and `ready` excludes it. Renovate rewrites that item's body
  on its own schedule; nothing in this feature ever edits or closes it.

- [x] T035 [P] [US1] Create the issue form at
      [.forgejo/issue_template/backlog-item.yaml](../../.forgejo/issue_template/backlog-item.yaml)

  **Type**: Config | **Risk**: Low

  **Spec reference**: FR-013, SC-011 · US1-AC4

  Four required sections — context, acceptance criteria, affected components, discovered-during — plus
  type and priority dropdowns, so a web-UI filing lands with the same taxonomy an assistant filing uses.

  **Done when**: the file parses as YAML locally and the four sections plus both dropdowns are present.

- [x] T036 [US1] Live create verification, including the untouched-repository assertion

  **Type**: Operational | **Risk**: Medium

  **Spec reference**: US1-AC1…AC3, FR-002, SC-002

  **Done when**: an item is created and its number reported; the operator confirms it in the web UI; a
  multi-line markdown body round-trips intact; and `git status --short` plus `git log --oneline -1` are
  unchanged, with no new branch, pull request or pipeline run. Record the before/after of the git checks
  in this task.

- [ ] T037 [US1] Validate the issue form with `backlog.mjs validate-form` — **after merge to the default
      branch**

  **Type**: Operational | **Risk**: Low

  **Spec reference**: FR-013 · [research.md](./research.md) D8

  **Prerequisite**: T032c, T035.

  The forge reads issue templates from the default branch only, so this cannot pass from the feature
  branch. That is a property of the forge, not a failure — and `validate-form` says so in its output
  rather than leaving the reader to conclude the form is broken.

  **Done when**: `node scripts/backlog.mjs validate-form` reports valid, and the New Issue page in the web
  UI offers the backlog-item form.

**Checkpoint**: MVP. Work discovered mid-session stops falling on the floor.

---

## Phase 5: User Story 3 - Update and close against verified criteria (Priority: P1)

**Goal**: items can be progressed and resolved — comment, relabel, edit, close — with closure gated on
verified acceptance criteria and a distinct refusal when the item is blocked.

**Independent Test**: against an open item, add a comment, add and remove a label, edit the body, close
it; separately, attempt to close a blocked item and confirm the refusal is distinct.

- [x] T038 [US3] Capture the live blocked-close response as a test fixture in
      `scripts/__tests__/fixtures/backlog/`

  **Type**: Operational | **Risk**: Low — but it **gates** T039

  **Spec reference**: FR-010 · [research.md](./research.md) open risk 2

  The status code and message shape for "cannot close a blocked item" were **not observed** in Phase 0
  (it needs two items and a dependency edge, i.e. a write). Create two throwaway items, link them, and
  attempt the close using raw HTTP — the `dep` command does not exist yet, so do not wait for it. Save
  the verbatim response.

  **Clean up before finishing.** The probe items live in the operator's real backlog — the artefact this
  feature delivers. Remove the dependency edge, close both items, and label them `type/chore` so they read
  as deliberate rather than as stray noise in the tracker the operator is about to start reviewing.

  **Done when**: the captured status and body are committed as a fixture, the observed shape is written
  into this task, **and** `list --state open` shows no leftover probe items. Writing the classifier against
  a guess is what this task exists to prevent.

- [x] T039 [US3] Write update-failure classification tests from the captured fixture in
      `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-010 · US3-AC3

  **Scenarios covered**:
  - US3-AC3: the refusal is surfaced distinctly as blocked-unblock-first, not as a generic failure, and
    the item stays open

  **Prerequisite**: T038 complete — the fixture is the input.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "update failure"`

  **Expected RED**: 3 failing — no export named `classifyUpdateFailure`.

- [x] T040 [US3] Implement `classifyUpdateFailure(status, body)` in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T039 (FR-010)

  **Prerequisite**: T039 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "update failure"`
  → 0 failures.

- [x] T041 [P] [US3] Write concurrent-divergence tests (the item changed on the forge since it was read
      → surfaced, not overwritten) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: spec.md Edge Cases (operator edits between read and write) · US3-AC2

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "divergence"`

  **Expected RED**: 2 failing — no export named `describeDivergence`.

- [x] T042 [US3] Implement divergence detection (compare `updated_at` between read and write) in
      `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T041 (spec.md Edge Cases — concurrent divergence)

  **Prerequisite**: T041 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "divergence"`
  → 0 failures.

- [x] T043 [US3] Wire the `update` and `comment` commands in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Medium

  **Spec reference**: FR-001 (update, close, comment), FR-010

  Close is `--state closed` on `update`; there is no separate close verb. Label removal resolves a name
  to a label id first (the API deletes by id). No command accepts a set of item numbers — one item per
  invocation, by design.

  **Done when**: comment, label add/remove, title/body edit and close each apply and report.

- [x] T044 [US3] Live write verification — **both halves** — per [quickstart.md](./quickstart.md) §5

  **Type**: Operational | **Risk**: Medium

  **Spec reference**: US3-AC1…AC3, **FR-004**, FR-006, SC-003, SC-008 ·
  [research.md](./research.md) open risks 1, 4

  **Done when**: comment 201, label changes applied, close 200, and the blocked-close refusal reported
  distinctly with the item left open — **and** the negative half passes: the same writes under
  `MCM_FORGE_TOKEN` return **403**, reported as a named token plus missing permission with the
  granular-scope-not-expiry note, and nothing is created. Without the negative half the scope split is
  asserted rather than proven, and no endpoint this credential can reach reports its own scopes.

  **This negative half is also the only check of FR-004** — that the read-only diagnostics token has not
  been widened to write. State the result explicitly as such when recording it: a negative requirement
  whose check is unlabelled is the kind that regresses unnoticed, and this token is load-bearing for CI
  diagnostics. Record all four write verbs' status codes under the read token, not just one.

**Checkpoint**: full item lifecycle. All three P1 stories are complete.

---

## Phase 6: User Story 4 - Know instantly when writes are unavailable (Priority: P2)

**Goal**: a missing or under-permissioned credential, or an unreachable forge, says exactly what is wrong
instead of appearing to work.

**Independent Test**: run with the write token unset — reads succeed, writes are refused by name, and the
container still starts. Then point at an unreachable base and confirm the failure is not reported as an
authorization problem.

- [x] T045 [P] [US4] Write read-only degradation tests (write token unset/empty → reads via the fallback,
      writes refused naming the variable, exit code 3) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-005 · US4-AC2

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "degradation"`

  **Expected RED**: 3 failing — writes currently throw a generic error rather than the named refusal.

- [x] T046 [US4] Implement the read-only degradation path in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T045 (FR-005)

  **Prerequisite**: T045 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "degradation"`
  → 0 failures.

- [x] T047 [P] [US4] Write unreachable-forge tests (network error → transport failure distinct from
      authorization, exit code 5) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: spec.md Edge Cases (forge unreachable)

  Phase 0 produced this exact failure for a wrong reason — a portless base URL — and it read as a blocked
  firewall. The message must therefore distinguish "cannot reach the forge" from "the forge refused you",
  and should name the derived base so a portless or malformed base is visible immediately.

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "unreachable"`

  **Expected RED**: 2 failing — the network error surfaces as a bare `TypeError: fetch failed`.

- [x] T048 [US4] Implement unreachable-forge classification in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T047 (spec.md Edge Cases — forge unreachable)

  **Prerequisite**: T047 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "unreachable"`
  → 0 failures.

- [x] T049 [US4] Live degradation check with the write token removed from the environment

  **Type**: Operational | **Risk**: Low

  **Spec reference**: US4-AC2, SC-005

  **Done when**: `env -u MCM_FORGE_ISSUE_TOKEN node scripts/backlog.mjs list` succeeds via the fallback
  and `env -u MCM_FORGE_ISSUE_TOKEN node scripts/backlog.mjs create …` refuses naming the variable.

- [ ] T050 [US4] Confirm the container still starts with the variable empty

  **Type**: Operational | **Risk**: Low

  **Spec reference**: US4-AC1, SC-005

  **Done when**: with `MCM_FORGE_ISSUE_TOKEN` unset on the host, a container rebuild completes and the
  environment comes up — no backlog capability failure blocks startup. The variable resolving to empty is
  the documented silent-absence case, so it must be exercised rather than reasoned about.

**Checkpoint**: no failure mode in this feature is silent.

---

## Phase 7: User Story 5 - Encode ordering so "ready" means ready (Priority: P2)

**Goal**: blocking relationships are recorded and removable, and the ready query honours them.

**Independent Test**: link two items, confirm the blocked one is absent from `ready` and shows as blocked;
unlink or close the blocker and confirm it returns.

- [x] T051 [P] [US5] Write dependency-edge tests (add blocked-by, add blocks, remove, cycle refused
      before the call) in `scripts/__tests__/backlog.test.mjs`

  **Type**: Test | **Risk**: Low

  **Spec reference**: FR-011 · US5-AC1…AC3 · [data-model.md](./data-model.md) *Blocking relationship*

  **Verify RED**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "dependency"`

  **Expected RED**: 4 failing — no export named `planDependencyChange`.

- [x] T052 [US5] Implement `planDependencyChange()` with cycle refusal in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: same as T051 (FR-011)

  **Prerequisite**: T051 verified RED.

  **Verify GREEN**: `node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "dependency"`
  → 0 failures.

- [x] T053 [US5] Wire the `dep` command in `scripts/backlog.mjs`

  **Type**: Implementation | **Risk**: Low

  **Spec reference**: FR-001 (dependency-link), FR-011

  Dependency support is enabled on this repository (measured:
  `internal_tracker.enable_issue_dependencies: true`), and both `dependencies` (blockers) and `blocks`
  (the inverse) are readable.

  **Done when**: an edge can be added and removed, and `show` reports both directions.

- [x] T054 [US5] Live ordering verification

  **Type**: Operational | **Risk**: Low

  **Spec reference**: US5-AC1…AC3, SC-007

  **Done when**: the blocked item is absent from `ready`, visible as blocked in `show` and in the web UI;
  after removing the edge or closing the blocker it appears in `ready` again. Also confirm the
  label/graph disagreement warning fires when `status/blocked` is applied without an edge.

**Checkpoint**: "what can I work on next" is trustworthy, not just non-empty.

---

## Phase 8: User Story 6 - Move the workstation backlog into the tracker (Priority: P3)

**Goal**: the text file stops being the backlog.

**Independent Test**: every entry has exactly one corresponding item with type and priority labels and
the four body sections; the operator reviews and corrects in one pass; nothing dropped or duplicated.

- [ ] T055 [US6] Import the workstation backlog conversationally via `scripts/backlog.mjs create`

  **Type**: Operational | **Risk**: Medium

  **Spec reference**: US6-AC1, AC3, SC-006

  **Done when**: every entry exists as exactly one item with a type label, a priority label and the four
  sections; entries too large to implement directly carry `status/needs-spec`; and the entry → item-number
  mapping is reported. No bulk operation is used without an explicit instruction — item history lives
  outside version control and has no revert.

- [ ] T056 [US6] Operator review in the web UI, and taxonomy calibration

  **Type**: Operational | **Risk**: Low

  **Spec reference**: US6-AC2, SC-006, SC-011 · [research.md](./research.md) D9/OQ-2

  **Done when**: the operator confirms the imported set in one pass; any taxonomy change the real backlog
  demands is applied (the shipped set is a starting point, calibrated here rather than on paper); and an
  operator-filed item and an assistant-filed item are structurally indistinguishable.

- [ ] T057 [US6] Retire the workstation text file as a backlog source

  **Type**: Operational | **Risk**: None

  **Spec reference**: SC-006 — the single-source-of-truth half of the migration

  **Done when**: the file is no longer consulted, and the runbook says the tracker is the backlog. Two
  sources of truth is the failure this feature exists to end.

---

## Phase 9: User Story 7 - Fan a feature's task list into the backlog (Priority: P3)

**Goal**: optionally mirror a feature's task breakdown as dependency-ordered items, and never write to
another repository.

**Independent Test**: fan out a feature with an existing breakdown; verify one item per task, milestoned
and ordered; then point the working copy elsewhere and verify refusal.

- [x] T058 [US7] Rewrite [.claude/skills/speckit-taskstoissues/SKILL.md](../../.claude/skills/speckit-taskstoissues/SKILL.md)
      for the forge

  **Type**: Documentation | **Risk**: Low

  **Spec reference**: FR-016 · US7-AC1, AC3

  Replace the GitHub-URL gate and the GitHub MCP server dependency — both dead ends here — with the same
  remote derivation `backlog.mjs` uses, then one item per task via `create`, labelled and milestoned to
  the feature, with blocking edges reflecting task order. Retain the CAUTION in spirit: items are only
  ever created on the repository the remote points at. State that the in-feature breakdown remains the
  authoritative decomposition and the items are a mirror of it.

  **Done when**: the skill contains no GitHub gate and no MCP requirement, and names the milestone
  convention (`NNN-slug`).

- [ ] T059 [US7] Live fan-out verification on a real feature's breakdown

  **Type**: Operational | **Risk**: Low

  **Spec reference**: US7-AC1, AC3

  **Done when**: one item exists per task, each milestoned to the feature, with edges matching the task
  ordering; the breakdown file is unchanged.

- [x] T060 [US7] Verify the refusal path against a non-origin repository

  **Type**: Operational | **Risk**: Low

  **Spec reference**: US7-AC2, FR-016

  **Done when**: an attempt to target any other owner/repo refuses and creates nothing — confirmed by
  checking that the other repository's tracker gained no item. This is the client-side bound on a
  credential that can reach other repositories by design, so it is verified live, not only in the unit
  tier (T011).

---

## Phase 10: Polish & Cross-Cutting Concerns

- [x] T061 Write the skill at
      [.claude/skills/forgejo-issues/SKILL.md](../../.claude/skills/forgejo-issues/SKILL.md)

  **Type**: Documentation | **Risk**: Low

  **Spec reference**: FR-010, FR-015, SC-009, NFR-002

  Written **last**, so it records measured behaviour rather than predicted behaviour. Carries only what
  the tool cannot decide: when to file, when a close is legitimate (acceptance criteria in the body,
  verified), the taxonomy, the `status/needs-spec` bridge into the specification lifecycle, that the
  board UI is not authoritative and that treating it as such forks the state, that bulk operations need
  an explicit instruction, that bot-managed items are never touched, that item numbers share one sequence
  with pull requests (write `item #N`), and the measured quirk list. Long-form detail belongs in
  `--help`, not here.

  **Done when**: the body measures ≈1–2k tokens (state the measured figure), and every quirk in it cites
  a measurement rather than an assumption.

- [x] T062 [P] Re-measure the positive `labels=` filter behaviour and record it in the skill

  **Type**: Operational | **Risk**: Low

  **Spec reference**: FR-017 · [research.md](./research.md) D3 follow-up, open risk 3

  Only the unknown-name behaviour (silently unfiltered) is established. With real labels now defined,
  measure matching semantics for an existing label, comma-separation, and AND-vs-OR across multiple
  values.

  **Done when**: the observed behaviour is written into the skill. Behaviour measured on other endpoints
  does not transfer — that assumption is what D2 and D3 each corrected once already.

- [x] T063 [P] Write [docs/runbooks/backlog.md](../../docs/runbooks/backlog.md)

  **Type**: Documentation | **Risk**: Low

  **Spec reference**: FR-018, FR-019

  Credential provisioning (the permissions, how the value reaches the container, and the silent-empty
  failure mode where a host-set value is not picked up), the taxonomy, the milestone convention, and —
  stated plainly, not buried — that the write credential is account-wide by decision and that the
  tooling's same-repository guard is what keeps writes here. No credential value.

  **Done when**: the runbook exists, `node scripts/secret-scan.mjs` and
  `node scripts/check-topology-scrub.mjs` pass, and `node --test scripts/__tests__/relocated-docs-links.test.mjs`
  still passes.

- [x] T064 [P] Add the `MCM_FORGE_ISSUE_TOKEN` row to the env-var table in
      [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md)

  **Type**: Documentation | **Risk**: None

  **Spec reference**: FR-018 (how the value reaches the container)

  **Done when**: the row states the permissions, the read-only degradation, and links to
  `docs/runbooks/backlog.md`. It must agree with the corrected comment from T002 — two descriptions of
  one credential that disagree is worse than one.

- [x] T065 Add an openwiki concept for the backlog workflow

  **Type**: Documentation | **Risk**: Low

  **Spec reference**: spec.md Documentation Impact · `openwiki/INSTRUCTIONS.md` placement rules

  Per the placement rules, the concept cites `docs/runbooks/backlog.md` as its `resource`, so the detail
  lives in the runbook and the concept summarizes it. Add the index line to `CLAUDE.md`.

  **Done when**: `node scripts/check-openwiki-governance.mjs` and `node scripts/check-openwiki-okf.mjs`
  both pass. (The Nx-invariant correction this feature already made is complete and separate — see
  [plan.md](./plan.md) Complexity Tracking.)

- [x] T066 Run the full cheap gate set and confirm the measured test count

  **Type**: Operational | **Risk**: Low

  **Spec reference**: constitution TDD gate + FR-017 — the count is the check

  **Done when**: `pnpm nx preflight infrastructure-as-code` passes, and the reported
  `scripts/__tests__` total equals the T001 baseline plus the tests added by this feature. A total that
  merely "passes" without growing means the new file was not collected — the count is the check.

- [x] T067 Confirm token compression per the constitution's RTK requirement

  **Type**: Operational | **Risk**: None

  **Spec reference**: constitution Token Compression (RTK)

  **Done when**: `rtk gain` reports >80% compression after the runs above.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)** — no dependencies. T002 is independent of all code and can land first.
- **Phase 2 (Foundational)** — blocks every user story. T011/T012 additionally gate every write.
- **Phase 3 (US2, P1)** → **Phase 4 (US1, P1)**: a hard, deliberate ordering. `create` resolves label
  names and checks duplicates, both of which are reads.
- **Phase 5 (US3, P1)** — needs Phase 4 only for something to update; T038's fixture capture uses raw
  HTTP so it does not wait for Phase 7's `dep` command.
- **Phases 6 and 7 (US4, US5, P2)** — independent of each other; either may follow the P1 set.
- **Phase 8 (US6, P3)** — needs US1 and US3 in place; it is the end-to-end proof.
- **Phase 9 (US7, P3)** — needs US1; T060 depends on T012, and **T059 depends on T033a**: the fan-out
  milestones its items, and `resolveNames` refuses a milestone name that does not exist. Zero milestones
  exist today, so without T033a this phase cannot run at all — the gap `/speckit-analyze` found (U2).
- **Phase 10 (Polish)** — T061 and T062 deliberately last, so the skill records measurements.

### Deviation from strict priority order, stated

Both US1 and US2 are P1, and US2 is implemented first. This is not a re-prioritization: US2 is US1's
substrate. Each remains independently testable — US2 against the one item that already exists, US1 by
filing and reading back.

### Parallel opportunities

- **Phase 2**: T003, T005, T007, T009, T011, T013 are all `[P]` — separate exports, one shared test
  file, no ordering between them. Their paired implementations serialize only where they touch the same
  region of `backlog.mjs`.
- **Phase 3**: T016, T018, T020, T022, T024 in parallel.
- **Phase 4**: T028, T030, T032a, T035 in parallel. The setup chain then serializes:
  T032c → T033 → T033a → T033b, because each consumes the command or the convention the previous one
  created.
- **Phase 10**: T062, T063, T064 in parallel.
- Across phases: T002 (documentation) is parallel to all of Phase 2.

```bash
# Phase 2 test tasks, written together, each verified RED independently:
node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "endpoint"
node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "redact"
node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "credential"
node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "scope failure"
node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "same-repository"
node --test scripts/__tests__/backlog.test.mjs --test-name-pattern "transport"
```

---

## Implementation Strategy

### MVP

Phase 1 → Phase 2 → Phase 3 (US2) → Phase 4 (US1). At that point discovered work can be filed and read
back with no operator relay, which is the requirement the feature exists for. **Stop and validate**
against T027 and T036 before going further.

### Incremental delivery

1. Setup + Foundational → the seams are proven.
2. US2 → the backlog is readable (valuable immediately: item #29 already exists).
3. US1 → **MVP**: nothing discovered mid-session is lost.
4. US3 → items can be resolved, so the backlog stops only growing.
5. US4 + US5 → failures are loud; `ready` is trustworthy.
6. US6 → the workstation file is retired.
7. US7 → optional fan-out.
8. Polish → the skill records what was measured.

### Notes

- `[P]` = different exports/files, no dependency on an incomplete task.
- Unit tests stay offline, deterministic and token-free — inject `fetch` and `env`, never call the live
  forge from `scripts/__tests__`.
- Live verification tasks record their **observed output**, not just a green exit. A skipped or
  vacuous check reads as a pass, which is the failure class this repository has paid for repeatedly.
- No task creates a commit, branch, pull request or pipeline run as a side effect of a backlog operation
  (FR-002) — T036 asserts it explicitly.

---

## Completion Checklist

Before marking `049-forgejo-issue-tracking` complete, verify every success criterion in
[spec.md](./spec.md):

- [ ] **SC-001**: filing, reading, updating and closing each take zero operator copy-paste or
      hand-editing steps
- [ ] **SC-002**: zero commits, branches, change proposals and pipeline runs across the whole acceptance
      exercise
- [ ] **SC-003**: 100% of authorization failures name both the credential used and the permission missing
- [ ] **SC-004**: 100% of surfaced output is free of the forge host; zero committed artifacts contain it
- [ ] **SC-005**: with the write credential absent, the container starts, reads succeed, and the
      read-only condition is stated at the first backlog interaction
- [ ] **SC-006**: every workstation-backlog entry present exactly once, labelled, confirmed by the
      operator in one review pass
- [ ] **SC-007**: `ready` answers in one command and returns only open, unblocked items in priority order
- [ ] **SC-008**: 100% of blocked-close attempts refused with the cause named, item left open
- [ ] **SC-009**: the skill costs ≈≤2,000 tokens and loads only when the backlog is in use
- [ ] **SC-010**: zero new backup jobs, schedules or storage locations
- [ ] **SC-011**: an assistant-filed and an operator-filed item are structurally indistinguishable
- [ ] All test tasks used the TDD checkpoint format, with Verify RED confirmed **before** implementation
- [ ] `pnpm nx preflight infrastructure-as-code` — all cheap gates plus `scripts/__tests__` pass, and the
      test **count** grew as expected (T066)
- [ ] `node scripts/check-topology-scrub.mjs` · `node scripts/secret-scan.mjs` — clean
- [ ] `node scripts/check-openwiki-governance.mjs` · `node scripts/check-openwiki-okf.mjs` — clean
- [ ] `rtk gain` — >80% compression confirmed (run last; it measures the runs above)

**No E2E line — recorded as a deviation, not assumed away.** The canonical
[feature-validation-checklist](../../openwiki/invariants/feature-validation-checklist.md) calls
`pnpm nx e2e mcm-app` required for every feature and not skippable. This feature ships no client surface
and touches no service the Expo app calls, so the rule's stated rationale does not reach it — but the
omission is a deviation from a canonical invariant and belongs in
[plan.md](./plan.md) **Complexity Tracking**, where it is now the first row, with the alternative
(run it once, delete the row) stated. The live verification tasks (T027, T036, T044, T049, T054, T060) are
this feature's end-to-end proof against the real forge.
