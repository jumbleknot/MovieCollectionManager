#!/usr/bin/env bash
# verify-personal-layer.sh — feature 038 (full dev-container toolchain)
#
# Governing success criteria: SC-006 (RTK compression active, > 80% on the standard command set)
# and SC-007 (personal plugins/skills present, service logins persist — 0 reinstall / 0 re-login
# across a recreate). Governing requirements: FR-006/FR-007/FR-008 (personal layer present +
# persistent), FR-014 (its ABSENCE never blocks the container — this script exits 0 with a notice).
#
# The personal layer is delivered OUT-OF-REPO by the developer's dotfiles install.sh (FR-009), so
# most of it may legitimately be absent (a second person, or a first open before dotfiles are
# configured). Plugins, skills and service logins are all treated that way: absent is a notice.
#
# ── RTK IS THE EXCEPTION, AND FEATURE 060 (T032) MAKES THAT EXPLICIT ─────────────────────────────
#
# The choice this script has to make — and previously left implicit — is whether RTK is REQUIRED or
# merely WARNED about. It is now **REQUIRED**, and fails an environment that lacks it.
#
# Why the stricter reading: the constitution mandates RTK token compression for every AI-assisted
# shell session (Common Technology Stack — Token Compression). It is not a personal convenience like
# a plugin set; it is a MUST that this environment exists to satisfy. And because RTK is installed
# by the out-of-repo dotfiles rather than baked into the image, an environment that lost it looks
# COMPLETELY HEALTHY while violating that MUST — nothing else in the harness asserts it. That is
# precisely the class of silent regression the verify harness exists to catch.
#
# Tension with 038's FR-014 ("the container is team-capable without dotfiles"), and how it resolves:
# FR-014 is about the container coming UP and being usable, which this script never blocks. This
# assertion is about certifying the environment for ASSISTANT use, which is what the harness does.
# A teammate deliberately running without dotfiles can set MCM_ALLOW_NO_RTK=1 — an EXPLICIT opt-out
# that must be typed, rather than a silent pass that nobody notices.
#
# Success paths:
#   • CONFIGURED  → assert rtk on the PERSISTED volume, `rtk --version` answers, gain > 80%,
#                   plugins present, logins resolve. Exit 0.
#   • RTK ABSENT  → FAIL (unless MCM_ALLOW_NO_RTK=1, which downgrades it to a notice).
#   • Other parts absent → notice, exit 0 (FR-014).
# It also fails when the layer is PARTIALLY present and broken (rtk on PATH but gain < 80%, or a
# claimed-present plugin missing) — a real regression, not an absence.

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

# --- 060 T032: RTK on the PERSISTED volume is REQUIRED -------------------------------------
# Asserted at the volume path specifically, not merely "somewhere on PATH". RTK must live on the
# mcm-claude volume so it survives a container recreate; an rtk that happened to be installed into
# the ephemeral image or ~/.cargo/bin would satisfy `command -v` and then vanish on the next
# rebuild, which is the failure this placement was chosen to prevent (research D3/D7).
RTK_BIN="$HOME/.claude/tools/bin/rtk"

if [ ! -x "$RTK_BIN" ]; then
  if [ "${MCM_ALLOW_NO_RTK:-}" = "1" ]; then
    echo ""
    note "RTK not found on the personal volume ($RTK_BIN) — tolerated by MCM_ALLOW_NO_RTK=1."
    note "The container is team-capable without it, but this environment is NOT certified for"
    note "assistant use: the constitution mandates RTK token compression for AI-assisted sessions."
    echo "[verify-personal-layer] SKIP (RTK absent, explicitly tolerated — exit 0)"
    exit 0
  fi
  err "RTK not found on the personal volume ($RTK_BIN)"
  note "RTK is constitution-mandated for every AI-assisted shell session, and is installed by the"
  note "out-of-repo dotfiles install.sh ('cargo install --root ~/.claude/tools'). An environment"
  note "without it looks completely healthy while violating a MUST — which is why this now FAILS"
  note "rather than skipping. Set 'dotfiles.repository' (or --dotfiles-repository) to the dotfiles"
  note "repo, or export MCM_ALLOW_NO_RTK=1 to acknowledge an uncertified environment deliberately."
  echo "[verify-personal-layer] FAIL (RTK absent — constitution MUST unmet)"
  exit 1
fi
ok "rtk present on the persisted volume ($RTK_BIN)"

