# Handoff — 048 test-harness remediation, ready to implement

**Written**: 2026-08-07 · **Status**: spec → plan → tasks complete and analysed; **no implementation started**

The SDD gate is satisfied. [spec.md](./spec.md) (5 user stories, FR-001–FR-021, SC-001–SC-011),
[plan.md](./plan.md) and [tasks.md](./tasks.md) (44 tasks, all 22 acceptance scenarios cited) are
written and have been through `/speckit-analyze` with all CRITICAL/HIGH/MEDIUM findings remediated.

## Current state

- **Branch**: `048-test-harness-remediation`, cut from `docs/047-pr-b-handoff` at `31a5caf`.
- **Committed**: the spec set, in `a1c39c1` ("spec, plan, tasks") and `31a5caf` ("updated with new
  requirement").
- **Uncommitted** (the `/speckit-analyze` remediations — review and commit first):
  `.specify/feature.json`, `.specify/memory/constitution.md`, and all three 048 artifacts.
- **Only T001 is done** (the branch). T002 onward is open.

## Decided — implement, do not relitigate

| Decision | Where |
|---|---|
| Adopt the **full** golden pattern: `replay` in CI, `off` at the pre-deploy gate | PRD item 1 |
| Fix the two MCP tests **and** enrol them in CI. "Fix without enrolling" was explicitly rejected | PRD item 2 |
| The ~52 E2E flows **stay on live Anthropic** — decided 2026-08-07. No measurement gates this work | spec.md Assumptions |
| Quality checks gate at **merge or deploy, never on a timer** | FR-008 (owner constraint) |
| The golden tier is entered by **`@pytest.mark.golden`**, not by moving files | spec.md Assumptions |
| Four per-surface Anthropic secrets exist and are used | plan.md credential mapping |
| Constitution **v2.4.0** sanctions the golden tier's LLM substitution | constitution.md, Test Type Integrity |

## Mechanism facts — established by verification, not assumption

These cost real time to pin down. Trust them; re-verify only if something contradicts them.

- **The golden tier is a pytest MARKER, not a directory.** `nx test:golden` runs
  `uv run pytest tests/integration -m golden`; `tests/golden/` holds only cassettes, `dataset.json`
  and `compare.py`. **Moving a test into `tests/golden/` makes it run nowhere.** `app-ci` runs
  `-m "not golden"`, so the two selectors are complementary and exhaustive over `tests/integration/`
  — adding the marker enrols *and* deselects in one change.
- **The cassette seam is already in the call path.** `test_out_of_domain.py` builds its model via
  `build_chat_model(select_model_config("supervisor", …))`, which already honors `LLM_CASSETTE_MODE`.
- **`off` mode is already implemented** in `test_golden_pairs.py` (`replay`/`record`/`off` branches).
  Only an invoker is missing — `cd-deploy.yml` has no live-model gate at all.
- **Two skip-to-green paths exist and must be closed first** (Phase 2): `_supervisor_model()`'s blanket
  `except Exception → pytest.skip` swallows `CassetteMissError`, and `"no cassette"` is already in
  `_LEGITIMATE_SKIPS`, so a golden run with zero cassettes reports green today.
- **The workbook has 204 data rows** (205 incl. header) — verified with openpyxl. The parser
  (`rowCount = len(data_rows)`) is correct; the `== 200` literal is the defect.
- **`store._shared_client` is correct for production** (one long-lived server process). Fix the test
  fixture, never the singleton. `read_upload(handle, *, client=None)` already accepts injection.
- **The DAST leak check has THREE fail-open guards**, not one — `app-ci.yml:859/862/865`. An empty
  variable skips that scan and the step still exits 0.
- **`MODEL_PROVIDER` at `app-ci.yml:749` is overridable** (`inputs.provider || vars.MODEL_PROVIDER ||
  'anthropic'`), so an empty `ANTHROPIC_API_KEY` is *legitimate* under a non-Anthropic dispatch. A
  blanket "fail if empty" breaks that path — FR-019 requires failing on **unexpected** emptiness.

## Open items — need a decision or a measurement

1. **T007** — count how many of the 41 existing golden pairs lack a cassette. If 0, delete the
   `"no cassette"` whitelist entry; if not 0, scope it. **Measure before changing** — removing it
   wholesale could turn the existing gate red. If the count is non-zero, the existing golden gate has
   been partly decorative too, and that widens scope.
2. **T018** — whether the cd-deploy live gate is a `needs:` job or an in-job step before promotion.
3. **Constitution versioning** — v2.4.0 was applied as MINOR on the reasoning that it *scopes* an
   existing prohibition rather than reversing it. If the owner reads it as redefining a NON-NEGOTIABLE
   principle it should be v3.0.0. One-line change either way.
4. **`docs/047-pr-b-handoff` carries the 048 spec commits.** If a 047 docs PR is still planned from
   that branch, reset it to `1a114ec` first. Untouched so far.

## Work order

**MVP = Phases 2 → 3 → 4** (close skip paths → golden conversion → live gate). **US1 and US2 must
merge together**: US1 removes the live signal and US2 is what restores it at the deploy boundary.
Shipping US1 alone is the failure mode the PRD names explicitly.

Phases 5 (US3 — MCP), 5b (US4 — secrets) and 5c (US5 — leak check) are independent of everything and
of each other. **5b is the cheapest and can land first.** In 5c, T034 (extract the scan to
`scripts/dast-leak-scan.sh`) must come first — the logic is inline YAML with no local entry point, so
nothing after it is runnable until it is extracted.

## Environment traps in this dev container

- **`pwsh` is NOT installed** and `.specify/scripts/` is PowerShell-only, so every Spec Kit
  `check-prerequisites` call fails. Resolve paths from `.specify/feature.json` (now correctly pointing
  at 048) instead.
- **RTK filters bash output.** Ad-hoc `python -c "print(...)"` output was silently rewritten to `ok`
  mid-session. For anything whose exact output matters, **write to the scratchpad and `Read` the file**.
- **An empty search result is not proof of absence.** A `find … -name store.py` returned nothing, then
  found the file on a second attempt with a different invocation. Confirm with a second method.
- **Never `rg -rn` / `rg -ril`** — `-r` is `--replace` and silently eats the pattern.
- **`cd` persists between Bash calls.** A `cd` into a subdirectory broke several later relative paths
  and made real files look missing. Prefer absolute paths.
- **Credential reads are blocked** by the permission classifier — don't try to inspect key values.
- **`pnpm nx e2e mcm-app` cannot run here, but Playwright can** — official image, `--network host`,
  `--user "$(id -u):$(id -g)" -e HOME=/tmp`. See [e2e-testing.md](../../docs/runbooks/e2e-testing.md).
- **Both images are baked.** A client change needs `pnpm nx docker-build mcm-app`; an agent change
  needs `node scripts/agent-stack.mjs`. A stale image fails exactly like the bug you are hunting.

## How to work

- **Verify by RESULT, not exit status.** Watch the SKIP COUNT; set `MCM_REQUIRE_LIVE_STACK=1` and
  `E2E_REQUIRE_AGENT_STACK=1` — a skip otherwise reads as a pass.
- **A test that fails when you break it is SENSITIVE, not CORRECT.** T014, T024 and T038 exist purely
  to prove this, and they are not optional.
- **Verify RED is mandatory.** 0 failures on a Verify RED means the test is trivially passing and must
  be fixed before implementing.
- **Opening the PR**: push a REAL branch (`git push origin HEAD:048-test-harness-remediation`) then
  `POST …/pulls` with the **`git credential fill`** credential, not `MCM_FORGE_TOKEN`. An AGit push
  runs CI with **no** Actions secrets.

---

## Prompt for the fresh session

```text
Implement specs/048-test-harness-remediation/. Read specs/048-test-harness-remediation/HANDOFF.md
FIRST — it records the state, the decided items, the verified mechanism facts, and the traps. Then
read spec.md, plan.md and tasks.md in that order.

The SDD gate is already satisfied: spec → plan → tasks exist, were analysed, and all CRITICAL/HIGH/
MEDIUM findings are remediated. Do NOT re-spec. Do NOT relitigate the decisions listed in the handoff
(full golden pattern; fix the MCP tests AND enrol them in CI; E2E stays on live Anthropic; gates run
at merge or deploy, never on a timer).

FIRST ACTION: review and commit the five uncommitted files (.specify/feature.json,
.specify/memory/constitution.md, and the three 048 artifacts) — they are the /speckit-analyze
remediations, including constitution v2.4.0.

THEN: T002 (capture baselines by measurement, not assumption), then Phase 2 → 3 → 4 as the MVP.
US1 and US2 MUST merge together — US1 removes the live model signal and US2 is what restores it at the
deploy boundary. Phases 5 / 5b / 5c are independent; 5b is cheapest and can land first.

THE THREE FACTS MOST LIKELY TO WASTE YOUR TIME IF IGNORED:
  - The golden tier is a pytest MARKER, not a directory. `nx test:golden` runs
    `pytest tests/integration -m golden`. Moving a test into tests/golden/ makes it run NOWHERE.
  - Two skip-to-green paths must close BEFORE the cassette conversion, or "a missing cassette goes
    red" is unfalsifiable: _supervisor_model()'s blanket `except Exception -> pytest.skip`, and the
    "no cassette" entry already in _LEGITIMATE_SKIPS.
  - RTK rewrites bash output. If exact output matters, write to the scratchpad and Read the file.
    Also: `cd` persists between Bash calls, and an empty search result is NOT proof of absence.

HOW TO WORK:
  - Verify by RESULT, not exit status. Watch the SKIP COUNT. MCM_REQUIRE_LIVE_STACK=1 and
    E2E_REQUIRE_AGENT_STACK=1 turn a skip into a failure.
  - Verify RED is mandatory — 0 failures means the test is trivially passing and must be fixed first.
  - A test that fails when you break it is SENSITIVE, not CORRECT. T014/T024/T038 exist for this.
  - Never `rg -rn` / `rg -ril` (-r is --replace). Treat an empty result as unconfirmed.
  - pwsh is NOT installed — Spec Kit scripts are .ps1-only; resolve paths from .specify/feature.json.
  - `pnpm nx e2e mcm-app` cannot run here, but Playwright can (official image, --network host,
    --user "$(id -u):$(id -g)" -e HOME=/tmp). See docs/runbooks/e2e-testing.md.
  - Both images are baked: `pnpm nx docker-build mcm-app` / `node scripts/agent-stack.mjs`.

FOUR OPEN ITEMS need a decision or a measurement before their task — they are listed in the handoff.
T007 in particular is a MEASUREMENT (how many of the 41 golden pairs lack a cassette); if it is
non-zero, say so, because the existing golden gate is then partly decorative too and scope widens.

State your confidence and assumptions when you recommend something. If a strategy doc, the
constitution or a runbook covers the area, read it before advising.
```
