# Research: Version-pin guard (107)

Every unknown in the plan's Technical Context is resolved here. The measurements were taken on
2026-11-24 against `origin/main` 1c3ccb68 and renovate@44.260.2's published `dist/` (the pinned version
is 44.257.9; the files read are unchanged across that range for the purposes below).

## R1 — How is "managed" decided without running Renovate?

**Decision**: Evaluate `renovate.json`'s `customManagers` offline. A manager covers a file when one of
its `managerFilePatterns` matches the repository-relative path. It covers a specific occurrence when
one of its `matchStrings`, compiled as a JavaScript RegExp with the `d` (indices) flag and applied
globally to the whole file, captures a `currentValue` group whose start offset falls on that pin's
line. Add one built-in rule (R2) for version inputs of known GitHub Actions.

**Rationale**: This is the same evaluation `renovate-workflow.guard.test.mjs` already performs per
manager (`managerCovers` / `capturesIn`). It is offline and deterministic (FR-009). It catches the
"file pattern matches, match string misses" case the spec calls out (the nx #194 shape), because
coverage is decided per captured offset, not per file.

**Alternatives considered**:
- *Run `renovate --platform=local` and read its extraction.* This is the ground truth, but it takes
  about 70 s, needs the network for lookups, and runs out of memory in the 8 GB dev container (BELAY
  measured it, exit 137). That breaks FR-009.
- *A per-file allowlist of "managed files".* This is exactly the false comfort FR-003 forbids.

**Known limit**: Renovate's regex manager also supports `matchStringsStrategy` (`combination`,
`recursive`) and template fields. Today every MCM customManager uses the default `any` strategy with
a `currentValue` group, so the evaluator supports exactly that, and **throws** on any other strategy
rather than guessing. A guard test asserts this.

## R2 — Which pins are managed by a BUILT-IN manager?

**Decision**: Version inputs on the GitHub Actions that Renovate's `github-actions` manager knows count
as managed by construction. Today that is `actions/setup-node` → `node-version`, `actions/setup-python`
→ `python-version`, `actions/setup-go` → `go-version`, and `astral-sh/setup-uv` → `version`.

**Evidence**: renovate@44 `dist/modules/manager/github-actions/known-actions/github-releases.js`
lists these actions with the input each reads (`valSchema("node-version")` with packageName
`actions/node-versions`, and so on). This matches BELAY's report that setup-node's `node-version`
comes from the github-releases datasource. Run #8243's log shows the github-actions manager
extracting 130 dependencies from 11 files.

**Consequence**: The 25 `node-version: 26.13.1` literals are **managed**, not unmanaged. A Renovate
bump of one alone would still arrive red, because `check-toolchain-consistency.mjs` holds them equal to
the Node image, but that is a consistency rule, not a visibility gap. The uv workflow inputs are covered
twice: by the built-in manager and by the `astral-sh/uv` customManager. That is recorded as a follow-up
observation, out of this feature's scope.

**Drift guard**: The built-in table is a copy of Renovate's. A test pins the four entries and names the
dist file to re-read when Renovate's major changes. The `.forgejo/renovate-version` bump PR is where
that review happens.

The built-in manifest managers (`npm`, `cargo`, `pep621`, `dockerfile` `FROM`, `docker-compose`
`image:`, `github-actions` `uses:`, `devcontainer`, `pyenv`, `rust-toolchain`) read shapes the detector
does not look for (R3), so they need no rule.

## R3 — What does the detector recognise? (FR-002)

**Decision**: There are three shapes, each a named rule.

| shape | where | recognises |
| --- | --- | --- |
| `assignment` | all scanned files | `NAME=value`, `NAME: value`, `NAME value` (Dockerfile `ENV` space form), `NAME = 'value'` (JS constant), where NAME is UPPER_SNAKE and contains `VERSION` or `PIN`, and the value is `v?N.N[.N]` |
| `action-input` | workflow files | a `*-version:` or `version:` key inside a step's `with:`, in **block or flow** form (`with: { node-version: 26.13.1 }`), attributed to that step's `uses:` action |
| `command-spec` | shell contexts only: workflow `run:` blocks, `*.sh`, Dockerfile `RUN` | `tool@N.N.N` and `tool==N.N.N` |

**Rationale, measured**: A line-only prototype (2026-11-24) found 24 pins. It **missed 18 of the 25
`node-version` pins**, because they are written in flow form (`with: { node-version: 26.13.1, cache:
pnpm }`). Flow form must be parsed (FR-002), and a test pins it.

The same prototype flagged `pnpm@11.17.0` in `scripts/check-toolchain-consistency.mjs:861`. That is a
string literal inside a selftest, not a pin. So `command-spec` is restricted to shell contexts, and JS
files get `assignment` only. Comment lines (`#`, `//`, `*`) are skipped in every shape.

