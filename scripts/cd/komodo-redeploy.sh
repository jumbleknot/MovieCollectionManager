#!/usr/bin/env bash
# cd-deploy build-deploy — "Fire signed Komodo redeploy webhook(s)".
# Extracted for failure-digest coverage (feature 042). Inherits KOMODO_WEBHOOK_URL,
# KOMODO_WEBHOOK_AUTH, GH_REF from the step env.
set -euo pipefail
: "${KOMODO_WEBHOOK_URL:?set KOMODO_WEBHOOK_URL var}" "${KOMODO_WEBHOOK_AUTH:?set KOMODO_WEBHOOK_AUTH secret}"
printf '{"ref":"%s"}' "$GH_REF" > webhook-payload.json
sig="sha256=$(openssl dgst -sha256 -hmac "$KOMODO_WEBHOOK_AUTH" webhook-payload.json | sed 's/^.*= *//')"
for url in $KOMODO_WEBHOOK_URL; do
  echo "→ redeploy $url"
  curl -fsSL -X POST "$url" \
    -H 'content-type: application/json' \
    -H 'X-GitHub-Event: push' \
    -H "X-Hub-Signature-256: ${sig}" \
    --data-binary @webhook-payload.json
done
