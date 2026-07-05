# PRD — Keep E2E Secrets Off the Maestro Command Line

**Status:** Proposed
**Created:** 2026-07-05
**Context:** Follow-up hardening from feature 023 (homelab CI/CD). Observed while inspecting the
self-hosted Forgejo `act_runner`: the mobile agent E2E flows pass secrets as `maestro test … --env`
arguments, so the values are visible in `ps` output on the shared runner host.
**Related:** [scripts/ci-mobile-agent-flows.sh](../../../scripts/ci-mobile-agent-flows.sh),
[.forgejo/workflows/app-ci.yml](../../../.forgejo/workflows/app-ci.yml),
[docs/runbooks/android-emulator.md](../../runbooks/android-emulator.md),
constitution §Secrets Management, features 021/022 (no clear-text secrets; secret-scan gate).

---

## 1. Context & motivation

The mobile agent E2E suite runs on a self-hosted Forgejo Actions `act_runner` (homelab). The runner
script invokes Maestro once per flow and forwards four secrets on the command line:

```bash
# scripts/ci-mobile-agent-flows.sh — run_flow()
maestro test "frontend/mcm-app/tests/e2e/mobile/$1.yaml" \
  --env E2E_TEST_USER="$E2E_TEST_USER" \
  --env E2E_TEST_PASSWORD="$E2E_TEST_PASSWORD" \
  --env ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --env TMDB_API_KEY="${TMDB_API_KEY:-}"
```

The shell expands each `$VAR` **before** exec, so the literal secret values become `argv` of the
`maestro` process (and any child it spawns). On the runner host, `argv` is world-readable to any
local account via `ps -ef` / `/proc/<pid>/cmdline`. The homelab runner is a **shared host** — the
`ci@homelab` account (used for log retrieval, per the CI-monitor runbook) and any co-tenant process
can read `E2E_TEST_PASSWORD`, `ANTHROPIC_API_KEY`, and `TMDB_API_KEY` for the duration of a run.

This is **not** a git-committed-secret gap (features 021/022 already close that), and the values are
short-lived test/API credentials — but `argv` exposure of a live secret on a shared host is exactly
the kind of single-layer leak the constitution's Secrets Management principle asks us to close. The
same `--env <secret>=…` habit is copy-pasted across ~30 flow-file header comments and several
spec/runbook snippets, so it also propagates as the "how you run a flow" example.

## 2. Current state (2026-07-05)

- **Secrets already exist in the runner's process environment.** The Forgejo job injects
  `E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `ANTHROPIC_API_KEY`, `TMDB_API_KEY` from the Actions secret
  store into the job env (documented in the script's header comment). `run_flow()` then *re-serialises*
  them onto `argv` via `--env`. The environment path is safe; the `argv` re-exposure is the only leak.
- **Maestro's env model** (verified against the docs):
  - `-e` / `--env KEY=value` — passes a value on the command line (the current, leaky path).
  - **`MAESTRO_`-prefixed shell env vars are auto-ingested** and exposed to flows — no CLI flag, so
    the value never touches `argv`. This is the native, argv-free mechanism.
  - No `--env-file` flag exists (open upstream feature request #2817), so a file-path-on-argv approach
    is not available.
- **Dev-local invocation** uses the same `--env PASSWORD=…` form (from flow-file comments / runbooks).
  On a single-user dev machine `ps` exposure is not a meaningful threat, but the inconsistent
  invocation pattern is what keeps seeding the CI habit.

## 3. Problem statement

Live E2E secrets are placed on the Maestro process `argv` on a **shared** CI host, making them
readable to any local account for the lifetime of each flow. There is no single sanctioned,
argv-free way to run a Maestro flow, so the leaky pattern is duplicated across CI, ~30 flow files,
and the docs.

## 4. Goals / Non-goals

**Goals**
- G1 — No E2E secret value appears on any `maestro` (or child) `argv` during a CI run.
- G2 — One reusable, sanctioned invocation path used by **both** CI and dev, so the argv-secret
  pattern is not re-introduced by copy-paste.
- G3 — Preserve the constitution's secrets guarantees: no clear-text in git, **fail-clean when a
  secret is unset** (no `:-literal` / `?? 'literal'` fallback).
- G4 — A CI guard that fails the build if a tracked script/doc re-introduces `--env <secret>=`.

**Non-goals**
- Changing which secrets exist or how the Forgejo job injects them into the environment.
- The web (Playwright) E2E path — it does not use Maestro and is unaffected.
- Maestro Cloud / `maestro cloud` (not used here).
- Encrypting or rotating the test credentials themselves.

## 5. Approach

**Chosen: `MAESTRO_`-prefixed environment variables, delivered by a reusable wrapper.**

Maestro auto-ingests `MAESTRO_*` shell env vars and exposes them to flows, so the secret travels via
the process environment (already how the CI job holds it) and **never lands on `argv`**. A thin
wrapper centralises the prefixing so there is exactly one blessed way to run a flow.

### 5.1 New: `scripts/maestro-run.sh <flow-path> [extra non-secret --env pairs…]`
- Sources a gitignored `frontend/mcm-app/.env.e2e.local` **if present** (the already-documented home
  for `E2E_TEST_PASSWORD`), so dev runs need no secret on the command line. CI relies on the job env
  and needs no file.
- For each known secret name (`E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `ANTHROPIC_API_KEY`,
  `TMDB_API_KEY`): if set in the environment, `export MAESTRO_<NAME>="$<NAME>"`; if unset, **skip it**
  (no literal fallback — G3). An always-required secret being unset fails cleanly downstream in the
  flow rather than being masked by a default.