**Alternatives considered**:
- *Parse workflows with a YAML library.* That needs `pnpm install` before the guard runs. The guard runs
  in guardrails' `renovate-config` job, which deliberately installs nothing (built-ins only, the
  failure mode BELAY reported: a script importing a package before install crashed and looked like a
  pass). An indentation-aware line scanner handles the two `with:` forms used here, and a test fails on
  any `with:` form it cannot attribute.
- *Reuse `check-toolchain-consistency.mjs`'s `collectPins`.* It is prior art for `FROM node:`,
  `node-version` and corepack, but it is scoped to the Node/pnpm toolchain and its consistency rules.
  Its flow-form handling is worth reading; folding the two together is not in scope.

## R4 — Day-one inventory (FR-011)

From the prototype (`assignment` and `command-spec` shapes, plus `action-input` corrected for flow form):

| pin | file | status |
| --- | --- | --- |
| 25 × `node-version: 26.13.1` | 10 workflows | managed (built-in, setup-node) |
| 5 × `version: '0.13.9' # uv-version` | 4 workflows | managed (built-in setup-uv, and customManager `astral-sh/uv`) |
| `TRIVY_VERSION`, `RUSTUP_VERSION`, `CARGO_AUDIT_VERSION`, `SEMGREP_PIN`, `PIP_AUDIT_PIN`, `MAESTRO_VERSION`, uv/rust/cargo-audit/openwiki in `toolchain.Dockerfile` | scripts + Dockerfile | managed (customManagers) |
| `DOCKER_COMPOSE_VERSION=v5.3.1` | `.devcontainer/toolchain.Dockerfile:145` | **unmanaged** |
| `GRADLE_VERSION=9.4.1` | `.devcontainer/toolchain.Dockerfile:224` | **unmanaged** |
| `SPECKIT_VERSION=v1.4.2` | `.devcontainer/toolchain.Dockerfile:285` | **unmanaged** |
| `POWERSHELL_VERSION=7.6.5` | `.devcontainer/toolchain.Dockerfile:312` | **unmanaged** |
| `CCUSAGE_VERSION = '20.0.48'` | `scripts/lib/cc-usage/write-oracle.mjs:13` | **unmanaged** |

That gives **5 unmanaged pins** (after discarding the `pnpm@11.17.0` false positive). The implementation
re-runs this inventory with the real detector and records its output in tasks.md. The prototype's
counts are a floor, not the answer.

**Expected resolution** (to be confirmed per pin during implementation):

| pin | likely outcome | why |
| --- | --- | --- |
| `DOCKER_COMPOSE_VERSION` | customManager | `docker/compose`, github-releases, tag form `v5.3.1` |
| `POWERSHELL_VERSION` | customManager | `PowerShell/PowerShell`, github-releases |
| `SPECKIT_VERSION` | exclusion | Spec Kit upgrades are a deliberate, reviewed procedure (docs/runbooks/spec-kit.md: overrides must be re-checked), not a bot bump |
| `GRADLE_VERSION` | exclusion or manager | the Android toolchain is held by the Expo SDK's gradle wrapper; decide against the Android runbook |
| `CCUSAGE_VERSION` | customManager | npm datasource. It names the ccusage release whose output the oracle fixtures were recorded against, so a bump must re-record them; a manager makes that visible. |

## R5 — Where does the check run? (FR-007)

**Decision**: As a step in guardrails' existing `renovate-config` job, after the validator and the
pinned-sha256 `--check`. It uses Node built-ins only.

**Rationale**: The job is required by the `guardrails*` glob with no operator step. It is unconditional
(no path filter: a new pin can arrive in any file), it already holds the Renovate-config checks, and
it installs nothing, which keeps it fast and immune to a broken install (the "suspect the INSTALL"
gate in AGENTS.md).

## R6 — Where do exclusions live, and in what format? (FR-005)

**Decision**: `.forgejo/version-pin-exclusions.json`: a JSON array of `{ "file", "name", "reason" }`.
JSON because the check must parse it with built-ins only (R3). It lives beside
`.forgejo/renovate-version` because both describe how Renovate sees the tree. The full schema is in
`contracts/exclusions-file.md`.

`name` identifies the pin: the variable name for `assignment`, `action:input` for `action-input`, and
the tool name for `command-spec`. Matching is exact on both `file` and `name`, with no globs (FR-005).
An exclusion may match several occurrences of the same name in one file; all of them are excused.

## R7 — Invocation

**Decision**: `node scripts/check-version-pins.mjs`. It is read-only, so a bare invocation is the check
(no mutating default, item #500). `--json` prints the classification as JSON, and `--help` prints
usage. It uses the shared `lib/argv-contract.mjs` and is registered in `cli-entry-guard`'s probe list.
The full contract is in `contracts/cli.md`.
