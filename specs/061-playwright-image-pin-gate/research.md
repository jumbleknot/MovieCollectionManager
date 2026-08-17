# Phase 0 research — Playwright image-pin consistency gate

**Feature**: 061-playwright-image-pin-gate · **Date**: 2026-08-17 · **Spec**: [spec.md](./spec.md)

Everything below was **measured on this working copy at `main` @ `68a40784`**, not reasoned about
from documentation. Where a finding replaced an assumption, the assumption is recorded too — the
repository's own history (items #153, #184, #194) is a run of comments that stood in for checks, and
this file is deliberately not a fourth.

---

## R1 — Where the check lives

**Decision**: **Extend `scripts/check-toolchain-consistency.mjs`** with a `findPlaywrightPinDrift(root)`
function, wired into `findDrift()` alongside the existing `findNxPinDrift(root)`.

**Rationale**:

- The item names it as the obvious home, and the script's own header states its purpose as the class
  — *"one version, several files, a bump applied to a subset, invisible to review and obvious to a
  parser"*. The Playwright pair is a literal instance of that sentence.
- **`findNxPinDrift` is the precedent.** The script already absorbed a *second, differently-shaped*
  relation once. Its two original rules are a **floor** (`node-version` ≥ `engines.node`) and a
  **single-source** (`pnpm` matches `packageManager`); `nx` added a third shape — an **exact
  cross-file equality** between `package.json` and `nx.json`. Playwright is that same third shape,
  between `pnpm-lock.yaml` and `.forgejo/workflows/app-ci.yml`. Adding a fourth script for it would
  split one concept across two files.
