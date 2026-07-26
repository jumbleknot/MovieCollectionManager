#!/usr/bin/env bash
# cd-deploy build-deploy — "Post-deploy health probe (issuer + app health)".
# Extracted for failure-digest coverage (feature 042). Inherits BASE_DOMAIN from the step env.
# Its exit code is preserved by ci-log-step.sh, so `steps.probe.outcome` still drives rollback.
set -euo pipefail
: "${BASE_DOMAIN:?set BASE_DOMAIN var}"
# Komodo needs time to pull + recreate; poll briefly for convergence.
# A Keycloak realm's OIDC issuer is "<base>/realms/<realm>", so the expected value MUST
# include the realm path — comparing to the bare "https://auth.${BASE_DOMAIN}" never matches
# and the probe fails on a perfectly healthy app (2026-07-02: first deploy=true run, app=200
# + issuer resolving every attempt, yet failed 30/30).
expected_iss="https://auth.${BASE_DOMAIN}/realms/grumpyrobot"
for i in $(seq 1 30); do
  iss=$(curl -fsS "https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration" \
          | grep -o '"issuer":"[^"]*"' | cut -d'"' -f4 || true)
  app=$(curl -s -o /dev/null -w '%{http_code}' "https://mcm.${BASE_DOMAIN}" || echo 000)
  if [ "$iss" = "$expected_iss" ] && [ "$app" = "200" ]; then
    echo "probe ok (issuer + app health)"; exit 0
  fi
  echo "probe attempt $i: issuer='$iss' app=$app — waiting"; sleep 10
done
echo "::error::post-deploy probe failed"; exit 1
