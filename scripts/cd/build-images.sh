#!/usr/bin/env bash
# cd-deploy build-deploy — "Build images (Nx targets)".
#
# Extracted from the workflow so it runs through scripts/ci-log-step.sh, which mirrors this step's
# output to the failure-digest log dir and records the failing-step marker (feature 042). Before
# this, a build/Trivy failure in cd-deploy produced a digest that said "failing step: not reported"
# with only stale app-e2e evidence — the one CI job 042's own diagnostics could not diagnose.
#
# Inherits env from the workflow step/job: EXPO_PUBLIC_KEYCLOAK_URL (built from vars.BASE_DOMAIN).
set -euo pipefail

# Fail loudly if BASE_DOMAIN is unset (would bake a dead "https://auth." host into the web app).
if [ "${EXPO_PUBLIC_KEYCLOAK_URL:-}" = "https://auth." ]; then
  echo "::error::BASE_DOMAIN Forgejo variable is unset — the web bundle would bake a broken Keycloak host. Set vars.BASE_DOMAIN and re-run."
  exit 1
fi
pnpm nx run-many --target=build --projects=mc-service,movie-assistant,movie-mcp,web-api-mcp,spreadsheet-mcp
pnpm nx docker-build mcm-app
