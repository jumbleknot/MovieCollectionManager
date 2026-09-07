# Phase 1 Data Model: Python toolchain grouping

**Feature**: 067-python-toolchain-grouping | **Date**: 2026-09-07

There is no runtime data model here. The "entities" are the sites at which the interpreter version is
written, the identity each one has to the update bot, and the invariants that must hold between them.

## Entities

### 1. Interpreter pin — the source of truth

| | |
|---|---|
| **Site** | `agents/movie-assistant/.python-version` (1) |
| **Shape** | exactly `MAJOR.MINOR`, no patch, no trailing newline significance |
| **Seen as** | manager `pyenv`, depName `python`, datasource `docker`, versioning `docker` |
| **Read by** | uv, when resolving and syncing; the guard test, to derive the ceiling and compare the image tags |

Every other version-bearing site is measured **against this file**. It is the only site a human edits
to make the decision; the rest follow.

### 2. Container image references — what the services actually run

| | |
|---|---|
| **Sites** | 8: `agents/movie-assistant/Dockerfile` (build, runtime), `mcp-servers/movie-mcp/Dockerfile` (build, runtime), `mcp-servers/spreadsheet-mcp/Dockerfile` (build, runtime), `mcp-servers/web-api-mcp/Dockerfile` (build, runtime) |
| **Shape** | `FROM python:MAJOR.MINOR-slim@sha256:<64 hex>` |
| **Seen as** | manager `dockerfile`, depName `python`, datasource `docker`, versioning `docker` |
| **Carries** | both a *version* (the tag) and an *identity* (the digest). The two update tracks act on different halves |

### 3. Language-version floor — deliberately outside the group

| | |
|---|---|
| **Sites** | 4: `requires-python` in each service's `pyproject.toml` |
| **Shape** | a range, `>=MAJOR.MINOR` |
| **Seen as** | manager `pep621`, depName `python`, datasource **`python-version`**, versioning `pep440` |
| **Status** | excluded from both the group and the ceiling, by rule and by assertion (FR-007, FR-008) |

A floor is not a pin. `>=3.13` already admits 3.14, so this site needs no change when the interpreter
moves — and joining it to the group would convert a compatibility statement into a deployment
decision.

### 4. Resolved lockfiles — not regenerated

| | |
|---|---|
| **Sites** | 4: `uv.lock` beside each `pyproject.toml` |
| **Shape** | records `requires-python = ">=3.13"`, the floor it was resolved against |
| **Status** | untouched by this feature (FR-012). Valid across the whole range the floor permits, which already includes the target minor |

### 5. Version ceiling — the bound on what may be proposed

| | |
|---|---|
| **Site** | 1: `allowedVersions` on the python rule in `renovate.json` |
| **Shape** | `<MAJOR.(MINOR+1)`, derived from entity 1 |
| **Status** | must be raised in the *same* change as the pin, never separately (FR-004, FR-005) |

## Invariants

| ID | Invariant | Enforced by |
|---|---|---|
| **INV-1** | The tag minor of all 8 image references equals the interpreter pin | Guard test, reading both off disk (FR-006) |
| **INV-2** | The ceiling equals `<major.(minor+1)` of the interpreter pin | Guard test, deriving one from the other (FR-004, FR-005) |
| **INV-3** | All 8 image references carry one identical digest | Guard test, in the same on-disk pass as INV-1 (FR-011) |
| **INV-4** | A version update to any docker-datasource `python` resolves to the group `python toolchain` | Guard test, resolved-rule contract (FR-001, FR-002) |
| **INV-5** | A `digest`/`pinDigest` update to those same references resolves to `docker digest pins` | Guard test, resolved-rule contract (FR-003) |
| **INV-6** | The floor acquires neither the group nor the ceiling | Guard test control (FR-007) |
| **INV-7** | No dependency other than `python` acquires either | Guard test controls (FR-009) |
| **INV-8** | Each service installs from its existing lockfile without relaxing it | `uv sync --frozen --no-dev` in all four image builds (FR-012) |

**INV-1 and INV-2 together are the point of the feature**: the ceiling cannot leave the images a
minor behind, and a hand edit to either side fails the gate rather than passing quietly.

## State transition — an interpreter minor move

```text
                 all five entities agree on MINOR = N
                                 │
   pin raised to N+1  ───────────┤  INV-1 and INV-2 BOTH fail here
   (alone)                       │  → the gate is red until the rest follow
                                 │
   ceiling -> <N+2,              │
   8 tags -> N+1, one digest ────┤  INV-1..INV-7 hold again
                                 │
   image builds on N+1 ──────────┘  INV-8 confirmed; lockfiles untouched
```

The intermediate state is deliberately red. There is no ordering of the edits that makes it green
early, which is what stops a half-move merging.
