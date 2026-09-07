# Phase 0 Research: Python toolchain grouping

**Feature**: 067-python-toolchain-grouping | **Date**: 2026-09-07

Every finding below was measured in this working copy on 2026-09-07 unless it is explicitly labelled
**INFERENCE**. Two are so labelled. The instrument was renovate **44.69.3**, installed into a
scratch directory and run as `RENOVATE_PLATFORM=local RENOVATE_DRY_RUN=extract|lookup LOG_LEVEL=debug`
— the same recipe `renovate.json` and `docs/runbooks/renovate.md` §5 already cite for this class of
question.

---

## R1 — How many dependencies is the interpreter, and of what kind?

**Decision**: Four kinds of site, not the three the backlog item names.

| # | site | manager | depName | datasource | currentValue |
|---|---|---|---|---|---|
| 1 | `agents/movie-assistant/.python-version` | `pyenv` | `python` | **`docker`** | `3.13` |
| 8 | `FROM python:3.13-slim@sha256:…` in 4 Dockerfiles | `dockerfile` | `python` | **`docker`** | `3.13-slim` |
| 4 | `requires-python = ">=3.13"` in 4 `pyproject.toml` | `pep621` | `python` | **`python-version`** | `>=3.13` |
| 4 | `uv.lock` | `pep621` (`lockFileMaintenance`) | — | — | `requires-python = ">=3.13"` |

**Rationale**: The extract run reports all four. The `requires-python` row is the one the item
missed; it is a *different* dependency because its datasource differs, which is exactly why the
interim `allowedVersions` hold (`matchDatasources: ["docker"]`) does not reach it.

The pyenv manager's shape was read from renovate's own dist rather than assumed —
`modules/manager/pyenv/extract.js` returns `{depName: 'python', datasource: DockerDatasource.id}` and
`index.js` declares `managerFilePatterns: ['/(^|/)\\.python-version$/']`, `versioning: docker`.

**Alternatives considered**: Treating `requires-python` as a fifth site to join to the group —
rejected under FR-007/FR-008; see R6.

---

## R2 — Are the pin and the image tags actually drifting apart?

**Decision**: **No.** They are already one dependency, and the backlog item's premise is wrong here.

**Rationale**: Because pyenv emits the *docker* datasource, both the hold and the `docker base
images` rule (`matchDatasources: ["docker"]`) already match the pin. The lookup confirms the hold is
working on both halves:

- pyenv → `updates: []`, `fixedVersion: 3.13`
- the eight image refs → one `digest` update only, `newValue: 3.13-slim`, on
  `renovate/docker-digest-pins`, `pendingChecks: true`

**So the defect is not divergence — it is destination.** With the ceiling raised and no further
change, both halves move *inside* `renovate/docker-base-images`, alongside node, postgres, mongo and
keycloak. That is PR #362 reproduced exactly. FR-001/FR-002 are therefore about which branch the
change lands on, not about joining two things that were apart.

---

## R3 — Where must the new rule sit? (the load-bearing finding)

**Decision**: **After `docker base images`, before `docker digest pins`.**

**Rationale — measured, not reasoned.** Three configs were built differing only in the new rule, each
run through a full local lookup, and `renovate.json` was restored from a backup afterwards (verified
clean with `git status --porcelain`):

| probe | rule position | rule match | python `minor` → | python `digest` → |
|---|---|---|---|---|
| **A** | after `uv pin` (i.e. **before** `docker digest pins`) | `matchManagers` + datasource + name | `renovate/python-toolchain` ×8 | `renovate/docker-digest-pins` ×8 |
| **B** | **after** `docker digest pins` | same | `renovate/python-toolchain` ×8 | **`renovate/python-toolchain` ×8** |
| **C** | after `uv pin` | datasource + name only | `renovate/python-toolchain` ×8 | `renovate/docker-digest-pins` ×8 |

Branch tallies for A and C are byte-identical (`docker-digest-pins` 37, `docker-base-images` 25,
`major-docker-base-images` 16, `python-toolchain` 9). In B, eight digest updates leave
`docker-digest-pins` (37 → 29) and land on `python-toolchain` (9 → 17).

In B the eight digest refreshes and the eight minor updates therefore share one branch **and** one
`${packageFile}:${depName}:${currentValue}` de-duplication key — precisely the condition items #308
and #350 measured as a silent drop, where the python digest never refreshed at all.

**Stated honestly**: the branch *assignment* is measured. The resulting drop was **not** reproduced
in this dry run — no `Ignoring upgrade collision (branch=renovate/python-toolchain)` line appeared,
and the collision tally was identical in A and B (3 each, all on `renovate/docker-base-images`,
belonging to other images). Both python update sets carry `pendingChecks: true` here, which plausibly
short-circuits the dedupe path. So the plan treats "same branch, same key" as the hazard to avoid on
the strength of #308/#350's own measurement, not on a fresh reproduction of the drop.

**Alternatives considered**: Ordering the rule last for symmetry with `rust toolchain` / `uv pin` —
rejected by probe B. Those two rules are *also* before `docker digest pins`; "ordered last" in their
descriptions means last among the grouping rules, not last in the file.

---

## R4 — Which rule match shape?

**Decision**: `matchDatasources: ["docker"]` + `matchPackageNames: ["python"]`, with **no**
`matchManagers`.

**Rationale**: Probe C proves it produces the identical, correct split. Two further properties
decide it over probe A's shape:

1. It is the **same match set the ceiling rule already uses**, so the group and the ceiling cannot
   drift apart into matching different sets of sites — the failure mode this whole feature exists to
   prevent, applied to the config itself.
