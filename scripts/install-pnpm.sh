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
#
# PNPM_PREFIX=<absolute dir>: install into THAT prefix instead, put <dir>/bin first on PATH, and (in
# Actions) append it to $GITHUB_PATH for later steps. REQUIRED on the shared host runner (`kvm`,
# item #1144): there the global prefix is the Node in ~/.cache/act/tool_cache, which another
# project's runner (same `ci` user) also uses, so a global install changes ITS pnpm and its install
# changes ours. Measured 2026-11-25: BELAY's job installed pnpm 12.22.0 there at 11:45:30Z and
# app-image-scan failed check-pnpm-version 22 s later (12.22.0 on PATH vs the 12.21.0 pin), which
# skipped the deploy. In a throwaway container job the global prefix is the job's own.
set -eu
manifest="${1:-package.json}"
[ -f "$manifest" ] || { echo "install-pnpm: no $manifest (run from the repository root)" >&2; exit 2; }
spec=$(node -p "require(require('path').resolve(process.argv[1])).packageManager ?? ''" "$manifest")
case "$spec" in
  pnpm@[0-9]*) ;;
  *) echo "install-pnpm: packageManager must be \"pnpm@<version>\", got \"$spec\"" >&2; exit 2 ;;
esac
prefix="${PNPM_PREFIX:-}"
if [ -n "$prefix" ]; then
  case "$prefix" in
    /*) ;;
    *) echo "install-pnpm: PNPM_PREFIX must be an absolute path, got \"$prefix\"" >&2; exit 2 ;;
  esac
  npm install --global --prefix "$prefix" --no-fund --no-audit --loglevel=error "$spec"
  PATH="$prefix/bin:$PATH"
  export PATH
  if [ -n "${GITHUB_PATH:-}" ]; then echo "$prefix/bin" >> "$GITHUB_PATH"; fi
else
  npm install --global --no-fund --no-audit --loglevel=error "$spec"
fi

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
