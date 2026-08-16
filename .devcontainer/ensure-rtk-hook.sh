#!/usr/bin/env bash
# ensure-rtk-hook.sh — feature 060
#
# Governing: constitution §Common Technology Stack — Token Compression (RTK is a MUST for every
#            AI-assisted shell session); 038 FR-014 (a missing personal layer must never block the
#            container from coming up).
#
# ── The problem this exists to fix, stated exactly ───────────────────────────────────────────────
#
# RTK COMPRESSES NOTHING BY BEING INSTALLED. It works through a Claude Code PreToolUse hook
# (`rtk hook claude`) declared in ~/.claude/settings.json. Binary without hook = every command runs
# unproxied, ZERO token savings — while `command -v rtk` and `rtk --version` both answer perfectly.
#
# And the official initiation step CANNOT wire that hook from a script. Measured 2026-08-16:
#
#     $ rtk init -g
#     RTK hook registered (global).
#     Patch existing /home/coder/.claude/settings.json? [y/N]
#     (non-interactive mode, defaulting to N)
#       MANUAL STEP: Add this to /home/coder/.claude/settings.json: ...
#
# `rtk init -g` PROMPTS, and non-interactively defaults to **N**. It then prints a manual step for a
# human reading a container build log — which nobody does. So every automated container creation
# produces an environment where RTK looks installed and does nothing. That is the structural cause
# of this project's recurring "the assistant ran a whole session without RTK" incidents; it is not
# an occasional slip.
#
# This script performs the patch that `rtk init -g` declines to perform, idempotently, at container
# creation time (once per creation — wired into postCreateCommand).
#
# FR-014 is preserved: with no RTK installed this exits 0 with a notice. It never blocks startup.

set -uo pipefail

CLAUDE_DIR="${HOME}/.claude"
SETTINGS="${CLAUDE_DIR}/settings.json"
RTK_BIN="${CLAUDE_DIR}/tools/bin/rtk"

if [ ! -x "$RTK_BIN" ]; then
  echo "ensure-rtk-hook: RTK not installed at ${RTK_BIN} — nothing to wire."
  echo "ensure-rtk-hook: install the personal layer with:"
  echo "    devcontainer up … --dotfiles-repository https://github.com/jumbleknot/mcm-dotfiles"
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "ensure-rtk-hook: node absent; cannot patch settings.json" >&2; exit 0; }

mkdir -p "$CLAUDE_DIR"

# Merge rather than overwrite: settings.json also carries enabledPlugins, marketplaces and any other
# personal configuration, and clobbering it to install one hook would be a poor trade.
node -e '
const fs = require("fs");
const p = process.argv[1];

let cfg = {};
if (fs.existsSync(p)) {
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    console.error("ensure-rtk-hook: " + p + " is not valid JSON — refusing to overwrite it.");
    console.error("  " + e.message);
    process.exit(3);
  }
}

cfg.hooks = cfg.hooks || {};
cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];

const already = JSON.stringify(cfg.hooks.PreToolUse).includes("rtk hook");
if (already) { console.log("ensure-rtk-hook: RTK hook already wired — no change."); process.exit(0); }

cfg.hooks.PreToolUse.push({
  matcher: "Bash",
  hooks: [{ type: "command", command: "rtk hook claude" }],
});

// Back up before writing: this is the developer'"'"'s personal config on a persisted volume.
if (fs.existsSync(p)) fs.copyFileSync(p, p + ".pre-rtk-hook.bak");
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
console.log("ensure-rtk-hook: RTK PreToolUse hook wired into " + p);
' "$SETTINGS"
rc=$?

# Verify the write actually took. An initiation step that reports success without changing anything
# is precisely the failure mode this script was written to end, so it is checked rather than assumed.
if grep -q 'rtk hook' "$SETTINGS" 2>/dev/null; then
  echo "ensure-rtk-hook: verified — RTK is INITIATED (PreToolUse → 'rtk hook claude')."
  exit 0
fi

echo "ensure-rtk-hook: FAILED to wire the RTK hook (node exit ${rc})." >&2
echo "ensure-rtk-hook: RTK is installed but INACTIVE — the session will get ZERO compression." >&2
exit 0   # FR-014: never block container start; verify-personal-layer.sh is what fails the harness.
