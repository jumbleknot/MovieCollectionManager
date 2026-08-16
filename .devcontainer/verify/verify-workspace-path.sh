#!/usr/bin/env bash
# verify-workspace-path.sh — feature 060 (dev container on Docker Sandbox)
#
# Governing: FR-017 (the working tree MUST occupy the identical path inside the microVM and inside
#            the dev container, and this MUST be asserted automatically rather than relied upon by
#            convention), US3-AC6, research.md D-03.
# Contract:  specs/060-devcontainer-docker-sandbox/contracts/verify-harness.md
#
# ── Why this script exists at all ────────────────────────────────────────────────────────────────
#
# With ONE engine, a sibling container's `-v /workspaces/mcm:/x` resolves against the MICROVM's
# filesystem, not the dev container's. If the two paths disagree, the mount still SUCCEEDS — the
# sibling simply gets an empty directory, the run proceeds, and the result is confidently wrong.
# Nothing errors. The repository already has recipes that mount the working tree (the Playwright
# official-image E2E recipe, and $PWD-mounting tooling), so this is a live failure mode, not a
# hypothetical one.
#
# That is why assertion 3 exists. Asserting only that the mount SUCCEEDED (assertion 2) would
# reproduce exactly the failure this check is written to catch.
#
# Env:
#   MCM_WORKSPACE_PATH   default /workspaces/mcm
#   MCM_WORKSPACE_MARKER default pnpm-workspace.yaml

set -uo pipefail

WS="${MCM_WORKSPACE_PATH:-/workspaces/mcm}"
MARKER="${MCM_WORKSPACE_MARKER:-pnpm-workspace.yaml}"
PROBE_IMAGE="${MCM_PROBE_IMAGE:-alpine:latest}"

fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }

echo "[verify-workspace-path] FR-017 / US3-AC6 — expecting workspace at ${WS}"

# ── 1 — the resolved path inside the container is the expected one ───────────────────────────────
# `pwd -P` resolves symlinks: a symlinked or differently-mounted workspace breaks sibling `-v`
# resolution even when `pwd` looks correct.
here="$(cd "$WS" 2>/dev/null && pwd -P || echo '<missing>')"
if [ "$here" = "$WS" ]; then
  ok "pwd -P inside the container is ${WS}"
else
  err "pwd -P is ${here}, expected ${WS}"
fi

# ── 2 — a SIBLING container can mount that path ──────────────────────────────────────────────────
# This is what proves the path exists on the ENGINE HOST (the microVM), not merely in this
# container's own filesystem.
if ! command -v docker >/dev/null 2>&1; then
  err "docker CLI absent — cannot run the sibling probe"
  echo "[verify-workspace-path] FAIL"; exit 1
fi

listing="$(docker run --rm -v "${WS}:/probe" "$PROBE_IMAGE" ls -A /probe 2>/dev/null || true)"
entries="$(printf '%s\n' "$listing" | grep -c . || true)"

if [ "$entries" -gt 0 ]; then
  ok "sibling probe mounted ${WS} and listed ${entries} entries"
else
  err "sibling probe listed 0 entries — ${WS} does not exist on the engine host, or is empty there"
fi

# ── 3 — THE ASSERTION THAT MATTERS: the sibling sees the REPOSITORY, not just *a* directory ──────
# A path mismatch mounts an empty directory SUCCESSFULLY. Presence of a mount proves nothing;
# presence of a known repository marker inside it is what proves the content is the working tree.
if printf '%s\n' "$listing" | grep -qx "$MARKER"; then
  ok "sibling probe sees the repository marker (${MARKER}) — the mount resolves to the working tree"
else
  err "probe listing has no ${MARKER} — the sibling mounted the WRONG content (this fails SILENTLY in real use)"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "0 failures — workspace path is identical inside the container and on the engine host"
  exit 0
fi
echo "[verify-workspace-path] FAIL"
exit 1
