# Phase 1 Data Model: Keep E2E Secrets Off the Test-Runner Command Line

This feature has no domain/persistence data model. The "entities" are configuration artifacts and the
classification rule the guard applies. Documented here for traceability.

## Secret set (the values delivered off-argv)

| Env var | Classification | Required? | In-flow reference | Notes |
|---|---|---|---|---|
| `E2E_TEST_PASSWORD` | sensitive | required | `${E2E_TEST_PASSWORD}` | Keycloak test-user password; login step needs it. |
| `ANTHROPIC_API_KEY` | sensitive | required (CI anthropic provider) | `${ANTHROPIC_API_KEY}` | Model-provider key for the agent gateway. |
| `TMDB_API_KEY` | sensitive | optional | `${TMDB_API_KEY}` | Enrichment; per-user config can supply it per-request, so absence is tolerated. |
| `E2E_TEST_USER` | internal (low-sensitivity) | required | `${E2E_TEST_USER}` | Username; not credential-shaped, but delivered via the same `MAESTRO_` channel for uniformity so it too leaves argv. |

**Delivery transform**: `<NAME>` in the wrapper environment → `MAESTRO_<NAME>` exported → `${<NAME>}`
inside the flow (Maestro strips the prefix; see research R2).

## Classification rule (guard input)

A `maestro` `--env`/`-e` argument is a **flagged credential argument** iff its key matches
`/(KEY|PASSWORD|SECRET|TOKEN)/i` AND it carries an inline `=value`. Otherwise it is an **allowed
non-secret argument** (e.g. `COLLECTION_NAME`, `E2E_TEST_USER`).

| Argument example | Verdict |
|---|---|
| `--env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"` | flagged (fails guard) |
| `--env E2E_TEST_PASSWORD=…` | flagged (fails guard) |
| `--env TMDB_API_KEY="${TMDB_API_KEY:-}"` | flagged (fails guard) |
| `--env COLLECTION_NAME="t038-add-…"` | allowed |
| `--env E2E_TEST_USER="$E2E_TEST_USER"` | allowed (name not credential-shaped; still moved off-argv by the wrapper for uniformity, but not a guard failure) |

## Scan scope (guard file set)

| Path glob | In scope | Reason |
|---|---|---|
| `scripts/**` | yes | live CI runner + wrapper |
| `frontend/mcm-app/tests/e2e/mobile/*.yaml` | yes (comments) | active flow headers |
| `docs/**` (excluding historical) | yes | current runbooks / testing strategy |
| `CLAUDE.md` | yes | live agent/dev guidance |
| `specs/0NN/**` | **no (allowlisted)** | frozen point-in-time records; not rewritten (spec clarification) |
| `scripts/check-no-argv-secrets.mjs` | no (self) | holds the pattern as regex source |

## Artifacts

- **`scripts/maestro-run.sh`** — the sanctioned runner. Inputs: flow path + optional non-secret `--env`
  pairs; environment (+ optional `frontend/mcm-app/.env.e2e.local`). Output: a `maestro test` process with
  no secret on argv. Contract: [contracts/maestro-run.md](./contracts/maestro-run.md).
- **`scripts/check-no-argv-secrets.mjs`** — the guard. Inputs: git-tracked in-scope files. Output: exit 0
  (clean) / exit 1 (flagged, with file:line). Contract: [contracts/argv-secret-guard.md](./contracts/argv-secret-guard.md).
- **`frontend/mcm-app/.env.e2e.local`** — gitignored dev credential file (`KEY=value`), never committed.