- `exec maestro test "$flow"` — forwarding only caller-supplied **non-secret** `--env` args (e.g.
  `COLLECTION_NAME`), which are safe on `argv`.
- Header comment documents this as the single sanctioned invocation path.

### 5.2 In-flow variable naming — implementation-time spike (blocking the doc churn)
The Maestro docs are ambiguous on whether `MAESTRO_FOO` is exposed inside a flow as `${FOO}` or as
`${MAESTRO_FOO}`. Before editing any flow, confirm empirically with a one-line throwaway flow
(`export MAESTRO_PROBE=hello; maestro test probe.yaml` asserting `${PROBE}` vs `${MAESTRO_PROBE}`):
- If exposed **prefix-stripped** (`${FOO}`) — existing flow references (`${E2E_TEST_PASSWORD}`, etc.)
  work unchanged; only the invocation scripts/docs change.
- If exposed **with the prefix** (`${MAESTRO_FOO}`) — either the wrapper re-maps into the unprefixed
  name too, or the flow references are renamed. Prefer whichever keeps the flow `${…}` references
  unchanged so the blast radius stays in the wrapper.

### 5.3 CI: `scripts/ci-mobile-agent-flows.sh`
`run_flow()` drops its four `--env` secret lines and calls `scripts/maestro-run.sh "$1"`. The job env
is unchanged; the secrets simply stop being re-serialised onto `argv`.

### 5.4 Docs: repoint the invocation examples
Update the ~30 flow-file header comments and the spec/runbook snippets from
`maestro test … --env E2E_TEST_PASSWORD=… --env ANTHROPIC_API_KEY=…` to
`scripts/maestro-run.sh tests/e2e/mobile/<flow>.yaml [--env COLLECTION_NAME=…]`. Mechanical, bulk edit.

### 5.5 Guard (extends the feature 021/022 secret-scan culture)
Add a check (a small script wired into the `guardrails.yml` `secret-scan`/`naming` job, or a new
gate) that greps the tracked tree and **fails** on any `maestro … --env` argument whose key matches
`(KEY|PASSWORD|SECRET|TOKEN)` (case-insensitive). This prevents the pattern from creeping back into a
new flow or doc. Non-secret `--env COLLECTION_NAME=…` etc. remain allowed.

## 6. Alternatives considered

- **Temp env-file `set -a; source`d into the wrapper.** Write secrets to a `0600` temp file, source
  it, then still rely on the `MAESTRO_` prefix. No security gain over §5 (the secrets are already in
  the job env), and it adds a file + cleanup `trap`. Rejected as avoidable complexity.
- **`--env-file` flag.** Would let a file *path* (not the secret) sit on `argv`. Not supported by
  Maestro (upstream feature request #2817 still open). Rejected as unavailable.

## 7. Acceptance criteria

- During a CI flow run, `ps -ef` / `/proc/<pid>/cmdline` for the `maestro` process and its children
  shows **no** secret value (verified by grepping the running `argv` for the known secret substrings
  → zero matches).
- Both CI and a dev invocation run the full agent-flow list green through `scripts/maestro-run.sh`
  with no secret on the command line.
- The new guard fails on a deliberately-added `--env E2E_TEST_PASSWORD=…` line (self-test) and passes
  on the cleaned tree.
- No secret in git; the existing inline-secret + secret-scan gates stay green.
- Fail-clean confirmed: with a secret unset, the wrapper does not substitute a literal and the flow
  fails visibly rather than silently running with an empty/placeholder credential.

## 8. Sequencing

1. Spike §5.2 (in-flow variable naming) — 10 minutes, unblocks the doc churn shape.
2. Land `scripts/maestro-run.sh` (§5.1) + repoint `ci-mobile-agent-flows.sh` (§5.3). Validate the CI
   suite green and confirm the `ps` acceptance check.
3. Bulk doc/flow-comment repoint (§5.4).
4. Add the guard (§5.5) with a self-test, wire into `guardrails.yml`.

## 9. Open questions

- Exact in-flow variable name under the `MAESTRO_` prefix (resolved by the §5.2 spike).
- Where the guard lives: extend `scripts/secret-scan.mjs` vs a new `scripts/check-no-argv-secrets.mjs`
  invoked by the same `guardrails.yml` job.

## 10. Out of scope

Web (Playwright) E2E, Maestro Cloud, the identity of the test/API credentials, and the Forgejo
secret-injection mechanism (all unchanged).
