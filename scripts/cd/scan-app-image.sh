#!/usr/bin/env bash
# Scan ONE local app image and return the deploy gate's verdict (spec 084 US3, FR-013/FR-014).
#
# The per-image body of scan-push.sh, extracted so the PR and the deploy run the SAME pipeline:
# cd-deploy's scan-push.sh calls it before each push, and app-ci's `app-image-scan` job calls it on
# the six images app-e2e built. One script means one set of flags and one allowlist
# (security/infra-images/allowlist.yaml). The Trivy version is pinned where each workflow installs it,
# and renovate-workflow.guard.test.mjs fails if those pins disagree. The drift guard in
# scripts/__tests__/app-image-scan.test.mjs fails if either caller starts scanning on its own.
#
#   scan-app-image.sh <local-tag>
#
# Exit: 0 scanned, no un-allowlisted fixable CRITICAL · 10 SCANNER ERROR (nothing was assessed) ·
#       11 BLOCKING FINDING (the verdict's table above names the image and the CVE) · 2 usage.
#
# Each caller maps 10 and 11 to its own message: what to do next differs between a PR and a deploy.
set -uo pipefail

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  echo "usage: scan-app-image.sh <local-tag>   (exactly one image)" >&2
  exit 2
fi
local_tag=$1
repo=${local_tag%%:*}
repo=${repo##*/}

# ── CVE scan: TWO commands, because there are TWO meanings (item #499) ─────────────────────────
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
# the same pipeline feature 069's object-store image workflow ran (deleted by feature 080), so it
# INHERITS #495's bounded retry, the severity map and the reviewed allowlist rather than growing a
# second signature list in bash — which the item names as the outcome to avoid.
#
# POLICY IS UNCHANGED: normalizeTrivy() marks blocking = Critical AND a fix exists upstream,
# which is exactly what `--severity CRITICAL --ignore-unfixed` meant. agent-gateway's
# fix-deferred perl-base CVEs still do not dead-end the deploy. What is NEW is that an accepted
# finding now has somewhere to live (security/infra-images/allowlist.yaml) that the weekly
# expiry check actually reads — instead of a .trivyignore nobody reviews.
echo "── CVE scan $repo ($local_tag; an un-allowlisted fixable CRITICAL blocks) ──"
# Scans with --format json and NO --exit-code, so a non-zero status here can ONLY mean the
# scanner could not run. Each retry is reported on stderr, so the failure digest carries it.
if ! node scripts/infra-image-scan.mjs --image "$local_tag"; then
  echo "✗ SCANNER ERROR for $repo — Trivy could not complete (a transport/service failure that"
  echo "  survived its bounded retries, or a scanner fault). NOT a vulnerability verdict: nothing"
  echo "  was assessed. Re-run the job; if it persists, the scanner itself is the fault."
  exit 10
fi
# The VERDICT, from the normalized report the scan just wrote. Non-zero here means a finding.
if ! node scripts/check-infra-image-findings.mjs; then
  echo "✗ BLOCKING FINDING in $repo — an un-allowlisted fixable CRITICAL (named in the table above)."
  echo "  Patch it, or add a reviewed, justified, expiring entry to security/infra-images/allowlist.yaml."
  exit 11
fi
echo "✓ $repo: no un-allowlisted fixable CRITICAL"
