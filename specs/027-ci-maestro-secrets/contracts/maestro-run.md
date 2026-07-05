# Contract: `scripts/maestro-run.sh`

The single sanctioned way to run a Maestro mobile flow with secrets delivered off the command line.

## Invocation

```text
scripts/maestro-run.sh <flow-path> [extra non-secret --env pairs …]
```

- `<flow-path>` — required. Path to a Maestro flow YAML (repo-root-relative, e.g.
  `frontend/mcm-app/tests/e2e/mobile/assistant-add.yaml`, or the `tests/e2e/mobile/…` form when cwd is
  `frontend/mcm-app`). Passed through to `maestro test`.
- Any further arguments are forwarded verbatim to `maestro test` and MUST be non-secret only (e.g.
  `--env COLLECTION_NAME="t038-add-123"`). Passing a credential here defeats the purpose and is a caller
  error (the guard flags such usage in tracked files).

## Behavior

1. If `frontend/mcm-app/.env.e2e.local` exists, source it (`set -a` / `source` a `KEY=value` dotenv) so
   developer credentials enter the environment. Absent file is a no-op (CI relies on the job env).
2. For each known secret name — `E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `ANTHROPIC_API_KEY`, `TMDB_API_KEY`:
   - if set and non-empty in the environment → `export MAESTRO_<NAME>="${<NAME>}"`;
   - if unset/empty → export nothing for that name (no literal, no placeholder).
3. `exec maestro test "<flow-path>" [forwarded non-secret args…]` — the process inherits the
   `MAESTRO_*` environment; **no secret value appears in argv**.

## Guarantees (contract)

- **G1 — No secret on argv**: no known-secret value is present in the argv of the `maestro` process or
  any child it spawns. (Verified by SC-001 `ps`/`/proc` inspection.)
- **G2 — Behavior parity**: flows referencing `${E2E_TEST_PASSWORD}` / `${ANTHROPIC_API_KEY}` /
  `${TMDB_API_KEY}` / `${E2E_TEST_USER}` receive identical values to the previous `--env` invocation
  (Maestro strips the `MAESTRO_` prefix in-flow).
- **G3 — Fail-clean**: a required secret being unset does not substitute a literal; the flow fails at the
  step that needs the value. Exit code is Maestro's non-zero. An optional secret (`TMDB_API_KEY`) unset is
  skipped silently.
- **G4 — Exit passthrough**: the wrapper's exit code is Maestro's exit code (via `exec`), so the CI
  runner's retry/attempt loop is unaffected.

## Non-goals

- Does not set up the emulator, `adb reverse`, or the APK (the CI runner and dev docs own that).
- Does not manage which secrets exist or how CI injects them.
- Not an Nx target — it is the sanctioned direct `maestro test` wrapper (see plan Complexity Tracking).
