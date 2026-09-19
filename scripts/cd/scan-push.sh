#!/usr/bin/env bash
# cd-deploy build-deploy — "Scan, push (by tag + digest), build manifest + promotion file".
#
# Extracted from the workflow so it runs through scripts/ci-log-step.sh (feature 042): the Trivy
# CRITICAL table + push output are mirrored to the failure-digest log dir and the failing-step marker
# is recorded. This is the exact step that blocked the deploy on the npm-bundled-tar CVE with a digest
# that could not name it. Body is verbatim from the prior inline step.
#
# Inherits env from the workflow step/job: REGISTRY, NS, REGISTRY_USER, REGISTRY_TOKEN, GITHUB_SHA,
# GITHUB_OUTPUT. Writes deploy-manifest.json / env-deploy.body / env-deploy.generated to the CWD and
# `manifest=` to $GITHUB_OUTPUT (the step keeps id: publish), exactly as before.
set -euo pipefail
: "${REGISTRY:?set REGISTRY var}" "${NS:?set NS var}" "${REGISTRY_USER:?set REGISTRY_USER var}"
echo "$REGISTRY_TOKEN" | docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin
# local-tag : registry-repo  (per contracts/image-and-digest-promotion.md)
map="mc-service:latest=mc-service mcm-bff:latest=mcm-bff agent-gateway:latest=agent-gateway \
     movie-mcp:latest=movie-mcp web-api-mcp:latest=web-api-mcp spreadsheet-mcp:latest=spreadsheet-mcp"
entries=""
: > env-deploy.body
for pair in $map; do
  local_tag="${pair%%=*}"; repo="${pair##*=}"
  ref="${REGISTRY}/${NS}/${repo}:${GITHUB_SHA}"
  docker tag "$local_tag" "$ref"
  # ── CVE scan: TWO commands, because there are TWO meanings (item #499) ───────────────────────
  #
  # This was `trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed`, and it had two
  # defects that compounded. It had NO RETRY, against the same vulnerability-DB registry that
  # produced a measured coin-flip on the sibling path (item #495 — runs 3619/3622, same commit,
  # one pass and one fail nine minutes apart). And `--exit-code 1` sets the code Trivy returns
  # when it FINDS something, while Trivy also exits 1 on an ERROR — so the step could not tell the
  # operator which had happened, and the obvious reading ("a fixable Critical blocked the deploy")
  # was the wrong one roughly half the time it fired.
  #
  # A bigger flag does not fix that; splitting the two meanings across two commands does. This is
  # the same pipeline minio-image.yml has run since feature 069, so it INHERITS #495's bounded
  # retry, the severity map and the reviewed allowlist rather than growing a second signature list
  # in bash — which the item names as the outcome to avoid.
  #
  # POLICY IS UNCHANGED: normalizeTrivy() marks blocking = Critical AND a fix exists upstream,
  # which is exactly what `--severity CRITICAL --ignore-unfixed` meant. agent-gateway's
  # fix-deferred perl-base CVEs still do not dead-end the deploy. What is NEW is that an accepted
  # finding now has somewhere to live (security/infra-images/allowlist.yaml) that the weekly
  # expiry check actually reads — instead of a .trivyignore nobody reviews.
  echo "── CVE scan $repo (un-allowlisted fixable CRITICAL blocks the push) ──"
  # Scans with --format json and NO --exit-code, so a non-zero status here can ONLY mean the
  # scanner could not run. Each retry is reported on stderr, so the failure digest carries it.
  if ! node scripts/infra-image-scan.mjs --image "$local_tag"; then
    echo "✗ SCANNER ERROR for $repo — Trivy could not complete: a transport/service failure that"
    echo "  survived its bounded retries, or a scanner fault. This is NOT a vulnerability verdict —"
    echo "  nothing was assessed and no finding is being reported. Failing closed (an image that was"
    echo "  not scanned must never be pushed); cd-deploy is re-dispatchable via workflow_dispatch."
    exit 1
  fi
  # The VERDICT, from the normalized report the scan just wrote. Non-zero here means a finding.
  if ! node scripts/check-infra-image-findings.mjs; then
    echo "✗ BLOCKING FINDING in $repo — an un-allowlisted fixable CRITICAL. This IS a vulnerability"
    echo "  verdict: the scan ran and found something with an upstream fix available. Patch it, or add"
    echo "  a reviewed, justified, expiring entry to security/infra-images/allowlist.yaml."
    exit 1
  fi
  docker push "$ref"
  digest=$(docker inspect --format='{{index .RepoDigests 0}}' "$ref" | cut -d'@' -f2)
  pinned="${REGISTRY}/${NS}/${repo}@${digest}"
  echo "$repo -> $pinned"
  # Assemble the run manifest in pure shell (no jq/python dependency on the runner).
  # The manifest is a job-local artifact (never committed) so it may carry the full ref.
  entry="\"$repo\":{\"tag\":\"$ref\",\"digest\":\"$pinned\"}"
  entries="${entries:+$entries,}$entry"
  # Promotion file body: VAR=<BARE sha256 digest> — HOST-FREE (R10, T029). No registry host
  # in git: the compose assembles ${REGISTRY_HOST}/jumbleknot/<repo>@${<REPO>_DIGEST}, with
  # REGISTRY_HOST injected from the gitignored .env.prod (Komodo). $digest is already the bare
  # `sha256:…` (cut from RepoDigests above). var = <REPO_UPPER>_DIGEST (mcm-bff → MCM_BFF_DIGEST).
  varname="$(echo "$repo" | tr 'a-z-' 'A-Z_')_DIGEST"
  echo "${varname}=${digest}" >> env-deploy.body
done
manifest="{$entries}"
echo "$manifest" > deploy-manifest.json
echo "manifest=$manifest" >> "$GITHUB_OUTPUT"
# Final .env.deploy content (header + the VAR=<bare digest> lines). The deploy job drops this in.
{
  echo "# GENERATED by cd-deploy (${GITHUB_SHA}) — digest-by-git promotion. DO NOT EDIT BY HAND."
  echo "# Each VAR pins the immutable BARE sha256 digest CI built+scanned+pushed this run."
  echo "# HOST-FREE (R10): no registry host here — the compose assembles the full ref as"
  echo "#   image: \${REGISTRY_HOST}/jumbleknot/<svc>@\${<SVC>_DIGEST}"
  echo "# with REGISTRY_HOST from the gitignored .env.prod (Komodo Variable)."
  echo "# Komodo wiring: prod-mcm-bff Stack — Run Directory infrastructure-as-code/docker/bff,"
  echo "# Env File Path .env.prod (secrets + REGISTRY_HOST), Additional Env Files .env.deploy"
  echo "# (this file). Komodo runs: docker compose --env-file .env.prod --env-file .env.deploy up"
  echo "# so \${MCM_BFF_DIGEST} interpolates from HERE (git), REGISTRY_HOST + secrets from .env.prod."
  cat env-deploy.body
} > env-deploy.generated
echo "── generated .env.deploy (written to all prod stack dirs) ──"; cat env-deploy.generated
