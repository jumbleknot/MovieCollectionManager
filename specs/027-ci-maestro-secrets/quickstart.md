# Quickstart / Validation: Keep E2E Secrets Off the Test-Runner Command Line

Runnable checks that prove the feature works end-to-end. Details of the wrapper and guard live in
[contracts/](./contracts/); do not duplicate implementation here.

## Prerequisites

- Repo checked out on branch `027-ci-maestro-secrets`; `scripts/maestro-run.sh` and
  `scripts/check-no-argv-secrets.mjs` implemented.
- For the behavioral flow run: Android emulator up + APK installed + `adb reverse` set (see
  [docs/runbooks/android-emulator.md](../../docs/runbooks/android-emulator.md)); the auth + mcm stacks
  running.
- Dev credentials in gitignored `frontend/mcm-app/.env.e2e.local`:

  ```text
  E2E_TEST_USER=testuser
  E2E_TEST_PASSWORD=…
  ANTHROPIC_API_KEY=sk-ant-…
  TMDB_API_KEY=…
  ```

## V1 — Guard self-test (keyless, no emulator) — SC-005

```bash
node scripts/check-no-argv-secrets.mjs --selftest
```

**Expected**: `✅ detects planted --env SECRET=; clean tree passes` (exit 0). Proves the guard catches a
planted `--env E2E_TEST_PASSWORD=…` line and does not flag `scripts/maestro-run.sh …` or non-secret
`--env COLLECTION_NAME=…`.

## V2 — Guard scan of the cleaned tree — SC-004

```bash
node scripts/check-no-argv-secrets.mjs
```

**Expected**: `✅ no argv-secret arguments to the test runner` (exit 0) after the CI runner + flow headers
+ docs are repointed. RED before the cleanup: it lists the `scripts/ci-mobile-agent-flows.sh` `--env`
lines. (Historical `specs/0NN/**` never appear — allowlisted.)

## V3 — In-flow variable parity smoke (single flow) — R2 confirmation, SC-003

From `frontend/mcm-app` with `.env.e2e.local` present:

```bash
../../scripts/maestro-run.sh tests/e2e/mobile/login-keycloak.yaml
```

**Expected**: the flow logs in successfully with **no secret typed on the command line**, proving
`MAESTRO_E2E_TEST_PASSWORD` reaches the flow as `${E2E_TEST_PASSWORD}` (prefix stripped).

## V4 — No secret in the process list during a run — SC-001 (the core outcome)

While V3 (or the CI suite) is running, from another shell on the same host:

```bash
# no known secret value should appear in any maestro/child argv
ps -ww -ef | grep -i maestro | grep -Ei 'E2E_TEST_PASSWORD=|ANTHROPIC_API_KEY=|sk-ant-|TMDB_API_KEY=' && echo "LEAK" || echo "clean"
```

**Expected**: `clean` (grep finds nothing). Contrast: the pre-change `maestro test … --env
E2E_TEST_PASSWORD=… ` would show the literal value here.

## V5 — CI agent-flow suite via the wrapper — SC-002

```bash
bash scripts/ci-mobile-agent-flows.sh   # run_flow() now calls scripts/maestro-run.sh; no --env secrets
```

**Expected**: the full flow list (gating → enable-anthropic → 4 agent flows → disable) runs green, and a
concurrent V4 check stays `clean`.

## V6 — Fail-clean on unset required secret — SC-006

```bash
env -u E2E_TEST_PASSWORD ../../scripts/maestro-run.sh tests/e2e/mobile/login-keycloak.yaml; echo "exit=$?"
```

**Expected**: non-zero exit with the flow failing visibly at the login step — **not** a silent run with an
empty/placeholder password. Confirms no `:-literal` fallback.

## V7 — Existing secret gates stay green — SC-007

```bash
node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs
node scripts/check-no-inline-secrets.mjs --selftest && node scripts/check-no-inline-secrets.mjs
```

**Expected**: both pass; no secret value added to git (the `.env.e2e.local` credential file is gitignored).
