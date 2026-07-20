# Phase 0 Research: CI Self-Serve Diagnostics

**Feature**: 042-ci-self-serve-diagnostics | **Date**: 2026-07-19

Findings are grouped by decision. Measurements against the live forge were taken 2026-07-18 (recorded
in the PRD); codebase findings were re-verified 2026-07-19 against the working tree.

---

## R1 — Can the read side use the existing git credential? **No.**

**Decision**: Use a dedicated read-only token delivered as `MCM_FORGE_TOKEN`.

**Rationale**: Measured endpoint-by-endpoint. The `git credential fill` token is *repository*-scoped:
it returns 200 on `actions/runs`, `actions/tasks`, `statuses/{sha}`, `pulls`, and `contents/{path}`,
but **403 on `issues/{n}/comments`** and **401 `reqPackageAccess`** on the package registry — the two
endpoints this entire design depends on. This is granular scope, not expiry (the same token 200s on
`actions/runs` in the same second; basic-auth behaves identically).

The consequence is the single most important finding behind this feature: the publication model and
the read credential had been chosen in **separate decisions and were mutually incompatible** — a
credential-fill read side could read neither the digest nor the bundle. It was invisible until the
endpoints were actually exercised.

**Verified after minting the scoped token**: `issues/{n}/comments` 403 → 200, packages list 403 → 200,
package `GET` 401 → 404 (auth passes; the package legitimately does not exist yet). Package `PUT`
remains 401 — correct, since the token is read-only.

**Status**: ✅ **Already provisioned.** `.devcontainer/devcontainer.json` passes `MCM_FORGE_TOKEN`
through from the host via `${localEnv}` (commit `7ab4ff2`), and it is present in this container. FR-019
is effectively pre-satisfied; implementation only needs to consume it.

**Alternatives rejected**: SSH to the homelab host (most complete — the only option covering
pre-digest failures — but grants new standing access for a rare failure class); a session-cookie
scraper (stores a password, couples to an unversioned UI endpoint); patching Forgejo (out of scope).

---

## R2 — Which token can the **write** side use? **A new one.**

**Decision**: Mint `CI_DIGEST_TOKEN` (`write:issue` + `write:package` + `read:repository`) as a
Forgejo Actions secret.

**Rationale**: The PRD proposed defaulting to `GITHUB_TOKEN` with a `CD_PUSH_TOKEN`-class fallback.
Reading the workflows disproved both as good defaults:

- **`secrets.GITHUB_TOKEN` is never used in this repo.** It appears only in a comment explaining why
  it is avoided — `cd-deploy.yml:29-30`: *"the auto GITHUB_TOKEN is not a push-whitelisted user and is
  declined by the pre-receive hook."* Its issue/package scope remains unobservable from outside a job.
- **`secrets.CD_PUSH_TOKEN` is a whitelisted-user PAT** with `write:repository` on protected `main`,
  currently referenced by exactly two jobs (`cd-deploy/build-deploy` checkout, `app-ci/trigger-cd` API
  calls). Spreading it to ~20 jobs across 4 workflows to publish diagnostics is a material privilege
  expansion — the blast radius of a leak from any job becomes "push to protected main".

A purpose-scoped token cannot push code and cannot touch `main`. It also converts the spec's flagged
unknown into a known: rather than tolerating an unverifiable auto-token scope, we choose the scopes.

**FR-010 remains satisfied** — the script reads its token from an env var, so substituting a different
token is a workflow edit, not a redesign.

---

## R3 — Composite action? **No — a direct step.**

**Decision**: Add an `if: always()` `run:` step per job invoking `scripts/ci-failure-digest.mjs`.

**Rationale**: `.forgejo/actions/` **does not exist**, and a repo-wide search for `action.yml` /
`action.yaml` returns **zero** results — this would be the repo's first local composite action, on a
runner whose composite support is unverified. Since the action would wrap one `node` invocation, the
packaging adds an unknown without adding capability. All logic lives in the script, so a behavior
change still means editing one file.

**Alternative rejected**: the composite action from PRD §3.1 — revisit only if the per-job step grows
real conditional logic.

---

## R4 — Can `secret-scan.mjs` be reused for redaction? **Not as-is; this is the critical finding.**

**Decision**: Refactor `secret-scan.mjs` to export its rules behind a main-guard, and build a new
fail-closed `ci-digest-redact.mjs` on top.

