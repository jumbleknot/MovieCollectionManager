#!/usr/bin/env bash
# Feature 027 (T002) — the single sanctioned way to run a Maestro mobile flow with secrets
# delivered OFF the command line. See specs/027-ci-maestro-secrets/contracts/maestro-run.md.
#
# WHY: passing a secret as a `maestro test … --env <credential>` argument re-serialises the live
# secret onto the `maestro` argv, where it is readable via `ps`/`/proc` on the shared homelab CI
# runner. Maestro also ingests env vars natively via a `MAESTRO_`-prefixed name (stripped to the
# bare name inside the flow: shell `MAESTRO_E2E_TEST_PASSWORD` → in-flow `${E2E_TEST_PASSWORD}`), so
# we hand secrets to Maestro through the process ENVIRONMENT and keep argv secret-free.
#
# Required secret env vars (from the CI job env, or a gitignored dev file — see below):
#   E2E_TEST_USER, E2E_TEST_PASSWORD, ANTHROPIC_API_KEY, TMDB_API_KEY
# For local dev, put these in the gitignored `frontend/mcm-app/.env.e2e.local` (matched by the
# `.gitignore` `*.env.*` rule — NEVER committed):
#   E2E_TEST_USER=testuser
#   E2E_TEST_PASSWORD=…
#   ANTHROPIC_API_KEY=sk-ant-…
#   TMDB_API_KEY=…
#
# Usage:
#   scripts/maestro-run.sh <flow-path> [extra non-secret --env pairs …]
# e.g.
#   scripts/maestro-run.sh frontend/mcm-app/tests/e2e/mobile/assistant-add.yaml --env COLLECTION_NAME="t-1"
#   (from frontend/mcm-app) ../../scripts/maestro-run.sh tests/e2e/mobile/login-keycloak.yaml
#
# Fail-clean (G3): a required secret being unset exports NOTHING for it — no `:-literal` fallback —
# so the flow fails visibly at the step that needs the value rather than running with an empty one.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/maestro-run.sh <flow-path> [extra non-secret --env pairs …]" >&2
  exit 2
fi

# Repo root is the parent of this script's dir (scripts/), independent of the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Source the gitignored dev credential file if present (`set -a` auto-exports every KEY=value).
#    Absent file is a no-op — CI relies on the job env already holding the secrets.
DEV_ENV_FILE="$REPO_ROOT/frontend/mcm-app/.env.e2e.local"
if [ -f "$DEV_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$DEV_ENV_FILE"
  set +a
fi

# 2. For each known secret, export the MAESTRO_-prefixed twin ONLY when set and non-empty. No
#    literal, no placeholder for an unset value (fail-clean, G3). TMDB_API_KEY unset is silently
#    skipped (optional). Maestro strips the prefix in-flow, so flow-body `${NAME}` refs are unchanged.
for name in E2E_TEST_USER E2E_TEST_PASSWORD ANTHROPIC_API_KEY TMDB_API_KEY; do
  # Indirect expansion: value of the variable named by $name.
  value="${!name:-}"
  if [ -n "$value" ]; then
    export "MAESTRO_$name=$value"
  fi
done

# 3. Hand off to Maestro. `exec` makes the wrapper's exit code Maestro's (G4 — the CI retry loop is
#    unaffected). The flow path + any forwarded non-secret args are the ONLY argv; no secret value
#    appears there (G1).
exec maestro test "$@"
