# Contract — the Renovate config change and its invariants

**Feature**: 061-playwright-image-pin-gate

`renovate.json` has no schema this repository can enforce beyond
`renovate-config-validator`, and its *semantics* — which rule wins, which manager a dep carries —
are not visible in the file at all. This contract states what the added entries must mean, so
`renovate-workflow.guard.test.mjs` can assert it and a later edit cannot quietly undo it.

---

## Addition 1 — `customManagers` entry

**Purpose**: make the image tag in `.forgejo/workflows/app-ci.yml` an updatable dependency. It is
currently updatable by nothing.

| Field | Required value | Why |
|---|---|---|
| `customType` | `regex` | Matches renovate@44's manager identity `custom.regex`, which the packageRule below must name. |
| `managerFilePatterns` | a pattern matching `.forgejo/workflows/app-ci.yml` | **Not `fileMatch`** — v41 renamed it, and a config using the old key *"does not fail loudly, it silently manages nothing"*. |
| `matchStrings` | captures `(?<currentValue>…)` out of `mcr.microsoft.com/playwright:v<here>-noble` | The `v` prefix and `-noble` suffix are anchors, not data. |
| `depNameTemplate` | `@playwright/test` | Gives both halves **one** name, so a single `matchPackageNames` re-joins them — the `nx` mechanism. |
| `datasourceTemplate` | `npm` | The lockfile is the authority, and npm is that same version stream. Also keeps the dep out of `docker:pinDigests` and out of the `docker base images` group. See `research.md` R4. |

**Must extract both occurrences.** The regex is applied repeatedly, not once — a partial extraction
would let the bot move one line and leave the other, which is the exact defect being prevented.

**No `packageNameTemplate` is required**: `fetch.js` normalises `dep.packageName ??= dep.depName`
before package rules are applied. The existing guard records this as verified against renovate@44,
which is why the item's "`matchPackageNames` keys on `packageName`" trap does not bite here.

---

## Addition 2 — `packageRules` entry

**Purpose**: put both halves in one group, so they cannot land apart.

| Field | Required value | Why |
|---|---|---|
| `matchManagers` | **must include both** `npm` and `custom.regex` | The lockfile half is `npm`; the workflow half is `custom.regex`. A rule naming only one groups one half and strands the other. |
| `matchPackageNames` | **exactly** `["@playwright/test"]` | Never a `/playwright/` regex — that would capture `@nx/playwright` and steal it from the `nx monorepo` group. |
| `matchUpdateTypes` | **absent** | The major track splits identically to patch/minor. Restricting update types lets at least one track fall through to the broad npm rules and half-bump — measured on the `nx` pair as `major-js-majors-(review-individually)` vs `major-nx-monorepo`. |
| `groupName` | any stable name | Its value does not matter; that **both halves resolve to the same one** does. |
| `automerge` | `false` | Nothing in this repository auto-merges. |

### Ordering — the load-bearing invariant

The rule **must come after** `js patch/minor` and `js majors`.

Both match `matchManagers: ["npm"]`; a customManager's manager is `custom.regex`; and **later
packageRules override earlier ones**. A grouping rule placed *before* them therefore has its npm half
pulled straight back out onto a separate branch — one group for the workflow tag, another for the
lockfile, two PRs, a half-bump. That is not hypothetical: it is how the `nx` pair produced PR #141
(package.json only) and PR #193 (nx.json only), *from the manager that existed to prevent it*.

### Keys the guard models

`ruleMatches()` in `renovate-workflow.guard.test.mjs` **throws** on any rule key it does not model —
deliberately, so the guard cannot silently stop asserting. The fields above are all in its `known`
set (`description`, `matchManagers`, `matchPackageNames`, `matchUpdateTypes`, `matchDatasources`,
`matchFileNames`, `groupName`, `automerge`, `enabled`, `minimumReleaseAge`), so **no extension of
`ruleMatches()` is needed**. Adding any other key requires extending it first.

---

## Invariants the guard test must assert

1. Both halves resolve to the **same** `groupName`, on the `patch`, `minor` **and** `major` tracks.
2. The **last** rule to group `@playwright/test` matches **both** managers.
3. That rule carries **no** `matchUpdateTypes`.
4. A `customManagers` entry with `depNameTemplate: "@playwright/test"` still exists and still targets
   `app-ci.yml` — the grouping rule is meaningless without the manager it re-joins.
5. **Control**: `@nx/playwright` still resolves to the `nx monorepo` group, and an unrelated npm
   package (e.g. `typescript`) does not resolve to the Playwright group. Without a control, widening
   the rule until everything shares one group would satisfy 1–4 while collapsing the config.

Invariants 2, 3 and 5 exist because assertion 1 alone can be satisfied by a *blanket* rule. The
existing `nx` tests make the same distinction, for the same reason.

---

## Verification by result (FR-011)

Configuration is not verified by reading it. Two commands, both recorded in `quickstart.md`:

```bash
# 1. Validity — pinned to the SAME major CI runs (`npx --yes renovate@44`).
#    With no arguments the validator reads the repository config, which is what we want.
npx --yes --package renovate@44 -- renovate-config-validator

# 2. Extraction — offline, no token, no platform. Measured: exit 0, ~3.1 s, 0 HTTP requests.
LOG_LEVEL=debug RENOVATE_PLATFORM=local RENOVATE_DRY_RUN=extract \
  npx --yes --package renovate@44 -- renovate
```

**The before-state is already captured**, which is what makes the after-state evidence rather than
decoration:

- `@playwright/test` is extracted by the `npm` manager at two `packageFile`s. ✔ already true
- `.forgejo/workflows/app-ci.yml` is matched **only** by the `github-actions` manager, which reads
  `uses:` and `container:`/`services:` images — **not** an image inside a `run:` shell block.
- So the image tag is extracted by **nothing**. ← the gap this feature closes

**Acceptance evidence**: a `custom.regex` entry appears in the extraction output with
`packageFile: .forgejo/workflows/app-ci.yml`, `depName: @playwright/test`, `currentValue: 1.62.1` —
and it appears **twice**, once per occurrence.

**What the extract run cannot prove**: grouping. It reports `lookup: 0` and `requests: 0` — no
versions are fetched, so no branches are computed. A `RENOVATE_DRY_RUN=full` pass needs network
lookups across every datasource and a GitHub token for some (`"repoProblems": ["⚠️ WARN: GitHub token
is required for some dependencies"]`), so it is **best-effort corroboration, not the gate**. The
durable proof of grouping is the guard test, which models this repository's own `packageRules` and
deliberately does not credit upstream presets — relying on an external preset to hold a pair together
is what the `nx` fix replaced.
