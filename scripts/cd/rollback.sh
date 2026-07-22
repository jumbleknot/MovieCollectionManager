#!/usr/bin/env bash
# cd-deploy build-deploy — "Rollback to prior digest on probe failure".
# Extracted for failure-digest coverage (feature 042). Inherits KOMODO_WEBHOOK_URL,
# KOMODO_WEBHOOK_AUTH, PROMOTE_COMMIT, REF_NAME, GH_REF from the step env. Ends in exit 1
# (fails the run for operator attention) — ci-log-step.sh re-raises it.
set -euo pipefail
echo "Probe failed — reverting promotion ${PROMOTE_COMMIT} (redeploy prior digest)"
git revert --no-edit "$PROMOTE_COMMIT"
# `[skip ci]` so the revert commit doesn't re-trigger cd-deploy.
git commit --amend -m "revert(cd): roll back failed deploy ${GITHUB_SHA} to prior digest [skip ci]"
git pull --rebase origin "$REF_NAME"
git push origin "HEAD:$REF_NAME"
: "${KOMODO_WEBHOOK_URL:?}" "${KOMODO_WEBHOOK_AUTH:?}"
printf '{"ref":"%s"}' "$GH_REF" > webhook-payload.json
sig="sha256=$(openssl dgst -sha256 -hmac "$KOMODO_WEBHOOK_AUTH" webhook-payload.json | sed 's/^.*= *//')"
for url in $KOMODO_WEBHOOK_URL; do
  echo "→ rollback redeploy $url"
  curl -fsSL -X POST "$url" \
    -H 'content-type: application/json' \
    -H 'X-GitHub-Event: push' \
    -H "X-Hub-Signature-256: ${sig}" \
    --data-binary @webhook-payload.json
done
echo "::error::deploy rolled back to prior digest after failed health probe"
exit 1