- **Zero new CI wiring, which satisfies FR-002 and FR-007 for free.** [guardrails.yml:132-134](../../.forgejo/workflows/guardrails.yml#L132-L134)
  already runs this script `--selftest`-then-real inside the `naming` job. A new script would need a
  new step; extending needs none, and cannot be forgotten.
- **`node_modules` is available at that point** — measured: the `naming` job runs `corepack enable`
  then `pnpm install --frozen-lockfile` before any gate step. This matters because R2 chooses a
  dependency-backed parser.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| A new `scripts/check-playwright-pin.mjs` | Explicitly permitted by the item *only if wired into the same guardrails step*. It would duplicate the `--selftest` scaffold, the findings shape and the exit-code contract for one extra relation, and add a step someone can later drop. The `nx` precedent shows the existing script absorbs a new pair cleanly. |
| Fold it into `check-override-consistency.mjs` | That gate is about `pnpm-workspace.yaml` override key/value halves. Different files, different relation, no shared machinery. |

**Consequence to respect**: the script's success message enumerates what it proved
(`✓ toolchain-consistency gate passed (every Node pin satisfies engines.node; pnpm is
single-sourced; nx agrees with nx.json installation.version)`). It **must** be extended, or the gate
will claim less than it checked and a reader cannot tell the Playwright check ran.

---

## R2 — How the resolved `@playwright/test` version is read

**Decision**: Parse `pnpm-lock.yaml` with the **`yaml` package** and read the **keys of the
`packages:` map**, selecting those beginning with `@playwright/test@`. Require **exactly one**
distinct version; zero or many is a finding, never a silent pick.

**Measured**:

```
parse ms 327
lockfileVersion 9.0
top keys [ 'lockfileVersion', 'settings', 'overrides', 'importers', 'packages', 'snapshots' ]
packages hits  [ '@playwright/test@1.62.1' ]
snapshots hits [ '@playwright/test@1.62.1' ]
```

**Rationale**:

- **`package.json` is NOT the authority.** It declares `"@playwright/test": "^1.36.0"` — a range that
  did not change across the failure. The range was `^1.36.0` before and after the 1.60.0 → 1.62.1
  move; only the *resolution* moved. A gate reading the manifest would have passed the exact PR it
  exists to catch.
- **`yaml` is already a declared root devDependency** (`"yaml": "^2.9.0"`) and is imported by **15
  non-test gate scripts**, several of which run in this same `naming` job (`check-resource-naming`,
  `check-no-inline-secrets`, `check-prod-restart-policy`, `check-ci-digest-coverage`,
  `check-override-consistency`). Importing it here introduces no new dependency and no new risk.
- **327 ms is irrelevant** against SC-001's 30-second budget and the ~35-minute alternative.

**Alternative considered and rejected**: a line regex over the lockfile text, which would be ~5 ms
and dependency-free. Rejected because the lockfile contains **compound peer-suffixed keys** that
embed the package name inside another key — measured at [pnpm-lock.yaml:15801](../../pnpm-lock.yaml#L15801):

```
'@nx/playwright@22.7.8(@babel/traverse@…)(@playwright/test@1.62.1)(…)':
```

A naive `'@playwright/test@([^']+)'` matches **inside** that key. Correctness then depends on
anchoring to exactly two leading spaces and end-of-key — i.e. on the lockfile's indentation staying
put. `Object.keys(lock.packages)` is exact by construction and cannot be defeated by an indentation
change. Trading 320 ms for the removal of a whole class of parser bug is the right side of that
trade for a gate whose entire value is being trustworthy.

**Fallback**: read `packages` first, and if absent fall back to `snapshots`, so a lockfile-format
change degrades to a *finding* rather than to a vacuous pass (FR-004).

---

## R3 — How image-tag occurrences are discovered

**Decision**: Scan the **text** of `.forgejo/workflows/app-ci.yml` line by line for
`mcr.microsoft.com/playwright:v<version>-noble`, **skipping comment lines**, and return every match
with its line number. Fail if the count is **zero** (FR-004).

**Measured** — the current occurrences:

```
752:            mcr.microsoft.com/playwright:v1.62.1-noble \
777:            mcr.microsoft.com/playwright:v1.62.1-noble \
```

**Rationale**:

- **Scan, never a hardcoded count.** FR-003 requires a third occurrence added later to be covered
  automatically. `line 752 and line 777` in the source would be wrong the first time the workflow is
  edited.
- **Text scan, not YAML traversal.** The tag lives inside a multi-line `run:` **shell script**, not
  in a structured YAML field — a YAML parse would hand back one opaque string blob and the line
  numbers FR-005 requires would be lost. The existing `collectPins()` scans text for exactly this
  reason.
- **Comment immunity mirrors `collectPins()`**, which already skips `/^\s*#/` so that *"prose
  describing a past pin (there is plenty)"* is never read as a pin. `app-ci.yml` has heavy comment
  prose around the Playwright block ([line 706](../../.forgejo/workflows/app-ci.yml#L706) mentions
  Playwright without an image), and this feature's own spec text will add more elsewhere.
- **Scope stays on `app-ci.yml`.** The spec puts `specs/**` out of scope — those files contain the
  old `v1.60.0-noble` string as a point-in-time record, and scanning them would fail the gate on
  history. Naming one file, rather than reusing the directory-walking `PINNED_FILES`, is what keeps
  that boundary.

**The `-noble` suffix is part of the anchor, not incidental.** It is the OS variant that selects the
image; matching a bare `mcr.microsoft.com/playwright:v<x>` would also match a hypothetical `-jammy`
line and compare it as if interchangeable.

---

## R4 — Which datasource the Renovate customManager uses

**Decision**: **`datasourceTemplate: "npm"` with `depNameTemplate: "@playwright/test"`**, capturing
only the numeric version out of the tag.

**Rationale**:

- **It gives both halves ONE depName**, which is exactly the `nx` precedent: one name, two managers
  (`npm` and `custom.regex`), re-joined by a single `matchPackageNames` rule. With the `docker`
  datasource the halves would carry *different* names (`@playwright/test` vs
  `mcr.microsoft.com/playwright`) and the grouping rule would have to enumerate both.
- **The lockfile is the authority** (R2), and the npm datasource is that same version stream. The
  image tag becomes a follower of the runner version, which is the actual causal direction — the
  browser build must match the runner, not the reverse.
- **No `docker:pinDigests` interaction.** That preset is in `extends` and is datasource-scoped to
  `docker`; an npm-datasource dep is untouched, so the literal image string keeps its reviewable
  `v<x>-noble` form and **FR-014 holds** — [app-e2e-env.guard.test.mjs:48](../../scripts/__tests__/app-e2e-env.guard.test.mjs#L48)
  locates the invocation by `l.includes('mcr.microsoft.com/playwright')`, matching the registry and
  image path and **not** the version, so version movement is safe and digest injection would not be.
- **It sidesteps the `docker base images` group.** That rule matches `matchDatasources: ["docker"]`;
  an npm-datasource dep never enters it, so the tag cannot be grouped with Postgres and Keycloak
  instead of with its own npm twin.

**Alternative considered — `datasource: docker`, `depName: mcr.microsoft.com/playwright`**: versions
would come from the registry and so are guaranteed to *exist* as tags. Rejected for now on three
counts: it needs an `extractVersionTemplate` (`^v(?<version>\d+\.\d+\.\d+)-noble$`) because raw
tags are `v1.62.1-noble` and would never compare equal to a bare semver; it collides with
`docker:pinDigests`, which wants to rewrite the literal FR-014 depends on; and it splits the pair's
depName, complicating the grouping rule that is the whole point.

**Residual risk, accepted and named**: npm may publish `@playwright/test@X` before
`mcr.microsoft.com/playwright:vX-noble` exists, so the bot could propose a tag that 404s.
**This is acceptable because it fails LOUDLY** — `docker run` exits on `manifest unknown` and reds
the job — whereas the failure this feature exists to remove was silent (zero tests, no summary,
generic red). Trading a loud failure for a silent one is the entire point. Revisit only if a
publication lag actually bites.

---

## R5 — Where the packageRule goes, and what it must not match

**Decision**: Append a rule matching `matchManagers: ["npm", "custom.regex"]` and
`matchPackageNames: ["@playwright/test"]` with a `groupName`, **after** the two generic JS rules.
Carry **no `matchUpdateTypes`**, so it covers the major track too.

**Measured mechanism** — this is not new analysis; [renovate-workflow.guard.test.mjs:222-250](../../scripts/__tests__/renovate-workflow.guard.test.mjs#L222-L250)
already records it, verified against renovate@44's own `applyPackageRules`:

- `js patch/minor` and `js majors` both match `matchManagers: ["npm"]`.
- A customManager's manager is **`custom.regex`**, not `npm` (renovate@44's `ManagersMatcher` matches
  custom managers as `custom.${manager}`).
- **Later packageRules override earlier ones.** So a broad `npm` rule placed *after* a grouping rule
  pulls the npm half back out onto its own branch — which is precisely how the `nx` pair produced
  PR #141 (package.json only) and PR #193 (nx.json only).

**The trap the item warns about is already resolved in-repo and needs no `packageNameTemplate`.**
[renovate-workflow.guard.test.mjs:319-323](../../scripts/__tests__/renovate-workflow.guard.test.mjs#L319-L323)
records the verification: `fetch.js` normalises `dep.packageName ??= dep.depName` **before** applying
package rules, so `matchPackageNames` matching on the dep name is faithful. The item's caution
("absent ⇒ no match") is about a `packageName` that is absent *at rule-application time*, which this
normalisation prevents.

**Two things the rule must NOT do**:

1. **Must not match `@nx/playwright`.** Use the exact string `"@playwright/test"`, never a
   `/playwright/` regex — `@nx/playwright` is a member of `NX_FAMILY` and stealing it from the
   `nx monorepo` group would break the existing guard and split the Nx core from its plugins.
2. **Must not use a rule key the guard does not model.** `ruleMatches()` **throws** on any unknown
   key ([line 274-281](../../scripts/__tests__/renovate-workflow.guard.test.mjs#L274-L281)) — a
   deliberate design so the guard cannot silently stop asserting. The chosen keys
   (`description`, `matchManagers`, `matchPackageNames`, `groupName`, `automerge`) are all in its
   `known` set, so no extension of `ruleMatches()` is required.

**Ordering relative to the `nx` rule is free** — neither matches the other's names — but placing the
Playwright rule **last** keeps "the grouping rules live at the end, after the broad ones" readable as
a single invariant.

---

## R6 — How the bot half is verified BY RESULT (FR-011)

**Decision**: three layers, in increasing strength.

### 1. Config validity

```bash
npx --yes --package renovate@44 -- renovate-config-validator
```

Pinned to the **same major the CI job runs** (`npx --yes renovate@44`, [renovate.yml:139](../../.forgejo/workflows/renovate.yml#L139)).
Respects the item's trap: **with no arguments it reads the repository config**, which is what we
want to validate.

### 2. Extraction — MEASURED, and there is a real before/after

```bash
LOG_LEVEL=debug RENOVATE_PLATFORM=local RENOVATE_DRY_RUN=extract \
  npx --yes --package renovate@44 -- renovate
```

**This works offline against the working tree.** Measured just now: exit 0, ~3.1 s total
(`"splits": {"init": 590, "extract": 2519, "lookup": 0}`), `"requests": 0` — no network, no token, no
platform. It dumps every extracted dependency with its manager, `packageFile`, `depName` and
`currentValue`, including the existing `nx.json` customManager entry.

**The baseline proves the gap is real**, which makes the after-state meaningful rather than
decorative:

- `@playwright/test` **is** extracted, by the `npm` manager, at two `packageFile`s.
- `.forgejo/workflows/app-ci.yml` **is** matched — but *only* by the `github-actions` manager
  (`DEBUG: Matched 7 file(s) for manager github-actions: .forgejo/workflows/app-ci.yml, …`), which
  reads `uses:` and `container:`/`services:` images, **not** an image inside a `run:` shell block.
- Therefore the image tag is extracted by **nothing at all** today. The acceptance evidence is a
  `custom.regex` entry appearing for `packageFile: .forgejo/workflows/app-ci.yml` with
  `depName: @playwright/test` and `currentValue: 1.62.1`.

### 3. Grouping — the durable artifact is the guard test

Grouping cannot be fully proven by the offline extract run (`lookup: 0` — no versions are fetched, so
no branches are computed), and a `RENOVATE_DRY_RUN=full` pass needs network lookups across every
datasource plus a GitHub token for some (`"repoProblems": ["⚠️ WARN: GitHub token is required for
some dependencies"]`). A full dry run is therefore **best-effort corroboration, not the gate**.

The durable artifact is an extension to `renovate-workflow.guard.test.mjs` mirroring `NX_FAMILY`:
a `PLAYWRIGHT_PAIR` resolved through the file's own `resolvedGroupName()` across the `patch`,
`minor` and `major` tracks, plus a **control** that the new rule does not swallow `@nx/playwright` or
unrelated npm packages. That file deliberately models *this repository's own* `packageRules` and
excludes upstream presets, for the reason it states: relying on an external preset to hold a pair
together is what the `nx` fix replaced.

This is FR-012 as well as FR-011 — a later reorder that re-splits the halves then fails by name.

---

## R7 — Selftest design (FR-006)

**Decision**: extend the existing `selftest()` with cases over the new pure functions, driven by
in-memory fixture text rather than by mutating the repository.

The existing selftest asserts **behaviour of extracted pure functions** on literal strings
(`collectPins('        with: { node-version: 20, cache: pnpm }', 'x.yml')`). It never writes files.
Matching that shape keeps the gate hermetic and fast.

The cases that must exist, each mapping to a spec edge case:

| Case | Asserts |
|---|---|
| Matched pair → no finding | the gate can pass |
| **Mismatched pair → a finding** | **FR-006's core: the gate can FAIL** |
| One of two occurrences bumped → a finding | FR-003, the partial bump |
| Three occurrences, third drifted → a finding | scan-not-count |
| Zero occurrences → a finding | FR-004, no vacuous pass |
| Lockfile resolves zero versions → a finding | FR-004 |
| Lockfile resolves two versions → a finding | FR-004, never silently pick |
| A commented-out image line → not counted | R3 comment immunity |

The `--selftest` flag already exits 1 when any case fails, so "the demonstration stopped
demonstrating" is covered by the existing harness.

**Note on the arg parser**: `--selftest` is the only accepted flag; the usage comment also advertises
`--dir <d>`, which the parser rejects (`Unknown argument(s)`). That is pre-existing doc drift in a
file this feature touches. It is **not** in scope to fix, and is recorded here so the next reader
does not mistake it for something this feature introduced.

---

## R8 — Test placement and how the work is proven

**Decision**: unit tests go in `scripts/__tests__/check-toolchain-consistency.test.mjs` (existing, 248
lines); the bot-config assertions go in `scripts/__tests__/renovate-workflow.guard.test.mjs`
(existing, 428 lines). No new test file.

**Measured**: [guardrails.yml:159-160](../../.forgejo/workflows/guardrails.yml#L159-L160) runs
`node --test scripts/__tests__/*.test.mjs` in the same `naming` job, so both files already gate a
merge. Its own comment records that before feature 041 `scripts/__tests__` *"ran in NO workflow"* —
worth not re-creating by adding a file outside the glob. The glob is `*.test.mjs`, which both target
files match.

`scripts/preflight.mjs:40` also runs `check-toolchain-consistency` locally, so the extended gate is
exercised by the normal local pre-push path with no change.

---

## Open questions

**None.** All three areas that could have blocked were resolved by measurement rather than
assumption: the lockfile parse shape (R2), the offline extraction recipe and its baseline (R6), and
the `packageName`-normalisation trap that the existing guard had already settled (R5).
