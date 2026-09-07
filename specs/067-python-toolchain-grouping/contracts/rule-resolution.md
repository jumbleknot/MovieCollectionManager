# Contract: resolved rule behaviour for the interpreter

**Feature**: 067-python-toolchain-grouping | **Date**: 2026-09-07

The interface this feature exposes is not an API — it is **what the update bot resolves for a given
dependency**. The guard test is the executable form of this contract; it models Renovate's
last-matching-rule-wins resolution over the `packageRules` array.

`—` means "no rule sets this", which is the correct answer for almost every dependency and is what
the controls assert.

## C1 — The interpreter

| manager | datasource | depName | updateType | → groupName | → allowedVersions |
|---|---|---|---|---|---|
| `pyenv` | `docker` | `python` | `patch` | `python toolchain` | `<3.15` |
| `pyenv` | `docker` | `python` | `minor` | `python toolchain` | `<3.15` |
| `pyenv` | `docker` | `python` | `major` | `python toolchain` | `<3.15` |
| `dockerfile` | `docker` | `python` | `patch` | `python toolchain` | `<3.15` |
| `dockerfile` | `docker` | `python` | `minor` | `python toolchain` | `<3.15` |
| `dockerfile` | `docker` | `python` | `major` | `python toolchain` | `<3.15` |
| `dockerfile` | `docker` | `python` | **`digest`** | **`docker digest pins`** | `<3.15` |
| `dockerfile` | `docker` | `python` | **`pinDigest`** | **`docker digest pins`** | `<3.15` |
| `docker-compose` | `docker` | `python` | `minor` | `python toolchain` | `<3.15` |

The `<3.15` value is not a literal in the test: it is **derived** from `.python-version` as
`<major.(minor+1)`, so raising the pin without raising the ceiling fails (INV-2).

The last row has no site in the repository today. It is asserted so that a python image added to a
compose file in future joins the interpreter group rather than falling into the routine base-image
sweep.

## C2 — The deliberate exclusion

| manager | datasource | depName | updateType | → groupName | → allowedVersions |
|---|---|---|---|---|---|
| `pep621` | `python-version` | `python` | `minor` | `python deps` (unchanged) | — |

The floor shares a `depName` with the interpreter but not a datasource. It must acquire neither the
group nor the ceiling. This row is a **control**: it passes today by virtue of the datasource
difference, and asserting it is what stops a later widening of either rule from capturing it
silently.

## C3 — Controls: nothing else is affected

| depName | datasource | → groupName | → allowedVersions |
|---|---|---|---|
| `node` | `docker` | `docker base images` | — |
| `postgres` | `docker` | `docker base images` | — |
| `redis` | `docker` | `docker base images` | — |
| `ghcr.io/astral-sh/uv` | `docker` | `uv pin` | — |
| `hashicorp/vault` | `docker` | `docker base images` | `<1.19` |

A `—` becoming a value in this table means a rule has widened past its own dependency. `vault` is
listed because it is the other `allowedVersions` holder: the two ceilings must stay disjoint.

## C4 — Ordering constraint

The `python toolchain` rule MUST appear in `packageRules` **after** the `docker base images` rule and
**before** the `docker digest pins` rule.

Measured 2026-09-07 ([research.md](../research.md) R3): placed after `docker digest pins`, all eight
`digest` refreshes migrate from `renovate/docker-digest-pins` onto `renovate/python-toolchain`
(tallies 37→29 and 9→17), sharing a branch and a de-duplication key with the eight `minor` updates —
the condition items #308 and #350 measured as a silent drop.

C1's `digest`/`pinDigest` rows are the executable form of this constraint: if the rule is moved, they
fail.

## C5 — Branch identity

The group resolves to branch `renovate/python-toolchain` (measured in all three probes). This is the
name an operator will look for on the forge, and the name the runbook's §8 row cites.
