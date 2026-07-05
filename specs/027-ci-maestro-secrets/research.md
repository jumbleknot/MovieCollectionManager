# Phase 0 Research: Keep E2E Secrets Off the Test-Runner Command Line

## R1 — How to hand secrets to Maestro without placing them on argv

**Decision**: Use Maestro's `MAESTRO_`-prefixed shell-environment ingestion. Export each secret as
`MAESTRO_<NAME>` in the wrapper's environment before calling `maestro test <flow>`; pass no `--env`
secret on the command line.

**Rationale**: Maestro automatically reads shell env vars prefixed with `MAESTRO_` and exposes them to
flows — this is the documented, first-class channel for CI secrets and never touches argv. The secrets
are already in the CI job's process environment (`app-ci.yml` `app-e2e` sets `E2E_TEST_USER`,
`E2E_TEST_PASSWORD`, `ANTHROPIC_API_KEY`, `TMDB_API_KEY` as job-level `env:`), so the wrapper only
re-exports them under the prefix.

**Alternatives considered**:
- **`--env-file` flag** — not supported by Maestro (open upstream request mobile-dev-inc/Maestro#2817).
  A file path on argv would have been acceptable, but the flag does not exist.
- **Temp env-file `set -a; source`d, then `--env`** — still leaks on argv unless combined with the
  `MAESTRO_` prefix, at which point the file is pure overhead (secrets are already in the job env).
  Adds a `0600` file + cleanup `trap` for no security gain. Rejected.

**Sources**: [Maestro CLI — Environment variables](https://docs.maestro.dev/maestro-cli/environment-variables),
[Maestro — Parameters and constants](https://docs.maestro.dev/maestro-flows/flow-control-and-logic/parameters-and-constants),
[Maestro#2817 — .env file support](https://github.com/mobile-dev-inc/Maestro/issues/2817).

## R2 — In-flow variable naming under the `MAESTRO_` prefix (the spec's deferred spike)

**Decision**: Maestro **strips the prefix** in-flow. Shell `MAESTRO_E2E_TEST_PASSWORD` is referenced
inside the flow as `${E2E_TEST_PASSWORD}`. Therefore existing flow-body references
(`${E2E_TEST_USER}`, `${E2E_TEST_PASSWORD}`, `${ANTHROPIC_API_KEY}`, `${TMDB_API_KEY}`) are **unchanged**
— only the `# Run:` header comments and the invocation commands change.

**Rationale**: The Maestro docs give the canonical example — shell `MAESTRO_USERNAME` / `MAESTRO_PASSWORD`
are used in the flow as `${USERNAME}` / `${PASSWORD}` (prefix dropped). This collapses the spec's
"implementation-time spike (blocking the doc churn)" from a blocker to a one-line smoke check performed
during the first wrapper run; the doc/flow-header cleanup can proceed in parallel with confidence.

**Residual verification**: A single smoke run (`export MAESTRO_E2E_TEST_PASSWORD=…; scripts/maestro-run.sh
tests/e2e/mobile/login-keycloak.yaml`) confirms the login step still authenticates before the bulk edit
is trusted. If (contrary to docs) the prefix were retained, the wrapper would additionally export the
unprefixed name — a wrapper-only change, no flow edits — keeping the blast radius contained.

**Sources**: [Maestro — Parameters and constants](https://docs.maestro.dev/maestro-flows/flow-control-and-logic/parameters-and-constants).

## R3 — Where the regression guard lives and how it is shaped

**Decision**: New keyless Node script `scripts/check-no-argv-secrets.mjs`, modeled on
`scripts/secret-scan.mjs` / `scripts/check-no-inline-secrets.mjs` (same `--selftest` + scan shape, same
`git ls-files` tree walk), wired as a step in the **`naming` job of `.forgejo/workflows/guardrails.yml`**
alongside the other keyless `--selftest`-then-scan gates.

**Rationale**: Matches the established gate pattern (self-validating detector + tree scan, keyless, runs
on every push/PR, gates the commit). `guardrails.yml` is already a required branch-protection check, so
the guard becomes blocking with no extra CI plumbing. Keeping it a separate script (not folding into
`secret-scan.mjs`) keeps concerns clean: `secret-scan` finds credential-shaped *values*; this guard finds
a credential-shaped *argument pattern* (`--env <name-matching-KEY|PASSWORD|SECRET|TOKEN>=`) regardless of
whether the value is a real secret.

**Detection rule**: flag `--env`/`-e` immediately followed by a key whose name matches
`(KEY|PASSWORD|SECRET|TOKEN)` (case-insensitive) with an `=` assignment, in the context of a `maestro`
invocation. Allow non-secret `--env` args (e.g. `COLLECTION_NAME`, `E2E_TEST_USER`). Tolerate quoting and
backslash line-continuation.

**Allowlist**: exclude `specs/0NN/**` (historical records, per the spec clarification) and the guard's own
source (it holds the pattern as regex, like `secret-scan.mjs` excludes `SELF`).

**Alternatives considered**: Extend `secret-scan.mjs` — rejected: conflates value-detection with
argument-shape detection and complicates that gate's self-test. A git pre-commit hook only — rejected:
not enforced in CI, bypassable with `--no-verify`.

**Sources**: repo files `scripts/secret-scan.mjs`, `scripts/check-no-inline-secrets.mjs`,
`.forgejo/workflows/guardrails.yml`.

## R4 — Dev credential source for the sanctioned local path

**Decision**: The wrapper sources `frontend/mcm-app/.env.e2e.local` if present (a `KEY=value` dotenv),
`export`s the values, then applies the `MAESTRO_` prefixing. The file is already gitignored by the
`.gitignore` `*.env.*` rule; no new ignore entry needed.

**Rationale**: `.env.e2e.local` is the already-documented home for the E2E test password (per the 012
HANDOFF), so this formalizes existing practice. Sourcing is best-effort: absent file + absent env → the
fail-clean path (R5) triggers, never a silent empty-credential run.

**Sources**: repo `.gitignore` (`*.env.*`), `specs/012-multi-agent-mvp/HANDOFF.md` (historical, referenced
not modified).

## R5 — Fail-clean on unset required secret

**Decision**: For each required secret the wrapper checks presence; if unset it exports nothing for that
name (no literal/placeholder) and lets the flow fail visibly at the step that needs the value. No
`${VAR:-literal}` default, no `?? 'literal'`. Optional secrets (a legitimately-absent provider key) are
skipped silently.

**Rationale**: The constitution's Secrets Management rule and features 021/022 explicitly prohibit
`:-literal` fallbacks (that is exactly how prior literals leaked). A visible failure is the correct
signal; a defaulted placeholder would mask a misconfigured runner and could run a flow against a wrong
credential.

**Sources**: constitution §Data Protection — Secrets Management; `CLAUDE.md` "no `:-literal` / `?? 'literal'`
fallback" rule; `scripts/gen-dev-secrets.mjs` fail-fast precedent.
