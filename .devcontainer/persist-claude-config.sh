#!/usr/bin/env bash
# persist-claude-config.sh — item #257 (038 SC-007: "0 re-login across a recreate")
#
# ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────────────────────────
#
# `mcm-claude` mounts the ~/.claude **directory**, so everything inside it persists. But Claude
# Code's global config file is not inside it — it is `~/.claude.json`, a sibling in $HOME, which
# lives on the container's ephemeral overlay and is destroyed by every recreate. Measured
# 2026-08-27 in the sandbox dev container:
#
#     /dev/vdd on /home/coder/.claude type ext4    ← the volume, the DIRECTORY
#     /home/coder/.claude.json                     ← plain file on the overlay, NOT a symlink
#
# What each holds, and why SC-007 has never visibly failed:
#
#   ~/.claude/.credentials.json  claudeAiOauth (access/refresh token), mcpOAuth, orgUuid  PERSISTED
#   ~/.claude.json               oauthAccount, userID, machineID, per-project history,    LOST
#                                pluginUsage, ~15 caches
#
# The **credential** is on the volume, so the login itself survives; what a recreate drops is the
# account identity and every session's project history. SC-007 was therefore true by accident
# rather than by design — and the behaviour when the token is present but `oauthAccount` is absent
# was never tested here.
#
# ── THE FIX IS AN ENV VAR, NOT A SYMLINK ─────────────────────────────────────────────────────────
#
# `CLAUDE_CONFIG_DIR` (containerEnv, devcontainer.json) relocates the config root. From the shipped
# binary's own path builder (claude-code 2.1.224):
#
#     globalConfig: path.join(e || os.homedir(), ".claude.json")
#     userSettings: path.join(e || path.join(os.homedir(), ".claude"), "settings.json")
#
# — where `e` is CLAUDE_CONFIG_DIR. Setting it to `$HOME/.claude` therefore resolves to
# `~/.claude/.claude.json` and `~/.claude/settings.json`. Verified empirically: a run with it
# pointed at an empty temp dir created `.claude.json`, `backups/`, `projects/`, `plugins/` and
# `sessions/` **inside** that dir. So pointing it at ~/.claude is a **no-op for every path except
# `.claude.json`** — settings, plugins, projects, sessions, backups and credentials all resolve to
# exactly where they already are, and only the one orphaned file moves onto the volume.
#
# A symlink was the obvious alternative and is the wrong tool: Claude Code replaces this file
# rather than editing it in place (hence the rolling `backups/`), and a write-then-rename replaces
# the symlink itself with a regular file on the overlay — silently restoring the bug.
#
# ── WHAT THIS SCRIPT DOES ────────────────────────────────────────────────────────────────────────
#
# Seeds `~/.claude/.claude.json` once, so the switch preserves the existing identity instead of
# starting a blank config beside a valid credential. Idempotent; steady state is a no-op.
#
#   1. target present   → nothing to do (the normal case, every start after the first).
#   2. ~/.claude.json   → migrate it (the in-place case: the env var is now set but the overlay
#                         copy from before the change is still here).
#   3. newest backup    → restore it (the post-recreate case: the overlay copy went with the old
#                         container, but Claude Code's own rolling backups are under ~/.claude/
#                         backups/ — on the volume — and are written on essentially every save).
#   4. none of these    → nothing; Claude Code creates a fresh config on the volume.
#
# Never blocks the container (FR-014): every path exits 0.

set -uo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
TARGET="$CLAUDE_DIR/.claude.json"
LEGACY="$HOME/.claude.json"
BACKUP_DIR="$CLAUDE_DIR/backups"

say() { printf '[persist-claude-config] %s\n' "$1"; }

# A zero-byte or truncated config is worse than none — Claude Code would fail to parse it and we
# would have overwritten nothing while also fixing nothing. Treat "exists" as "exists and parses".
#
# The fallback matters more than it looks: if this tested with python3 alone and python3 were ever
# absent from the image, EVERY candidate would read as unusable and a perfectly good config would be
# silently skipped — the exact identity loss this script exists to prevent, wearing the disguise of
# a clean "nothing to carry over" run. So a missing interpreter degrades to a structural check
# (non-empty, opens with `{`, closes with `}`) rather than to "no".
is_usable() {
  [ -s "$1" ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
    rc=$?
    # 126/127 = could not execute / not found. That is the INTERPRETER failing, not the file being
    # invalid, and the two must not collapse into the same answer — only a real parse failure (rc 1)
    # may reject a candidate. Anything else falls through to the structural check below.
    [ "$rc" -ne 126 ] && [ "$rc" -ne 127 ] && return "$rc"
  fi
  # Strip ALL whitespace first, then look at the ends. `tail -c 2 | tr -d '\n'` is the tempting
  # form and it is wrong: it returns the last TWO characters whenever the file has no trailing
  # newline, so a perfectly good config reads as damaged.
  [ "$(tr -d '[:space:]' < "$1" | head -c 1)" = "{" ] &&
    [ "$(tr -d '[:space:]' < "$1" | tail -c 1)" = "}" ]
}

if [ ! -d "$CLAUDE_DIR" ]; then
  say "no $CLAUDE_DIR (personal volume absent) — nothing to do."
  exit 0
fi

if is_usable "$TARGET"; then
  say "already persisted at $TARGET — no action."
  exit 0
fi

if is_usable "$LEGACY"; then
  # cp, not mv: if this runs while a Claude Code session started WITHOUT the env var is still
  # writing the legacy path, moving it out from under that session loses the rest of its state.
  # The stale copy on the overlay is discarded by the next recreate anyway.
  if cp -p "$LEGACY" "$TARGET"; then
    say "migrated $LEGACY → $TARGET (identity and project history now on the mcm-claude volume)."
    exit 0
  fi
  say "WARNING: could not copy $LEGACY → $TARGET; Claude Code will start from a fresh config."
  exit 0
fi

if [ -d "$BACKUP_DIR" ]; then
  # Newest FIRST, then walk down. Not just the newest: the reason a config gets replaced from a
  # backup is that something went wrong with it, so the most recent snapshot is exactly the one
  # most likely to be the truncated write. Falling through to the next-newest costs one stat.
  #
  # -printf '%T@ %p' then sort numerically = mtime order, NOT the lexical order of the epoch-ms
  # suffix in the filename — those agree only by coincidence and diverge at a digit boundary.
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    is_usable "$candidate" || { say "skipping unparseable backup $(basename "$candidate")."; continue; }
    if cp -p "$candidate" "$TARGET"; then
      say "restored $TARGET from $(basename "$candidate") (the overlay copy did not survive the recreate)."
      exit 0
    fi
    say "WARNING: could not restore from $candidate."
    break
  done <<EOF
$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '.claude.json.backup.*' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | cut -d' ' -f2-)
EOF
fi

say "no existing config to carry over — Claude Code will create one at $TARGET (on the volume)."
exit 0
