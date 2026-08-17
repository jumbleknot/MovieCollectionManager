# Implementation Plan: Playwright image-pin consistency gate

**Branch**: `061-playwright-image-pin-gate` | **Date**: 2026-08-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/061-playwright-image-pin-gate/spec.md`, itself driven by
backlog item #204.

## Summary

Couple the two halves of the Playwright pin that are coupled in fact and uncoupled in the repository:
the `@playwright/test` version resolved in `pnpm-lock.yaml`, and the
`mcr.microsoft.com/playwright:v<x>-noble` image tag in `.forgejo/workflows/app-ci.yml`.

Two changes, in the order they pay off:

1. **Detection** — extend `scripts/check-toolchain-consistency.mjs` with a fourth pin relation,
   `findPlaywrightPinDrift()`, alongside the existing `findNxPinDrift()`. It reads the resolved
   version from the lockfile with the `yaml` parser, scans every non-comment image-tag occurrence in
   the workflow, and reports each disagreement with file, line and both versions. It rides the
   guardrails step that already runs this script `--selftest`-then-real, so it costs no new CI wiring
   and fails in ~1 s instead of ~35 min.
2. **Prevention** — a `customManagers` regex entry in `renovate.json` that extracts the image tag
   under `depName: @playwright/test` / `datasource: npm`, plus a `packageRules` entry matching
   **both** managers (`npm` and `custom.regex`), ordered **after** the generic JS rules so it wins,
   and carrying no `matchUpdateTypes` so it covers the major track. This is the `nx` mechanism
   applied to a second pair — and the repository's own history (PR #141, PR #193) records that
   extraction without grouping is a half-bump generator, so both halves are required.

Both are asserted by tests that already run in the `naming` guardrails job, and the bot half is
additionally verified by an offline Renovate extraction run whose **before** state is already
captured.

## Technical Context

**Language/Version**: Node.js ESM (`.mjs`), Node 24.18.0 locally; repo floor `engines.node >= 22.13`

**Primary Dependencies**: `yaml@^2.9.0` (existing root devDependency, already imported by 15 gate
scripts); `node:test` + `node:assert/strict` for tests; `renovate@44` via `npx` for verification only
— never a repository dependency

**Storage**: N/A — the gate is a pure file reader with no state

**Testing**: `node --test scripts/__tests__/*.test.mjs`, run by the `naming` job in
`guardrails.yml`; plus the script's own `--selftest` mode run in the same job

**Target Platform**: Linux CI runner and the Linux dev container; the findings' file paths are
POSIX-normalised via the existing `posixLocation()` so output is identical on Windows

**Project Type**: Repository tooling / CI gate — no application code, no service, no user-facing
surface

**Performance Goals**: gate completes in ~1 s (the lockfile parse dominates at ~327 ms measured);
budget is SC-001's 30 s, against the ~35 min the same drift previously took to surface

**Constraints**: offline and deterministic — no network call, no registry lookup, no clock
dependency. The gate asserts *internal agreement*, never "is there a newer version"; that is
Renovate's job and needs the network. This mirrors the script's existing stated boundary.

**Scale/Scope**: 2 image-tag occurrences today, discovered by scan so the count is not fixed; ~5
files touched; no runtime code paths affected

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — see the re-evaluation
at the end of this section.*

| Principle | Applies? | How this plan satisfies it |
|---|---|---|
| **Test-Driven Development (NON-NEGOTIABLE)** | **Yes** | Every behaviour lands test-first. `tasks.md` will carry the mandated **Verify RED** command with expected failure output for each test task, and a **Verify GREEN** command for each paired implementation task, per `docs/templates/feature-test-tasks-template.md`. The `--selftest` mode is an *additional* in-CI proof that the gate can fail; it does not replace the unit tests. |
| **Test Type Integrity (NON-NEGOTIABLE)** | Yes | Everything here is genuinely a **unit** test: pure functions over in-memory fixture strings and over the repository's own real config files. Nothing is mocked, because there is no external dependency to mock — no HTTP, no database, no identity provider. No test is placed under `tests/integration/`. |
| **Behavior-Descriptive Identifiers (NON-NEGOTIABLE)** | Yes | Exported symbols are named for behaviour — `findPlaywrightPinDrift`, `resolveLockfilePlaywrightVersion`, `collectPlaywrightImagePins`. No `FR-###`/`SC-###`/`US#` appears in any identifier; requirement provenance goes in a JSDoc comment, which is the constitution's one sanctioned WHAT-comment exception. |
| **Documentation** | Yes | FR-013 updates `docs/runbooks/devcontainer.md` and `docs/runbooks/e2e-testing.md` in the same change, not afterwards. Comments explain *why* (the measured failure, the manager-vs-datasource trap), never *what*. |
| **Technology Agnosticism in Specification** | Yes | `spec.md` names files because the files **are** the subject matter, but prescribes no parser, regex, exit-code plumbing or config shape. Every such decision lives here and in `research.md`. |
| **No Vibe Coding** | Yes | Every decision in `research.md` is measured on this working copy, with the command and its output recorded. Three would-be assumptions were replaced by measurement (lockfile shape, extraction recipe, the `packageName` normalisation). |
| **Nx as the universal task runner** | Partially | The repo-wide rule is to invoke work through Nx. These gates are invoked directly by `node` in `guardrails.yml` — the **pre-existing, unanimous convention** for every one of the ~10 gate scripts in that job, and for `node --test scripts/__tests__/*.test.mjs`. This plan follows the existing convention rather than introducing a one-off Nx target for a single gate; see Complexity Tracking. |
| Security / Logging & Monitoring / Auth / API-First / Clean Architecture / Rust / Frontend / AI Agents | **No** | No service, no request path, no credential, no user data, no runtime logging, no domain model. The gate reads two tracked files and exits 0 or 1. |

**Post-Phase-1 re-evaluation**: no violation introduced. The design adds one exported function group
to an existing script, one entry each to two existing config arrays, and test cases to two existing
test files. No new project, no new CI step, no new dependency, no new abstraction layer.

## Project Structure

### Documentation (this feature)

```text
specs/061-playwright-image-pin-gate/
├── spec.md                    # WHAT and WHY (complete)
├── plan.md                    # This file
├── research.md                # Phase 0 — R1..R8, all measured (complete)
├── data-model.md              # Phase 1 — the three entities and their validation rules
├── quickstart.md              # Phase 1 — runnable validation, incl. the deliberate-break drill
├── contracts/
│   ├── gate-cli.md            # The gate's CLI contract: args, exit codes, output shape
│   └── renovate-config.md     # The customManager + packageRule contract and its invariants
├── checklists/
│   └── requirements.md        # Spec quality checklist (complete)
└── tasks.md                   # Phase 2 — produced by /speckit-tasks, NOT by this command
```

### Source Code (repository root)

```text
scripts/
├── check-toolchain-consistency.mjs        # EXTENDED — adds the Playwright pin relation
├── preflight.mjs                          # unchanged; already runs the gate locally
└── __tests__/
    ├── check-toolchain-consistency.test.mjs   # EXTENDED — unit tests for the new relation
    └── renovate-workflow.guard.test.mjs       # EXTENDED — grouping + control assertions

renovate.json                              # EXTENDED — one customManager, one packageRule

.forgejo/workflows/
├── guardrails.yml                         # comment-only: the gate step's summary line
└── app-ci.yml                             # UNCHANGED — the pins already agree (v1.62.1-noble ×2)

docs/runbooks/
├── devcontainer.md                        # EXTENDED — name the enforcing gate
└── e2e-testing.md                         # EXTENDED — name the enforcing gate
```

**Structure Decision**: No new files. The feature is delivered by extending four existing files plus
two runbooks, because each already owns exactly this concern: `check-toolchain-consistency.mjs` owns
cross-file pin agreement (and already carries a second, differently-shaped relation in
`findNxPinDrift`), `renovate.json` owns bot proposal shape, and the two test files already gate both
in the `naming` job. Creating a fifth gate script and a new CI step would duplicate the `--selftest`
scaffold, the findings shape and the exit-code contract for one extra relation — and add a step that
can later be dropped. See `research.md` R1.

`app-ci.yml` is deliberately **not** edited: the pins currently agree, so this feature adds
enforcement without also repairing a live drift, and the new gate starts green for the right reason
(SC-007).

## Design

### The detection half

Three new exported functions in `check-toolchain-consistency.mjs`, composed by the existing
`findDrift()`:

- **`resolveLockfilePlaywrightVersion(root)`** — parses `pnpm-lock.yaml` with `yaml`, reads the keys
  of the `packages` map (falling back to `snapshots`), selects those prefixed `@playwright/test@`,
  and returns the single distinct version. Zero or several is an error condition, never a pick.
- **`collectPlaywrightImagePins(text, file)`** — line scan for
  `mcr.microsoft.com/playwright:v<version>-noble`, skipping comment lines, returning
  `{file, line, value}` per occurrence. Mirrors the existing `collectPins()` shape and reuses
  `posixLocation()`.
- **`findPlaywrightPinDrift(root)`** — composes the two, returns the repo-standard
  `{file, line, problem}[]`, and produces a finding when: the lockfile version cannot be uniquely
  resolved; zero occurrences are found; or any occurrence disagrees.

`findDrift()` gains one line — `findings.push(...findPlaywrightPinDrift(root))` — exactly as it does
for `findNxPinDrift(root)`. The success message is extended so the gate does not claim less than it
proved.

**Why the version comes from the lockfile and not `package.json`**: the manifest declares
`^1.36.0`, which did not change across the failure. Only the resolution moved. A manifest-reading
gate would have passed the very PR it exists to catch.

### The prevention half

```
customManagers:  regex over .forgejo/workflows/app-ci.yml
                 capture the numeric version out of `…/playwright:v<here>-noble`
                 depName @playwright/test · datasource npm

packageRules:    matchManagers ["npm", "custom.regex"]
                 matchPackageNames ["@playwright/test"]     ← exact, never /playwright/
                 groupName …                                 ← ordered LAST, no matchUpdateTypes
```

**Ordering is the whole mechanism, not a detail.** `js patch/minor` and `js majors` match
`matchManagers: ["npm"]`, a customManager's manager is `custom.regex`, and later rules override
earlier ones — so a grouping rule placed before them has the npm half pulled back out onto its own
branch. That is precisely how the `nx` pair produced PR #141 and PR #193, each moving one half.

**`@nx/playwright` must not be caught.** The rule matches the exact string `@playwright/test`. A
`/playwright/` regex would steal `@nx/playwright` from the `nx monorepo` group, break the existing
`NX_FAMILY` guard, and split the Nx core from its plugins — trading one skew for another.

**No `packageNameTemplate` is needed**: `fetch.js` normalises `dep.packageName ??= dep.depName`
before package rules are applied, which the existing guard records as verified.

### Test strategy

| Layer | File | Proves |
|---|---|---|
| Unit — pure functions | `check-toolchain-consistency.test.mjs` | matched pair passes; mismatched pair fails; partial bump fails; third occurrence covered; zero occurrences fails; zero/multiple lockfile resolutions fail; commented line ignored |
| In-CI self-proof | the script's `--selftest` | the gate demonstrably CAN fail, on every PR |
| Bot config | `renovate-workflow.guard.test.mjs` | both halves resolve to one group on patch/minor/major; the rule matches both managers; it is ordered last of those grouping Playwright; the customManager still targets `app-ci.yml`; **control** — it does not swallow `@nx/playwright` or unrelated npm packages |
| Real-tool | manual, recorded in `quickstart.md` | `renovate-config-validator` passes; the offline extraction run shows the tag extracted as `custom.regex` / `@playwright/test` / `1.62.1` |

The manual real-tool layer is verification **by result** (FR-011) and is the reason the before-state
extraction baseline was captured during research: the tag is currently extracted by *nothing*, so the
after-state is a genuine difference rather than a screenshot of the status quo.

## Risks

| Risk | Mitigation |
|---|---|
| npm publishes `@playwright/test@X` before `mcr…:vX-noble` exists, so the bot proposes a 404 tag | Accepted and named in `research.md` R4. It fails **loudly** at `docker pull` (`manifest unknown`), which is the opposite of the silent zero-test run this feature removes. Revisit only if a lag actually bites. |
| A future `packageRules` reorder re-splits the halves | `renovate-workflow.guard.test.mjs` asserts the ordering and fails **by name** — FR-012, and the same protection the `nx` pair already has. |
| Adding a rule key the guard does not model silently disables its assertions | It cannot be silent: `ruleMatches()` **throws** on an unknown key by design. The chosen keys are all in its `known` set. |
| The lockfile format changes and the parse stops finding the package | FR-004 makes "found nothing" a **finding**, not a pass. A format change reds the gate rather than disarming it. |
| The gate is edited to pass rather than fixed at the cause | Repo rule: a guard that fails because you changed what it protects gets **updated at the cause, never deleted**. Recorded here so the next reader sees it before reaching for the delete key. |

## Complexity Tracking

Only one deviation from a repository-wide convention, and it is a deviation *toward* the local one.

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| The gate is invoked as `node scripts/…` in `guardrails.yml` rather than through an Nx target, despite the "Nx as the universal task runner" invariant | It follows the **unanimous existing convention** of that job: every gate script there (~10 of them, plus `node --test scripts/__tests__/*.test.mjs`) is invoked directly. This feature adds **no new step at all** — it extends a script an existing step already runs. | Introducing an Nx target for this one gate would make it the only gate invoked differently, leaving the other ten untouched — more inconsistency, not less. Converting all of them is a separate, larger change with its own justification, and is not this feature's scope. |
