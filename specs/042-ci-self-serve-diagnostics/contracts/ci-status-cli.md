# Contract: `ci-status.mjs` command surface

**Feature**: 042-ci-self-serve-diagnostics | Read side (US1, US3)

Invocation is direct (`node scripts/ci-status.mjs …`), not via Nx — see plan.md D6.

## Global behavior

| Rule | Requirement |
|---|---|
| Auth | `MCM_FORGE_TOKEN` from env. **Never** on argv (`check-no-argv-secrets.mjs` enforces this). | FR-019 |
| Missing token | Abort naming the variable and how to set it. No fallback literal. | FR-019b, FR-020 |
| Missing scope | On 401/403, name the **missing scope** (`read:issue`, `read:package`). Never a bare status code. | FR-020 |
| Output | Distilled only. Raw payloads cached to the scratchpad and referenced by path. | FR-016 |
| Host redaction | Every emitted URL/field rewrites the forge host to `<forge>`. | FR-017 |
| Query strategy | `head_sha` for lookups; `page` **with** `limit` for listings; `status`/`event`/`branch` filtered client-side. | NFR-001/002/003 |

## Exit codes

Follows the repo-wide convention (`0` pass / `1` finding / `2` bad args), extended for polling:

| Code | Meaning |
|---|---|
| `0` | Success — for `status`/`watch`, all required contexts satisfied |
| `1` | A required context genuinely **failed** |
| `2` | Bad arguments, unparseable response, or missing token/scope |
| `3` | Still `waiting` when `watch` hit its timeout — **not** a failure (FR-013) |

Exit `3` is deliberately distinct: a poller that exits non-zero on starvation would report a saturated
single-runner queue as a broken build.

---

## `status [--sha <sha> | --pr <n> | --branch <name>]`

Defaults to `HEAD`. Prints a compact per-job table **plus the required-context merge roll-up that is
the actual merge signal**.

```text
$ node scripts/ci-status.mjs --sha 7ab4ff2…

commit 7ab4ff2  (PR #82)                                    <forge>

REQUIRED
  ✓ guardrails / secret-scan                       passed
  ✓ guardrails / naming                            passed
  ✓ app-ci / changes                               passed
  ✓ app-ci / affected                              passed
  ○ app-ci / app-e2e                               skipped   (path-gated → satisfied)
  ⏳ app-ci / mc-service-checks                     waiting

ADVISORY (non-blocking)
  ✗ app-ci / dast                                  failed

VERDICT  not yet mergeable — 1 required context still waiting
         raw payload cached: <scratchpad>/ci-status-7ab4ff2.json
```

- Skipped renders as satisfied, annotated so it doesn't read as a gap (FR-012).
- Non-required failures appear under ADVISORY, never affecting the verdict (FR-011a/b).
- A superseded run renders as `superseded (newer push)` and is excluded from the verdict (FR-014).

## `watch [--sha …] [--timeout <seconds>]`

Polls until settled. Exits `0` mergeable, `1` genuine required failure, `3` timeout while still
waiting. Must **not** treat `pending` as failure — under a saturated capacity-1 runner, pending is
starvation.

Default timeout 45 min (app-e2e alone runs ~23 min and may queue behind another run).

## `failure [--sha … | --run <id>] [--job <name>] [--full]`

Locates the digest for the failing job — PR comment on `pull_request`, commit status otherwise — and
prints it.

- Without `--job`, prints digests for all genuinely failed jobs.
- `--full` downloads the evidence bundle to the scratchpad and prints **the path, not the contents**
  (FR-016). Bundles are capped at 5 MB ≈ 40 s.
- When no digest exists, say so and name the likely cause — the pre-digest residual risk (spec §Out of
  Scope) — rather than reporting an empty result as "no failure".

## `--selftest`

Required by repo convention and **the only thing that protects this script in CI** (`node --test` is
never run there — research R8). Must assert the same cases as `scripts/__tests__/ci-status.test.mjs`,
at minimum: `skipped→satisfied`, `cancelled→superseded`, `pending→waiting-not-failure`,
non-required→advisory, host redaction, and missing-scope messaging.
