#!/bin/sh
# Install pnpm at EXACTLY the version the root package.json `packageManager` names — the ONE way pnpm
# is provisioned in this repo's images and CI jobs (item #992).
#
# WHY NOT corepack: Node 26 no longer bundles it. `corepack enable` is `corepack: not found` on every
# node:26 image and on the Playwright v1.65+ images (PR #1013, zero tests ran). npm is still bundled,
# so a global npm install works on every Node this repo pins, old or new.
#
# WHY READ packageManager instead of naming a version here: a second copy of the version is the
# shape that half-bumped twice when the Dockerfile carried `corepack prepare pnpm@X` (item #225,
# PRs #217 and #263). There is no copy now, so there is nothing for Renovate to leave behind.
# (pnpm also re-execs itself at the packageManager version when the two differ, so an image baked
# before a bump still RUNS the right pnpm — but the install is exact anyway, so nothing downloads.)
#
# Usage: sh scripts/install-pnpm.sh [path/to/package.json]   (default: ./package.json)
# Writes to npm's global prefix, so run it as the user that owns that prefix (root in an image).
set -eu
manifest="${1:-package.json}"
[ -f "$manifest" ] || { echo "install-pnpm: no $manifest (run from the repository root)" >&2; exit 2; }
spec=$(node -p "require(require('path').resolve(process.argv[1])).packageManager ?? ''" "$manifest")
case "$spec" in
  pnpm@[0-9]*) ;;
  *) echo "install-pnpm: packageManager must be \"pnpm@<version>\", got \"$spec\"" >&2; exit 2 ;;
esac
npm install --global --no-fund --no-audit --loglevel=error "$spec"

# Verify the pnpm now FIRST ON PATH is the pin (item #1025). Nested workspaces (pnpm --dir
# tools/openwiki-generator, the sast audit) declare no packageManager and run on whatever pnpm is
# installed, so a different pnpm earlier on PATH would silently run them. pnpm is asked from an empty
# temp dir: inside the repo it self-switches to the pin and would print the pin whatever is installed.
# Inline rather than calling scripts/check-pnpm-version.mjs, because the image build copies only this
# file and package.json. Keep both on the same rule.
want=${spec#pnpm@}
want=${want%%+*}
probe=$(mktemp -d)
got=$(cd "$probe" && pnpm --version 2>/dev/null | tail -n 1) || got=''
rmdir "$probe"
if [ "$got" != "$want" ]; then
  echo "::error::pnpm on PATH is ${got:-absent} ($(command -v pnpm || echo 'not found')), but packageManager pins $want" >&2
  exit 1
fi
echo "install-pnpm: $spec -> $(command -v pnpm) ($got)"