2. It satisfies the spec's edge case "a future container image, in any file, references the
   interpreter". A `matchManagers: ["pyenv","dockerfile"]` form would let a python image added to a
   compose file fall back into the routine base-image sweep. There is no such reference today
   (`grep` over `infrastructure-as-code/` finds none), so this is covered by a guard assertion rather
   than by a lookup.

Unlike `rust toolchain`, no `matchManagers` narrowing is needed to *exclude* anything: `rust` on the
docker datasource is `rust:alpine3.21`, a genuinely different dependency, whereas every docker-datasource
`python` in this repository is the interpreter.

---

## R5 — Does the interpreter move require re-locking? (acceptance criterion 3)

**Decision**: **No re-lock.** All four services install their existing lockfile unchanged on 3.14.

**Rationale — measured.** All four images were built on
`python:3.14-slim@sha256:cad9a2c8…` with the real uv image
(`ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca…`) and the real `RUN uv sync --frozen --no-dev`:

```
RESULT mcp-servers/movie-mcp:        BUILD OK
RESULT mcp-servers/web-api-mcp:      BUILD OK
RESULT mcp-servers/spreadsheet-mcp:  BUILD OK
RESULT agents/movie-assistant:       BUILD OK      (with build-essential, as its Dockerfile has)
```

`--frozen` is the assertion: uv defines it as *do not update the lockfile; error if it is out of
date*. A build that succeeds under it is proof the lock resolves on the new interpreter. Re-run
without BuildKit caching and with output visible, movie-mcp reports `Installed 44 packages in 40ms`
on 3.14-slim — so uv genuinely ran and resolved, rather than a cached layer being replayed.

Why it works: every `pyproject.toml` and every `uv.lock` declares `requires-python = ">=3.13"`. A uv
lock is universal across that range, and the range already admits 3.14.

**INFERENCE, not measured**: that Renovate would generate no lockfile update for an interpreter move
in any case, because it re-locks only manifests it has itself edited and this move edits none. It
follows from the bot's documented behaviour and was not exercised here.

**So the check that catches an interpreter/lock disagreement is the image build itself** —
`uv sync --frozen --no-dev` inside all four Dockerfiles, driven by `scripts/agent-stack.mjs`
(lines 54-57 name all four) under `pnpm nx up-agents-prod`, which `app-ci` runs. FR-013 requires the
runbook name *that*, rather than inventing a gate.

**Alternatives considered**: Raising `requires-python` to `>=3.14` to force a genuine re-lock —
rejected by the operator (see R6). Adding a dedicated re-lock CI job — rejected: it would duplicate a
check that already runs and would be the second gate to keep honest.

---

## R6 — What happens to `requires-python`?

**Decision**: It stays `>=3.13`, is deliberately **excluded** from the group and the ceiling, and the
exclusion is recorded in the config and asserted by a guard.

**Rationale**: It is a floor, not a pin. `>=3.13` legitimately admits 3.14, so the site is already
correct after the move and nothing needs to change. The exclusion is automatic under R4's match shape
(the floor is on the `python-version` datasource, not `docker`) — which is exactly why it must be
*asserted*: a rule that excludes something by accident is one edit away from not excluding it.

**INFERENCE, not measured**: that the bot will not widen the floor on its own. The lookup returned
`updates: []` for it, but with the warning `Failed to look up python-version package python:
no-result` — and that datasource needs `endoflife.date`, which this dev container's egress blocks
(`curl` → HTTP 000). **An unreachable source is not evidence of a quiet dependency**, so this
absence is recorded as unverified. The behavioural claim rests instead on the default range strategy
not widening a satisfied range. FR-007 is written as "excluded by explicit rule", never as "observed
to produce no updates", for exactly this reason.

---

## R7 — The target image identity

**Decision**: `python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6`,
the same digest on all eight references (FR-011).

**Rationale**: Resolved from the Docker Hub registry API against the multi-arch index. The same query
returns `sha256:9d2e5553…` for the currently pinned `3.13-slim` — which matches the digest the lookup
independently proposes as the pending refresh, so the query and the bot agree and neither is being
taken on trust.

**Note for implementation**: this digest must be **re-resolved at implementation time**, not copied
from here. `3.14-slim` is a moving tag and will have been rebuilt.

---

## R8 — Branch name and the guard test's model

**Decision**: The group produces `renovate/python-toolchain` (measured in all three probes). The
guard test extends its existing resolver rather than gaining a new mechanism.

**Rationale**: `scripts/__tests__/renovate-workflow.guard.test.mjs` already models Renovate's
last-matching-rule-wins resolution in `resolvedGroupName`, `resolvedAllowedVersions`,
`resolvedEnabled` and `resolvedVersioning`. The existing `pythonImage()` helper hard-codes
`manager: 'dockerfile'`; it needs to become parameterised so the same assertions run for `pyenv`.

The existing test named *"python still rides the `docker base images` group, so its digest refresh is
not stranded"* asserts a premise this feature deliberately reverses. Per CLAUDE.md it is **updated at
the cause**: it becomes the assertion that a version update resolves to `python toolchain` while the
digest track still resolves to `docker digest pins` — so it still fails if the digest stream is ever
stranded, which is the property it was written to protect.

FR-006 needs something the resolver cannot provide: reading the eight `FROM` tags off disk and
comparing them to `.python-version`. That is a new, file-reading assertion in the same file, in the
shape of the existing *"the devcontainer bakes the SAME Rust the workflows resolve"* test.
