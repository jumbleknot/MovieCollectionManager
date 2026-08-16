#!/usr/bin/env bash
# verify-reboot-survival.sh — feature 060 (Docker Sandbox rehost), T051 / FR-030.
#
# Governing requirement: the environment must survive a WORKSTATION REBOOT — after a host restart,
# `sbx start mcm` returns the sandbox with its images, volumes, workspace clone and shell history
# intact, and the dev container restarts.
#
# WHY THIS IS A SCRIPT AND NOT AN EYEBALL CHECK.
#
# "It came back fine" is the least trustworthy sentence in this whole feature. After a reboot the
# environment either looks right or it doesn't, and looking right is exactly what a PARTIALLY
# restored environment does: the dev container is up, the workspace is there, and the 33 GB of
# images that took 293 s to build are silently gone — a fact nobody notices until the next build
# takes seventeen minutes. A survival claim needs a BEFORE, recorded before the event, or it is not
# a measurement.
#
# Modes:
#   --capture   record the current inventory to the manifest (run BEFORE stopping/rebooting)
#   --verify    compare the live environment against the manifest and report what did NOT survive
#   --show      print the stored manifest
#
# The manifest is written to TWO places on purpose:
#   1. inside the VM   ($MANIFEST) — the normal path
#   2. on the host     (--host-copy <path>) — so that TOTAL loss of the VM is still detectable.
#      If the manifest only lived in the VM, a sandbox that came back empty would come back with no
#      evidence that it was ever otherwise, and the check would have nothing to fail against.
#
# Exit 0 = everything in the manifest survived. Non-zero = something did not, named explicitly.

set -uo pipefail

MANIFEST="${MCM_REBOOT_MANIFEST:-$HOME/.mcm-reboot-manifest.txt}"
MODE="${1:---verify}"

have() { command -v "$1" >/dev/null 2>&1; }

# Collect the inventory as stable, diffable lines. Sorted, because docker's native ordering is
# recency-based and would report a spurious difference after any restart.
collect() {
  echo "## workspace"
  if [ -d /workspaces/mcm/.git ]; then
    echo "head=$(git -C /workspaces/mcm rev-parse HEAD 2>/dev/null || echo MISSING)"
    echo "branch=$(git -C /workspaces/mcm rev-parse --abbrev-ref HEAD 2>/dev/null || echo MISSING)"
    # Tracked-file count rather than `status --porcelain`: uncommitted scratch legitimately changes
    # between capture and verify, and a check that fails on legitimate work gets ignored.
    echo "tracked=$(git -C /workspaces/mcm ls-files 2>/dev/null | wc -l)"
  else
    echo "head=NO-WORKSPACE"
  fi

  echo "## images"
  docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '^<none>' | sort -u

  echo "## volumes"
  docker volume ls --format '{{.Name}}' 2>/dev/null | sort -u

  echo "## containers"
  docker ps -a --format '{{.Names}}' 2>/dev/null | sort -u

  echo "## history"
  # Shell history is explicitly named in the Done-when. It lives in the VM user's home, which is a
  # different persistence question from the Docker volumes, so it is tracked separately.
  for h in "$HOME/.bash_history" "$HOME/.zsh_history"; do
    [ -f "$h" ] && echo "$(basename "$h")=$(wc -l < "$h" 2>/dev/null | tr -d ' ')"
  done

  # A function returns the status of its LAST command. The loop above ends in
  # `[ -f "$h" ] && echo …`, which is FALSE whenever the last candidate history file is absent
  # (.zsh_history usually is) — so `collect` returned 1 and --capture reported "capture failed"
  # while having written a perfectly good manifest. Measured 2026-08-16. Return success explicitly:
  # the caller's error handling should fire on a real write failure, not on a missing optional file.
  return 0
}

case "$MODE" in
  --capture)
    echo "[verify-reboot-survival] capturing inventory → $MANIFEST"
    collect > "$MANIFEST" || { echo "  ✗ capture failed" >&2; exit 1; }
    printf '  images=%s volumes=%s containers=%s\n' \
      "$(grep -c . <(sed -n '/^## images/,/^## volumes/p' "$MANIFEST" | grep -v '^##'))" \
      "$(grep -c . <(sed -n '/^## volumes/,/^## containers/p' "$MANIFEST" | grep -v '^##'))" \
      "$(grep -c . <(sed -n '/^## containers/,/^## history/p' "$MANIFEST" | grep -v '^##'))"
    echo "  ✓ captured. Copy it OFF the VM too — a sandbox that returns empty must still be able to"
    echo "    prove it was not always empty:  sbx cp mcm:$MANIFEST ./reboot-manifest.txt"
    exit 0
    ;;

  --show)
    [ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST" >&2; exit 1; }
    cat "$MANIFEST"; exit 0
    ;;

  --verify) ;;
  *) echo "usage: verify-reboot-survival.sh [--capture|--verify|--show]" >&2; exit 2 ;;