**Rationale**: Three properties make direct reuse unsafe:

1. **It detects; it does not redact.** `scanText` returns `{rule, sample}` hits. Nothing rewrites text.
2. **Its regexes are non-global** (no `/g`). A naive `.replace()` would rewrite only the **first**
   occurrence and silently publish every subsequent one — a redaction bug that looks like it works.
3. **It has zero exports** and dispatches at module scope (`if (process.argv.includes('--selftest'))
   selftest(); else runScan();`), so importing it today runs a full tree scan and can `process.exit(1)`
   inside the caller.

The repo's real redaction primitive is `scrubSecretsInText` in `zap-scan.mjs:185`, which is exported
and correctly uses `/g`.

**Refactor is safe**: six sibling scripts are already hybrid export+CLI modules, and the repo has a
settled main-guard idiom (`check-dast-findings.mjs`). Both CI invocation sites call
`node scripts/secret-scan.mjs` as a subprocess and never import it, so adding `export` changes nothing
for them.

**Design consequence — fail-closed.** Detection and redaction disagree at the edges. The new module
therefore redacts, then **re-runs the detection rules over its own output**; any surviving match drops
the excerpt entirely. Losing a log excerpt is an acceptable failure. Leaking a credential into a PR
comment — far more visible than a run log — is not.

---

## R5 — How to redact the forge host without embedding it

**Decision**: Match the *shape*, never the literal — reuse the `check-topology-scrub.mjs` approach.

**Rationale**: That gate deliberately hard-codes no host value, documenting why: *"the gate CANNOT
hard-code the real tailnet id (that would itself re-leak it)."* It matches any `*.ts.net` FQDN and
allows it only if the host contains `tailnet` or `example`. The redactor adopts the same pattern so it
cannot leak the host it exists to protect.

**Known gaps inherited** (pre-existing, not introduced here): the public base domain is not
pattern-gated (relies on the `${BASE_DOMAIN}` convention plus review), and tailnet CGNAT IP literals
(`100.64.0.0/10`) have **no** gate anywhere in the repo. If digest content can carry a tailnet IP, the
redactor should add that range — a small, contained improvement over the current baseline.

---

## R6 — Query strategy against the forge API (measured)

**Decision**: Always query by `head_sha`; never send `limit` without `page`; filter `status`/`event`/
`branch` client-side.

**Rationale**: Measured on `GET /actions/runs`. The results are counter-intuitive and must not be
re-derived by guessing:

| Query | Honored? | Result |
|---|---|---|
| *(none)* | — | 12.4 MB, **94 s**, 886 runs |
| `?limit=N` **alone** | ❌ silently ignored | full 12.4 MB |
| `?page=N&limit=M` | ✅ | 82 KB, **1.2 s** |
| `?head_sha=<sha>` | ✅ true server-side filter | 64 KB, **0.92 s** |
| `?status=`, `?event=`, `?branch=` | ❌ silently ignored | full 12.4 MB |

At ~135 KB/s this is a **~100× latency difference** on the primary read path, so NFR-001/002/003 are
correctness requirements, not optimizations. The obvious `?limit=10` looks like it worked while
fetching everything.

**Consequence**: with `head_sha` the common path is well under the 5 s budget, so response caching and
conditional requests are **not** needed and stay out of scope.

---

## R7 — Runner environment constraints

**Decision**: Collect opportunistically; degrade with an explicit statement of what was absent.

**Rationale**:

- Two runner labels: `ubuntu-latest` (jobs in a `node:22-bookworm` container) and `kvm` (host).
- **Container jobs have no Docker CLI**, so container-health evidence is impossible there. Only the
  three Docker-touching jobs run on `kvm`: `app-ci/app-e2e`, `app-ci/dast`, `cd-deploy/build-deploy`.
- `~/mcm-ci-last-failure/` is written by **exactly one job** (`app-ci/app-e2e`) — it is not a
  repo-wide convention, contrary to how the PRD reads.
- `app-ci/dast` has a materially weaker capture (compose `--tail=150`, one `docker logs`, no health
  JSON, no persistence, no artifact). Standardising collection lifts it for free.
