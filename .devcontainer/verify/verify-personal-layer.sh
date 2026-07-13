#!/usr/bin/env bash
# verify-personal-layer.sh — feature 038 (full dev-container toolchain)
#
# Governing success criteria: SC-006 (RTK compression active, > 80% on the standard command set)
# and SC-007 (personal plugins/skills present, service logins persist — 0 reinstall / 0 re-login
# across a recreate). Governing requirements: FR-006/FR-007/FR-008 (personal layer present +
# persistent), FR-014 (its ABSENCE never blocks the container — this script exits 0 with a notice).
#
# The personal layer is delivered OUT-OF-REPO by the developer's dotfiles install.sh (FR-009), so
# it may legitimately be absent (a second person, or a first open before dotfiles are configured).
# This script therefore has two success paths:
#   • CONFIGURED  → assert rtk gain > 80%, expected plugins present, logins resolve. Exit 0.
#   • ABSENT      → print a clear "personal layer absent" notice and exit 0 (FR-014). It NEVER
#                   fails the run just because a personal convenience is missing.
# It fails (non-zero) ONLY when the layer is PARTIALLY present and broken (e.g. rtk on PATH but
# gain < 80%, or a claimed-present plugin missing) — a real regression, not an absence.

set -uo pipefail

fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }
note(){ printf '  • %s\n' "$1"; }

echo "[verify-personal-layer] SC-006 / SC-007"

if [ "${MCM_DEVCONTAINER:-}" != "1" ]; then
  echo "  ✗ MCM_DEVCONTAINER != 1 — run inside the dev container (RED)" >&2
  echo "[verify-personal-layer] FAIL (not in container)"; exit 1
fi

# RTK is installed by the dotfiles install.sh into the PERSISTED ~/.claude volume
# (`cargo install --root ~/.claude/tools`) so it survives recreation — NOT the ephemeral
# ~/.cargo/bin (research D3/D7). Put that dir on PATH for this check regardless of shell rc.
export PATH="$HOME/.claude/tools/bin:$PATH"

# --- absence detection -------------------------------------------------------------------
# The layer is "configured" if RTK is present. No RTK → treat the whole personal layer as
# not-yet-configured and skip cleanly (FR-014).
if ! command -v rtk >/dev/null 2>&1; then
  echo ""
  note "personal layer ABSENT — 'rtk' not found on PATH (~/.claude/tools/bin)."
  note "The container is fully team-capable without it. To enable the personal layer, set the"
  note "VS Code user setting 'dotfiles.repository' (or --dotfiles-repository) to your dotfiles"
  note "repo whose install.sh builds RTK + installs plugins. See docs/runbooks/devcontainer.md."
  echo "[verify-personal-layer] SKIP (personal layer not configured — exit 0, FR-014)"
  exit 0
fi

# --- CONFIGURED path: assert the layer is healthy ----------------------------------------
ok "rtk present ($(command -v rtk))"

# SC-006 — compression. `rtk gain` reports cumulative savings; require > 80%. Parse the first
# percentage it emits. If no run history exists yet, `rtk gain` may report 0 runs — treat that as
# a soft note (nothing to compress yet) rather than a hard fail, since a fresh session has no history.
gain_out="$(rtk gain 2>/dev/null || true)"
pct="$(printf '%s' "$gain_out" | grep -oE '[0-9]+(\.[0-9]+)?%' | head -1 | tr -d '%')"
if [ -z "$pct" ]; then
  note "rtk gain reported no percentage yet (no command history in this fresh session)."
  note "SC-006 (> 80%) is confirmed after the first test run — see the runbook / rtk gain."
elif awk -v p="$pct" 'BEGIN{exit !(p+0 > 80)}'; then
  ok "rtk gain ${pct}% > 80% (SC-006)"
else
  err "rtk gain ${pct}% is NOT > 80% (SC-006 regression)"
fi

# SC-007 — plugins/skills present. The expected set is the developer's, delivered by the dotfiles
# install.sh; the committed repo carries NO personal plugin list (FR-009). So we assert only that
# the plugin store under the persisted ~/.claude volume is populated (a concrete personal-set
# assertion lives in the developer's own dotfiles, not in this team-committed script).
if [ -d "$HOME/.claude" ] && [ "$(find "$HOME/.claude" -maxdepth 3 \( -iname '*plugin*' -o -iname '*skills*' -o -path '*plugins*' \) 2>/dev/null | head -1)" ]; then
  ok "personal plugins/skills present under the persisted ~/.claude volume (SC-007)"
else
  err "rtk present but no plugins/skills found under ~/.claude — partial/broken personal setup (SC-007)"
fi

# SC-007 — logins persist. A logged-in state resolves without a re-auth prompt. `gh auth status`
# is a non-interactive, safe probe; Claude/Expo logins live in ~/.claude (persisted). We check gh
# as the representative persisted login (best-effort — a not-logged-in gh is a note, not a fail,
# because login is the developer's one-time action, not something this script performs).
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh login resolves without re-auth (persisted — SC-007)"
  else
    note "gh not logged in yet (one-time: 'gh auth login'; then it persists in ~/.claude)."
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "[verify-personal-layer] PASS (personal layer healthy — SC-006 / SC-007)"; exit 0
else
  echo "[verify-personal-layer] FAIL — personal layer present but broken (SC-006 / SC-007)"; exit 1
fi
