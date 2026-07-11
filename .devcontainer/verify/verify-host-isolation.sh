#!/usr/bin/env bash
# verify-host-isolation.sh — feature 037 (containerized dev-env)
#
# Governing success criterion: SC-001 (host-FS / credential / SSH isolation).
# Governing requirements:      FR-002 (non-root, no host reach), FR-012 (in-container marker).
#
# Asserts, from INSIDE the dev container, that:
#   1. we are actually in the container   (MCM_DEVCONTAINER=1)      — non-fabrication guard
#   2. the session user is non-root        (FR-002)
#   3. the host-only sentinel is UNREACHABLE via any mount path      (SC-001)
#   4. no Windows host profile / drive is bind-mounted in            (SC-001)
#   5. no host SSH keys or credential stores are mounted in          (SC-001)
#
# RED-first: run on the HOST (outside the container) this FAILS immediately at check 1
# (MCM_DEVCONTAINER is unset), which is the intended pre-implementation RED state.
# Exit 0 = isolation holds; non-zero = a host resource leaked into the container.

set -uo pipefail

fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }

echo "[verify-host-isolation] SC-001"

# 1. Non-fabrication: we must be inside the container, or the whole proof is meaningless.
if [ "${MCM_DEVCONTAINER:-}" = "1" ]; then
  ok "in-container marker MCM_DEVCONTAINER=1 present (FR-012)"
else
  err "MCM_DEVCONTAINER != 1 — not running inside the dev container (RED / broken isolation)"
  # Everything below assumes we are in the container; bail early to avoid a false pass.
  echo "[verify-host-isolation] FAIL (not in container)"; exit 1
fi

# 2. Non-root session user (FR-002).
uid="$(id -u)"
if [ "$uid" -ne 0 ]; then
  ok "session user is non-root (uid=$uid, $(whoami))"
else
  err "session user is root (uid=0) — violates FR-002 non-root requirement"
fi

# 3. The host-only sentinel must be unreachable via EVERY plausible host-mount path.
#    (Marker created on the host at C:\Users\Steve\HOST-ONLY-MARKER.txt — T002.)
marker_hit=0
for p in \
  "/mnt/c/Users/Steve/HOST-ONLY-MARKER.txt" \
  "/c/Users/Steve/HOST-ONLY-MARKER.txt" \
  "/host/c/Users/Steve/HOST-ONLY-MARKER.txt" \
  "/run/desktop/mnt/host/c/Users/Steve/HOST-ONLY-MARKER.txt" \
  "${HOME}/HOST-ONLY-MARKER.txt"
do
  if [ -e "$p" ]; then err "host sentinel is READABLE at $p — host FS leaked in"; marker_hit=1; fi
done
[ "$marker_hit" -eq 0 ] && ok "host-only sentinel unreachable via all known mount paths"

# 4. No Windows drive / host profile is bind-mounted (drvfs / gRPC-FUSE / 9p / desktop host mount).
if grep -Eiq '(/mnt/c|/run/desktop/mnt/host|drvfs|9p.*[Uu]sers|Users/Steve)' /proc/mounts; then
  err "a Windows host path appears in /proc/mounts — host profile mounted in"
  grep -Ei '(/mnt/c|/run/desktop/mnt/host|drvfs|9p.*[Uu]sers|Users/Steve)' /proc/mounts >&2
else
  ok "no Windows host drive / profile mounted (/proc/mounts clean)"
fi

# 5. No host SSH keys or credential stores mounted in.
#    A fresh container has no ~/.ssh; a bind-mount would show as a mount target or private keys.
if grep -Eiq '(/\.ssh|/\.aws|/\.config/gcloud|/\.docker/config|/\.claude(/|$))' /proc/mounts; then
  err "a host credential/SSH store is bind-mounted in"
  grep -Ei '(/\.ssh|/\.aws|/\.config/gcloud|/\.docker/config|/\.claude(/|$))' /proc/mounts >&2
else
  ok "no host SSH/credential store bind-mounted"
fi

if [ -d "${HOME}/.ssh" ] && ls -1 "${HOME}/.ssh" 2>/dev/null | grep -Eq '^id_(rsa|ecdsa|ed25519)$'; then
  err "private SSH keys present in ${HOME}/.ssh — unexpected host key material"
else
  ok "no host private SSH keys under ${HOME}/.ssh"
fi

if [ "$fail" -eq 0 ]; then
  echo "[verify-host-isolation] PASS (SC-001)"; exit 0
else
  echo "[verify-host-isolation] FAIL (SC-001)"; exit 1
fi