- The runner is **persistent, not ephemeral**, which is why the stable `$HOME` path works at all.
- `upload-artifact@v4` is unsupported (`GHESNotSupportedError`); v3 only.
- **Node 22 floor** — jobs without `setup-node` run the runner default image.
- A **single `kvm` runner** is a documented queueing bottleneck; the write path must add negligible
  time.

---

## R8 — Testing approach in this repo

**Decision (REVISED 2026-07-19 after feature 041 merged)**: `scripts/__tests__/*.test.mjs` is the
authoritative suite and **runs in CI**. `--selftest` stays as a thin smoke check only, not a
duplicate of the suite.

**Rationale**: `scripts/__tests__/` uses `node:test` (there is **no jest config in the repo**). Two
styles coexist: gate scripts are tested black-box via `spawnSync` exit codes; scanners export pure
functions tested in-process.

**⚠️ This finding was measured before feature 041 merged and is now SUPERSEDED.** The original
research recorded that `node --test` was never run in CI, making `--selftest` the only real contract.
Feature 041 (merged to `main` 2026-07-19) added to the `guardrails / naming` job:

```yaml
- name: Script unit tests (scripts/__tests__ — the gate scripts' own guards)
  run: node --test scripts/__tests__/*.test.mjs
```

It did so for exactly the failure class this feature guards against: *"scripts/__tests__ ran in NO
workflow, so the unit tests behind the gate scripts rotted unnoticed — sast-scan.guard.test.mjs could
not even import (`ajv` was never a root dep), i.e. a guard test that was silently 0%-executed."*

**Consequences for 042 — all favourable, but they change the work:**

1. New `scripts/__tests__/*.test.mjs` files are **automatically CI-enforced** by the existing glob. No
   workflow edit is needed to gate them.
2. They therefore **must be deterministic, offline, and token-free** — they run on every push and PR
   in a container with no forge access. The T003 fixture approach is now mandatory, not merely tidy.
3. They must use **`node:` built-ins only**. A test needing a non-root dep is the exact `ajv` failure
   041 removed.
4. `--selftest` is **no longer the sole protection**, so requiring it to duplicate every assertion is
   double maintenance for no coverage gain. It is reduced to a thin smoke check ("does this script
   load and self-check its core invariant"), with `__tests__` authoritative.

Established conventions to follow: exit codes `0` pass / `1` finding / `2` bad args; `✓`/`✗` prefixes
with the remedy inline; a script-local error class; secrets by **env, never argv**; fail-closed on tool
failure; `REPO_ROOT` re-derived per script (there is **no shared helper module** — the only cross-script
import in the directory is `zap-scan.mjs → dast-bff-login.mjs`).

---

## R9 — Nx target for the read tooling? **No.** (resolves OQ-4)

**Decision**: Direct `node scripts/ci-status.mjs` invocation.

**Rationale**: In this repo scanners get Nx targets (`dast`, `sast`, `infra-scan` in
`infrastructure-as-code/project.json`); gates do not. `ci-status.mjs` is agent-facing and invoked
constantly, where `node scripts/ci-status.mjs --sha X` beats
`pnpm nx ci-status infrastructure-as-code -- --sha X` for both ergonomics and token cost. It follows
the sanctioned `maestro-run.sh` precedent. Because no target exists, CLAUDE.md's "never invoke directly
when an Nx target exists" rule is not engaged.

---

## R10 — Open items carried into implementation

| Item | Status | Handling |
|---|---|---|
| **Guardrails keyless conflict** | ✅ **Resolved — was a non-conflict** | Feature 023's FR-004/SC-009 forbid credential *literals* and mandate the CI secret store; a `${{ secrets }}` reference complies. The prohibition existed only in a descriptive header comment, not in the requirements it cited. Both gates verified unaffected. Approved 2026-07-19 — see plan.md § Complexity Tracking. |
| Digest/bundle cap values (OQ-3) | Open | Calibrate against a real `app-e2e` failure. Start at 200 tail lines / 32 KB per source, 5 MB bundle (≈40 s at 135 KB/s). |
| act_runner overhead of ~20 `always()` steps | Unmeasured | Measure on the first real run; cap collection if not negligible. |
| Bundle retention mechanics | Resolved by clarification | 30 days, pruned opportunistically at publish; failure never fails the job. |
| Tailnet IP redaction | Gap in repo baseline | Add CGNAT range to the redactor if digest content can carry it. |
