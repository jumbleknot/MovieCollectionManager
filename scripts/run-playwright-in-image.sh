#!/bin/sh
# Run the web E2E suite inside mcr.microsoft.com/playwright:v<x>-noble (app-ci `app-e2e`).
#
# Two jobs, both item #992:
#
#   1. Refuse to run when the IMAGE's Node major is not the one the repo pins. The image chooses its
#      own Node — v1.65.0-noble moved 24 -> 26 — and it is in no file, so the workflow passes the
#      expected major in as EXPECTED_NODE_MAJOR, check-toolchain-consistency.mjs holds that literal
#      equal to every `FROM node:` and `node-version:` pin, and this compares it with the real `node`.
#      A tag that moved Node under the repo fails HERE, by name, instead of somewhere inside a run.
#
#   2. Run the workspace's OWN Playwright binary, so the image needs no package manager at all.
#      The old `corepack enable && pnpm exec playwright test` died with `corepack: not found` on the
#      Node 26 image and ran ZERO tests (PR #1013). node_modules is bind-mounted from the checkout the
#      job already installed, so `./node_modules/.bin/playwright` is exactly what `pnpm exec` resolved.
#
# Usage (cwd = frontend/mcm-app inside the container): sh /work/scripts/run-playwright-in-image.sh [playwright test args]
set -eu
: "${EXPECTED_NODE_MAJOR:?pass -e EXPECTED_NODE_MAJOR=<the pinned Node major> to docker run}"
actual=$(node -p 'process.versions.node.split(".")[0]')
if [ "$actual" != "$EXPECTED_NODE_MAJOR" ]; then
  echo "::error::the Playwright image runs Node $(node -v) but the repo pins Node $EXPECTED_NODE_MAJOR — move the image tag, the Node images and every setup-node together (item #992)" >&2
  exit 1
fi
[ -x ./node_modules/.bin/playwright ] || { echo "::error::./node_modules/.bin/playwright is missing — was the workspace installed before this step? (cwd: $(pwd))" >&2; exit 1; }
echo "run-playwright-in-image: Node $(node -v), Playwright $(./node_modules/.bin/playwright --version)"
exec ./node_modules/.bin/playwright test "$@"