esac

echo "[verify-reboot-survival] T051 / FR-030"

if [ ! -f "$MANIFEST" ]; then
  # This is a FAILURE, not a skip. No manifest means no before-state, which means the survival
  # claim is unfalsifiable — and an unfalsifiable check that exits 0 is the failure mode this
  # repository keeps paying for.
  echo "  ✗ no manifest at $MANIFEST — nothing to compare against." >&2
  echo "    A survival claim with no recorded BEFORE is not a measurement. Run --capture first." >&2
  echo "[verify-reboot-survival] FAIL (no baseline)"; exit 1
fi

fail=0
now="$(mktemp)"; collect > "$now"

# Compare one section, reporting only entries present BEFORE and missing NOW. New entries are not
# failures — the environment legitimately grows.
cmp_section() {
  local name="$1" start="$2" end="$3"
  local before after missing
  before="$(sed -n "/^## $start/,/^## $end/p" "$MANIFEST" | grep -v '^##' | grep -c . )"
  missing="$(comm -23 \
      <(sed -n "/^## $start/,/^## $end/p" "$MANIFEST" | grep -v '^##' | grep . | sort -u) \
      <(sed -n "/^## $start/,/^## $end/p" "$now"      | grep -v '^##' | grep . | sort -u))"
  if [ -z "$missing" ]; then
    printf '  ✓ %s: all %s survived\n' "$name" "$before"
  else
    printf '  ✗ %s: %s of %s did NOT survive:\n' "$name" "$(printf '%s\n' "$missing" | grep -c .)" "$before" >&2
    printf '      %s\n' $missing >&2
    fail=1
  fi
}

# Workspace identity — the clone must be the same clone, on the same commit.
b_head="$(grep '^head=' "$MANIFEST" | cut -d= -f2)"
a_head="$(grep '^head=' "$now"      | cut -d= -f2)"
if [ "$a_head" = "NO-WORKSPACE" ]; then
  echo "  ✗ workspace clone is GONE (/workspaces/mcm/.git absent)" >&2; fail=1
elif [ "$b_head" = "$a_head" ]; then
  echo "  ✓ workspace clone intact and on the same commit (${a_head:0:8})"
else
  # Not automatically a failure: work continues between capture and verify. Reported, not asserted.
  echo "  ✓ workspace clone intact; HEAD moved ${b_head:0:8} → ${a_head:0:8} (expected if work continued)"
fi

cmp_section "images"     "images"     "volumes"
cmp_section "volumes"    "volumes"    "containers"
cmp_section "containers" "containers" "history"

# The dev container must be RUNNING, not merely present. `--restart=always` is what carries this
# across a VM stop, and it is the one thing that makes the environment self-restoring.
dc="$(docker ps --filter 'label=devcontainer.local_folder' --format '{{.Names}}' 2>/dev/null | head -1)"
if [ -n "$dc" ]; then
  echo "  ✓ dev container is RUNNING again ($dc)"
else
  echo "  ✗ dev container is not running — --restart=always did not restore it" >&2; fail=1
fi

# Shell history, named explicitly in the Done-when.
while IFS= read -r line; do
  f="${line%%=*}"; b="${line#*=}"
  a="$(grep "^$f=" "$now" | cut -d= -f2)"
  if [ -z "$a" ]; then
    echo "  ✗ $f is GONE (had $b lines)" >&2; fail=1
  elif [ "$a" -lt "$b" ]; then
    echo "  ✗ $f SHRANK: $b → $a lines" >&2; fail=1
  else
    echo "  ✓ $f preserved ($a lines)"
  fi
done < <(sed -n '/^## history/,$p' "$MANIFEST" | grep -v '^##' | grep .)

rm -f "$now"
if [ "$fail" -eq 0 ]; then
  echo "[verify-reboot-survival] PASS — everything recorded before the restart came back"; exit 0
fi
echo "[verify-reboot-survival] FAIL — see the ✗ lines above for what did not survive"; exit 1
