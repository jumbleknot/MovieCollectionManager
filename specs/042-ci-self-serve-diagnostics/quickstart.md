# Quickstart: CI Self-Serve Diagnostics

**Feature**: 042-ci-self-serve-diagnostics | **Date**: 2026-07-19

Runnable validation for the feature. Details live in [contracts/](./contracts/) and
[data-model.md](./data-model.md) rather than being repeated here.

## Prerequisites

| Requirement | Check | Notes |
|---|---|---|
| Dev container | `echo $MCM_DEVCONTAINER` → `1` | The supported environment (FR-019a) |
| Read token | `[ -n "$MCM_FORGE_TOKEN" ] && echo ok` | Already provisioned via `${localEnv}` passthrough |
| Node ≥ 22 | `node --version` | Node 22 is the CI floor; dev container is 24 |
| Forge reachable | `node scripts/ci-status.mjs --selftest` | Selftest needs no network |
| Write token | `CI_DIGEST_TOKEN` in the Forgejo Actions secret store | Write side only; not needed locally |

If `MCM_FORGE_TOKEN` is unset, tooling must abort naming the variable (FR-019b) — that failure is
itself a valid test.

> The token is set on the Windows host with `setx`. `setx` affects only newly-launched processes, so
> VS Code must be **fully quit** — not merely reloaded — before the rebuild, or `${localEnv}` resolves
> to empty and the token silently isn't there.

---

## 1. Unit tests (run first — TDD)

```bash
node --test scripts/__tests__/ci-digest-redact.test.mjs
node --test scripts/__tests__/ci-status.test.mjs
node --test scripts/__tests__/ci-failure-digest.test.mjs
```

**Expected before implementation (RED):** all three fail with module-not-found.
**Expected after (GREEN):** all pass.

Remember `node --test` is **never run in CI** (research R8) — so also:

```bash
node scripts/ci-status.mjs --selftest          # → ✓ … --selftest passed
node scripts/ci-failure-digest.mjs --selftest
node scripts/secret-scan.mjs --selftest        # regression: refactor must not break the existing gate
```

The `--selftest` flags must assert the same cases as the `__tests__` files. If they drift, CI is
protecting nothing.

## 2. Verify the refactor didn't break the existing gates

The `secret-scan.mjs` export refactor touches a live CI gate. Prove it still works:

```bash
node scripts/secret-scan.mjs              # → exit 0 on a clean tree
node scripts/check-topology-scrub.mjs     # → exit 0
```

Both are invoked by `guardrails.yml` as subprocesses, so exports cannot affect them — but verify
rather than assume.

## 3. Read side against the real forge

```bash
# Status of the current commit
node scripts/ci-status.mjs status

# A specific commit / PR
node scripts/ci-status.mjs status --sha "$(git rev-parse HEAD)"
node scripts/ci-status.mjs status --pr 82
```

**Expected:** a per-job table plus a required-context verdict, in **under 5 seconds** (NFR-001). Time
it — if it takes ~90 s, the query is missing `head_sha` and is fetching all 12.4 MB (research R6).

```bash
time node scripts/ci-status.mjs status --sha "$(git rev-parse HEAD)"
```

**Verify no leakage** — this must produce zero output:

```bash
node scripts/ci-status.mjs status | grep -iE '\.ts\.net|token|bearer' && echo "LEAK" || echo "clean"
```

## 4. The four classification traps

The highest-risk logic. Each has a known real-world instance:

| Trap | How to exercise | Expected |
|---|---|---|
| `skipped` → satisfied | A commit touching only docs (app-e2e path-gated out) | Mergeable, annotated `skipped` — **not** blocked |
| `waiting` ≠ failure | Query while the kvm runner is saturated | `waiting`; `watch` keeps polling, exit `3` on timeout |
| `superseded` ≠ failure | Push twice within the guardrails concurrency window | `superseded (newer push)`, excluded from verdict |
| non-required → advisory | A commit where `dast` fails but required pass | Mergeable, `dast` under ADVISORY |

The `superseded` case is the one that fails *loud* — misclassifying it announces a broken build that
was never broken.

## 5. Write side smoke test (the one real-forge exercise)

Deliberate, manual, and not an automated test.

```bash
git switch -c 042-digest-smoke
# add a step that exits 1 in one app-ci job
git commit -am "test: deliberate failure to prove digest publication" && git push -u origin HEAD
# open a PR against main on the forge (see CLAUDE.md for the API recipe)
```

**Verify:**

1. The job fails — and the digest step did **not** mask it (FR-009).
2. A PR comment appears with the `<!-- ci-digest:job=… -->` marker.
3. Re-run the job → the comment is **edited, not duplicated** (FR-007).
4. `node scripts/ci-status.mjs failure --pr <n>` prints it.
5. `node scripts/ci-status.mjs failure --pr <n> --full` fetches the bundle and prints **a path, not
   contents** (FR-016).
6. The comment contains no credential and no `.ts.net` host (FR-005, FR-017).
7. Push again immediately to cancel the run → **no digest is published** for the cancelled jobs
   (FR-001a).

**Then delete the branch, the PR, and the test bundle.**

## 6. Confirm the write token's scopes (the open risk)

This is the item research could not resolve on paper — the write token's scopes are only observable
from inside a running job.

On the first real run, confirm in the job log that the publish returned 2xx. A `401`/`403` must name
the missing scope (FR-020), **not** surface a bare status code. If it fails, it is a token-scope
config change, not a redesign (FR-010).

## 7. Full validation checklist

- [ ] All three `__tests__` suites pass
- [ ] All `--selftest` flags pass, asserting the same cases
- [ ] `secret-scan.mjs` + `check-topology-scrub.mjs` still exit 0 (refactor regression)
- [ ] Status lookup < 5 s
- [ ] No `.ts.net` host or credential in any output
- [ ] All four classification traps behave correctly
- [ ] Smoke test: digest published, upserted on retry, bundle retrievable, job outcome unchanged
- [ ] Cancelled run publishes nothing
- [ ] `docs/runbooks/ci-diagnostics.md` written; CLAUDE.md § *Driving CI/CD to green* updated
- [ ] `guardrails.yml` header comment corrected — it must no longer claim no `${{ secrets }}` is
      referenced (plan.md § Complexity Tracking)
- [ ] Guardrails jobs publish digests like every other workflow (full G6 coverage)
