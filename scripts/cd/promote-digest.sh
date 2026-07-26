#!/usr/bin/env bash
# cd-deploy build-deploy — "Promote digest to git (.env.deploy)".
# Extracted so it runs through scripts/ci-log-step.sh (feature 042) — its output + failing-step
# marker feed the failure digest, closing the deploy-stage blind spot the build-stage fix left.
# Inherits: ENV_DEPLOY_PATHS (workflow env), GITHUB_SHA, REF_NAME (step env). Writes
# changed=/commit= to $GITHUB_OUTPUT exactly as before (the step keeps id: promote).
set -euo pipefail
for p in $ENV_DEPLOY_PATHS; do
  mkdir -p "$(dirname "$p")"
  cp env-deploy.generated "$p"
done
git config user.name  'cd-deploy[bot]'
git config user.email 'cd-deploy@users.noreply.localhost'
if git diff --quiet -- $ENV_DEPLOY_PATHS; then
  echo "no digest change — nothing to promote"
  echo "changed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
git add $ENV_DEPLOY_PATHS
git commit -m "chore(cd): promote ${GITHUB_SHA} image digest(s) [skip ci]"
# Land on top of any concurrent change before pushing (concurrency serializes CD, but a human
# could have pushed). The committed file is regenerated, so a rebase conflict is unlikely.
git pull --rebase origin "$REF_NAME"
git push origin "HEAD:$REF_NAME"
echo "changed=true" >> "$GITHUB_OUTPUT"
echo "commit=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
echo "promoted $(grep -v '^#' env-deploy.generated | paste -sd' ' -)"