# It must also RUN. A present-but-broken binary (wrong arch after an image change, truncated
# install) is a distinct failure from an absent one, and reads identically until it is executed.
if rtk_ver="$("$RTK_BIN" --version 2>&1)"; then
  ok "rtk --version answers: $(printf '%s' "$rtk_ver" | head -1)"
else
  err "rtk is present but '--version' failed — the binary is broken, not merely installed"
fi

# ── PRESENT IS NOT INITIATED — and this distinction has bitten this project before ──────────────
#
# RTK does not compress anything by existing. It works through a Claude Code **PreToolUse hook**
# (`rtk hook claude`) declared in ~/.claude/settings.json, which rewrites commands before they run.
# With the binary installed but the hook missing, every command runs UNPROXIED and the session gets
# ZERO compression — while `command -v rtk`, `rtk --version` and this script's earlier assertions
# all pass happily.
#
# That is not hypothetical: it is a known past failure of this project (the assistant running a
# whole session without RTK active), and it was reproduced exactly on the sandbox environment on
# 2026-08-16 — RTK copied in by hand, `rtk --version` answering 0.42.4, and NO settings.json at all.
# The check passed. So the check was wrong, not merely incomplete.
#
# Initiation is a ONE-TIME-PER-CONTAINER-CREATION step, performed by the dotfiles install.sh. The
# supported mechanism is:
#     devcontainer up … --dotfiles-repository https://github.com/jumbleknot/mcm-dotfiles
SETTINGS="$HOME/.claude/settings.json"
if [ ! -f "$SETTINGS" ]; then
  err "RTK is NOT INITIATED — $SETTINGS is absent, so no PreToolUse hook exists and RTK compresses NOTHING"
  note "Install the personal layer with:  devcontainer up … --dotfiles-repository <dotfiles-url>"
elif grep -q 'rtk hook' "$SETTINGS" 2>/dev/null; then
  ok "RTK is initiated — 'rtk hook' wired into the Claude Code PreToolUse hook"
else
  err "RTK is NOT INITIATED — $SETTINGS exists but declares no 'rtk hook' PreToolUse entry"
  note "The binary is installed and answers, but nothing routes commands through it: zero gains."
  note "Re-run the dotfiles install; see docs/runbooks/devcontainer-sandbox.md."
fi

# SC-006 — compression. REPORTED, NOT ENFORCED (operator decision, 2026-08-16).
#
# ── Why this no longer fails the run ─────────────────────────────────────────────────────────────
#
# The threshold is applied to a metric that cannot reach it. `rtk gain` reports CUMULATIVE GLOBAL
# savings across every proxied command — measured 2026-08-16 at **2.8%** over 914 commands — while
# the PER-COMMAND savings that the ">80%" figure describes run 17–87%:
#
#     Tokens saved: 285.6K (2.8%)        <- what this parse reads
#       rtk read 17.1% | rtk grep 26.1% | rtk git diff 87.1% | rtk:toml 85.7%
#
# So a healthy environment fails a hard >80% assertion, every time. That makes it a check that
# cries wolf, and a check nobody believes is worse than no check: it trains the reader to skip a
# red line in a harness whose whole value is that red lines mean something.
#
# It is therefore REPORTED prominently and does not fail. This is a deliberate, recorded downgrade
# pending investigation of WHY cumulative gain is low — not a quiet loosening to make a suite go
# green. The metric-vs-threshold mismatch is the open question; SC-006 itself is untouched, because
# changing a success criterion is a spec decision rather than an implementation one.
gain_out="$(rtk gain 2>/dev/null || true)"
pct="$(printf '%s' "$gain_out" | grep -oE '[0-9]+(\.[0-9]+)?%' | head -1 | tr -d '%')"
if [ -z "$pct" ]; then
  note "rtk gain reported no percentage yet (no command history in this fresh session)."
  note "SC-006 is measured after the first test run — see the runbook / rtk gain."
elif awk -v p="$pct" 'BEGIN{exit !(p+0 > 80)}'; then
  ok "rtk gain ${pct}% > 80% (SC-006)"
else
  note "rtk gain ${pct}% (cumulative, global) is below the SC-006 figure of 80% — REPORTED, not failed."
  note "Known metric mismatch: this is total savings across ALL proxied commands, whereas the 80%"
  note "figure describes PER-COMMAND savings (measured 17-87% by command type). Follow-up owed:"
  note "either measure per-command, or restate SC-006 against the cumulative metric."
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
