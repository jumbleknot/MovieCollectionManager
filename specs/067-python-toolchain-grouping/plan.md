# Implementation Plan: Python toolchain grouping

**Branch**: `067-python-toolchain-grouping` | **Date**: 2026-09-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/067-python-toolchain-grouping/spec.md`

## Summary

Give the Python interpreter its own Renovate group so an interpreter minor can never again arrive
inside a base-image sweep, raise the ceiling to match, and make the deferred 3.13 → 3.14 move in the
same change. Add the guard assertions that make the pin, the eight image references and the ceiling
mutually enforcing, and record in the runbook that no re-lock is required and which existing check
proves it.

The ordering of the new rule is the whole risk, and it was settled by measurement rather than by
reading: placed after `docker digest pins` it pulls all eight digest refreshes onto its own branch
and recreates items #308/#350. See [research.md](./research.md) R3.

## Technical Context

**Language/Version**: JSON configuration plus Node 24 guard tests (`node:test`). No application code
changes; the only source edits are eight Dockerfile `FROM` lines and a one-line pin file.

**Primary Dependencies**: Renovate 44 (pinned to the major in `.forgejo/workflows/renovate.yml` and
`.forgejo/workflows/guardrails.yml`; measured here at 44.69.3). Docker Hub registry API for digest
resolution. uv 0.12.10 (the image the Dockerfiles already copy `/uv` from).

**Storage**: N/A.

**Testing**: `scripts/__tests__/renovate-workflow.guard.test.mjs` (resolved package-rule behaviour +
new on-disk pin/tag agreement), run in CI by `guardrails / naming` via
`node --test scripts/__tests__/*.test.mjs`; `renovate-config-validator --strict --no-global` in
`guardrails / renovate-config`; the four image builds under `pnpm nx up-agents-prod` in `app-ci`.

**Target Platform**: Forgejo Actions on the single self-hosted runner; the four service images run
under local Compose and production Komodo stacks.

**Project Type**: Infrastructure/configuration change within the existing monorepo.

**Performance Goals**: N/A — no runtime behaviour changes beyond the interpreter minor itself.

**Constraints**: The new rule MUST sit after `docker base images` and before `docker digest pins`
(R3). The digest refresh stream MUST stay on `docker digest pins` (FR-003). All eight image
references MUST carry one identical digest (FR-011). No lockfile may be regenerated (FR-012). No new
CI job (spec, Out of Scope).

**Scale/Scope**: 1 Renovate rule added + 1 ceiling raised; 1 pin file; 8 `FROM` lines across 4
Dockerfiles; 1 guard test file; 1 runbook section. Thirteen version-bearing sites in total.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Assessment |
|---|---|---|
| **AI Assistant Constraints** | Yes | Scoped to the spec. No unrelated refactoring; the `python deps` group, the lockfile channel and every non-python image are explicitly out of scope. Comments added to `renovate.json` record *why* (the measured A/B result), which is the sanctioned non-obvious-rationale case. |
| **Technology Agnosticism in Specification** | Yes | `spec.md` names no config file, rule key or manager — verified mechanically. All mechanism lives here and in `research.md`. |
| **Behavior-Descriptive Identifiers** | Yes | New test names describe the behaviour asserted (`the interpreter pin and every python image move in ONE group`), not `FR-001`. Requirement IDs appear only in comments. |
| **Test-Driven Development (NON-NEGOTIABLE)** | Yes | Every assertion is written and seen to fail before the config or file it constrains is changed. `tasks.md` must carry Verify RED / Verify GREEN per the template. |
| **Test Type Integrity** | Yes | The guard assertions are unit tests over config resolution and file contents — nothing is mocked because nothing is called. The interpreter move is proved against **real** images and the **real** registry, not fixtures. |
| **Security (NON-NEGOTIABLE)** | **Yes** | Net positive, and the risk is the one to watch. The move to 3.14 is toward a currently-maintained interpreter; 3.13 drops to security-only when 3.15 ships. FR-003 exists precisely so this change cannot stall the base image's vulnerability-patch stream — the failure #350 already caused. Digest pinning is preserved (FR-011), so the pin remains content-addressed. No secrets are touched. |
| **Logging and audit** | No | No runtime code path changes. |

**Result: PASS.** No violations; Complexity Tracking omitted.

**Post-Phase-1 re-check: PASS.** The design adds one packageRule and one file-reading assertion. It
introduces no new component, no new gate and no new dependency. The one place it *could* have grown —
a dedicated re-lock job — was rejected in R5 in favour of naming the check that already runs.

## Project Structure

### Documentation (this feature)

```text
specs/067-python-toolchain-grouping/
├── plan.md              # This file
├── spec.md              # /speckit-specify output
├── research.md          # Phase 0 — the measurements the plan rests on
├── data-model.md        # Phase 1 — the sites and their invariants
├── quickstart.md        # Phase 1 — how to verify this end to end
├── contracts/
│   └── rule-resolution.md   # Phase 1 — the resolved-rule contract the guard asserts
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks output — NOT created here
```

### Source Code (repository root)

```text
renovate.json                                   # + `python toolchain` rule; ceiling <3.14 -> <3.15
scripts/__tests__/
└── renovate-workflow.guard.test.mjs            # updated at the cause + new assertions
agents/movie-assistant/
├── .python-version                             # 3.13 -> 3.14
└── Dockerfile                                  # 2 FROM lines
mcp-servers/
├── movie-mcp/Dockerfile                        # 2 FROM lines
├── spreadsheet-mcp/Dockerfile                  # 2 FROM lines
└── web-api-mcp/Dockerfile                      # 2 FROM lines
docs/runbooks/renovate.md                       # §8 python row rewritten
```

**Structure Decision**: No new directories. This is a configuration and pin change inside the
existing monorepo layout; the four service images and the single guard-test file are the only code
touched.

## Implementation Approach

### 1. `renovate.json` — one rule added, one ceiling raised

The rule (R4's shape — deliberately the *same match set as the ceiling rule*, so the two can never
drift into matching different sites):

```jsonc
{
  "description": [ /* records the measured A/B result and the ordering constraint */ ],
  "matchDatasources": ["docker"],
  "matchPackageNames": ["python"],
  "groupName": "python toolchain",
  "automerge": false
}
```

Placed immediately **after the `uv pin` rule** — that is, with the `rust toolchain` / `uv pin`
grouping cluster, after `docker base images` and before `docker digest pins`. Its description must
state that this position is load-bearing and why, because the file's other grouping rules say
"ordered last" and a later reader will otherwise move it to match them.

The existing python `allowedVersions` goes `<3.14` → `<3.15`, and its description is rewritten: it
currently forward-references this feature as future work and says "three sites". It becomes a
description of the grouping that now exists, over four site kinds, and keeps the standing instruction
to raise the ceiling only together with the pin.

### 2. The move

`.python-version` → `3.14`; the eight `FROM` lines → `python:3.14-slim@<digest>`, one identical
digest across all eight, **re-resolved at implementation time** rather than copied from
[research.md](./research.md) R7.

### 3. `renovate-workflow.guard.test.mjs`

Parameterise the existing `pythonImage()` helper by manager, then:

- **updated at the cause**: the test asserting python rides `docker base images` becomes the
  assertion that version updates resolve to `python toolchain` while `digest` still resolves to
  `docker digest pins` — so it still fails if the patch stream is ever stranded;
- extend the ceiling assertion to the `pyenv` manager alongside `dockerfile`;
- **new, file-reading**: parse the eight `FROM python:X.Y-slim` tags off disk and assert every one
  equals `.python-version`, in the shape of the existing "the devcontainer bakes the SAME Rust"
  test — this is FR-006, which rule resolution alone cannot provide;
- **new control**: a `pep621` / `python-version` dep named `python` resolves to neither the group nor
  the ceiling (FR-007);
- **new control**: a docker-datasource `python` seen by the `docker-compose` manager still resolves
  into the group — the spec's "a future image in any file" edge case, which no lookup can exercise
  because no such reference exists yet;
- keep the existing control that node/postgres/redis/`ghcr.io/astral-sh/uv` acquire neither.

### 4. `docs/runbooks/renovate.md` §8

The python row becomes **grouped: yes — `python toolchain`**, the site count is corrected to
1 pin + 8 image refs + 4 floors + 4 lockfiles, and the row answers the re-lock question by naming
`uv sync --frozen --no-dev` inside the four image builds as the check that fails. The §8 note that
lists why each toolchain needed a group gains python's reason: not a second manager claiming a half
(the halves already share a datasource), but a routine group claiming the whole thing.

## Risks

| Risk | Mitigation |
|---|---|
| The rule is later moved "last" for consistency with its neighbours, stranding the digest refresh | The measured A/B result is written into the rule's own description, and the guard asserts the digest track resolves to `docker digest pins` — so the move fails the gate rather than going quiet |
| `3.14-slim` is rebuilt between planning and implementation, so R7's digest is stale | The plan requires re-resolving it; the guard compares *tags* to the pin, and `docker:pinDigests` keeps the digest honest |
| A dependency lacks a 3.14 artefact and silently degrades | `--frozen` forbids silent resolution changes, and R5 measured all four services building. `agents/movie-assistant` already provisions a compiler for `annoy`, which has no matching wheel |
| The `requires-python` exclusion is broken by a later widening of either rule | Asserted directly as a control (FR-007) rather than left to the datasource difference |
