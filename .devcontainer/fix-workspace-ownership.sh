#!/usr/bin/env bash
# fix-workspace-ownership.sh — feature 060, recreate-from-nothing defect #10.
#
# THE PROBLEM, precisely.
#
# On the Docker Sandbox path the workspace clone lives in the VM and is created by the VM's user,
# while the dev container runs as a DIFFERENT user. They are not merely different names — they are
# different UIDs, and the same UID renders under different names on each side:
#
#   VM        : uid=1000(agent)          ← whoever runs `git clone` / `git fetch` over ssh
#   container : uid=1001(coder)          ← whoever runs git from inside the dev container
#   uid 1000 inside the container is `node` (it exists in the base image)
#
# So a file created VM-side shows up in the container as owned by **node**, and the container user
# cannot write it. The symptom is not a clean permission error at the top level — git fails deep,
# on individual object writes, with messages that read like repository corruption:
#
#   "111 of 256 .git/objects subdirs plus 27 worktree files are owned by node, not coder,
#    so any object write fails"
#
# HOW IT HAPPENS IN PRACTICE, and why it is not a one-off:
#
#   1. The documented recreate clones into /workspaces/<repo> from the VM shell. Every file starts
#      owned by the VM user, so a fresh environment is born with the mismatch.
#   2. Any later VM-side git operation re-introduces it — `ssh <sandbox> 'git -C /workspaces/... pull'`
#      writes new objects as the VM user. This is easy to do by reflex and silently poisons the tree
#      for the container user. (It is exactly how the 111 subdirs above were created.)
#
# WHY NOT JUST `chown -R` EVERY TIME: on a large repo that is slow enough to be noticed at every
# container start, and it rewrites metadata for thousands of files that were already correct. This
# repairs ONLY the mismatched entries, so the common case (nothing wrong) costs a single find.
#
# WHY NOT MAKE THE UIDS MATCH INSTEAD: that is the better long-term fix and is worth doing when the
# two devcontainer configs are collapsed — the toolchain image would need `coder` at uid 1000, which
# collides with the base image's `node`. Until then this repair is the safe, reversible option.
#
# Also sets git's `safe.directory`, because a UID mismatch additionally trips git's dubious-ownership
# guard, which produces a *different* and equally confusing error.

set -uo pipefail

WS="${1:-${MCM_WORKSPACE:-/workspaces/mcm}}"
ME="$(id -un)"
MY_UID="$(id -u)"

if [ ! -d "$WS" ]; then
  echo "[fix-workspace-ownership] no workspace at $WS — nothing to do"
  exit 0
fi

# Cheap probe first: if nothing is mismatched, do not touch the filesystem at all.
# -not -uid is used rather than -not -user because the NAME differs between the two sides and the
# UID is the thing that actually governs write access.
mismatched="$(find "$WS" -not -uid "$MY_UID" -print -quit 2>/dev/null || true)"

if [ -z "$mismatched" ]; then
  echo "[fix-workspace-ownership] ✓ $WS is entirely owned by $ME ($MY_UID) — nothing to repair"
else
  n="$(find "$WS" -not -uid "$MY_UID" 2>/dev/null | wc -l)"
  echo "[fix-workspace-ownership] $n path(s) under $WS are NOT owned by $ME ($MY_UID) — repairing"
  echo "  (this is the VM-user vs container-user UID split; see this script's header)"
  # Repair only what is wrong. `|| true` because a stray root-owned artefact from a container that
  # ran as root is possible, and failing the whole container start over one file helps nobody.
  find "$WS" -not -uid "$MY_UID" -exec sudo chown "$MY_UID":"$(id -g)" {} + 2>/dev/null || true
  left="$(find "$WS" -not -uid "$MY_UID" 2>/dev/null | wc -l)"
  if [ "$left" -eq 0 ]; then
    echo "[fix-workspace-ownership] ✓ repaired — all paths now owned by $ME"
  else
    echo "[fix-workspace-ownership] ⚠ $left path(s) still mismatched; inspect with:" >&2
    echo "    find $WS -not -uid $MY_UID -printf '%u %p\\n' | head" >&2
  fi
fi

# A UID mismatch also trips git's dubious-ownership guard, with a different error. Set this
# regardless: it is idempotent and costs nothing.
git config --global --add safe.directory "$WS" 2>/dev/null || true

exit 0
