#!/usr/bin/env bash
# verify-engine-isolation.sh — feature 037 (containerized dev-env)
#
# Governing success criterion: SC-002 (in-container container engine is separate from the host
#                              engine — nested containers do not appear on / are not controlled
#                              via the host engine).
# Governing requirement:       FR-004.
#
# SC-002 is inherently TWO-SIDED (a container can't observe the host engine — that IS the
# isolation). This one script has two modes:
#
#   (default, IN-CONTAINER)  `devcontainer exec … bash verify-engine-isolation.sh`
#       Builds a probe image + runs a probe container on the in-container engine, asserts the
#       nested engine works, asserts NO host docker socket is bind-mounted in (the rejected
#       anti-pattern, research D3), records the nested daemon ID, and prints the host-side
#       command to complete the proof. Set KEEP_PROBE=1 to leave the probe running so the host
#       side can observe its ABSENCE.
#
#   (HOST)  `bash verify-engine-isolation.sh --host-check [probe-name]`
#       Asserts the host engine's `docker ps -a` / `docker images` do NOT list the probe —
#       the definitive SC-002 observation. Non-fabrication: this reads the REAL host engine.
#
# RED-first: the default (in-container) mode run on the HOST fails immediately (MCM_DEVCONTAINER
# unset), the intended pre-implementation RED state.

set -uo pipefail

PROBE="${PROBE_NAME:-mcm-engine-isolation-probe}"
fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }

# ---------------------------------------------------------------------------- host-check mode
if [ "${1:-}" = "--host-check" ]; then
  name="${2:-$PROBE}"
  echo "[verify-engine-isolation] SC-002 host-check for probe '$name'"
  if ! command -v docker >/dev/null 2>&1; then
    err "docker not found on host — cannot observe host engine"; echo "FAIL"; exit 1
  fi
  if docker ps -a --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -q "$name"; then
    err "host engine LISTS the in-container probe '$name' — engine isolation BROKEN"
  else
    ok "host engine does not list probe container '$name'"
  fi
  if docker images --format '{{.Repository}}' 2>/dev/null | grep -q "$name"; then
    err "host engine holds the in-container probe image '$name' — engine isolation BROKEN"
  else
    ok "host engine does not hold probe image '$name'"
  fi
  [ "$fail" -eq 0 ] && { echo "[verify-engine-isolation] PASS host-side (SC-002)"; exit 0; }
  echo "[verify-engine-isolation] FAIL host-side (SC-002)"; exit 1
fi

# ------------------------------------------------------------------------- in-container mode
echo "[verify-engine-isolation] SC-002 in-container"

# Non-fabrication: must be inside the container.
if [ "${MCM_DEVCONTAINER:-}" != "1" ]; then
  err "MCM_DEVCONTAINER != 1 — not inside the dev container (RED). For the host side run: --host-check"
  echo "[verify-engine-isolation] FAIL (not in container)"; exit 1
fi

command -v docker >/dev/null 2>&1 || { err "docker CLI absent — DinD feature not present"; echo "FAIL"; exit 1; }

# The host Docker socket must NOT be mounted in (that anti-pattern hands the container the host
# engine and defeats isolation — research D3). Its absence is directly checkable in-container.
if grep -Eq '/(var/run|run)/docker\.sock' /proc/mounts 2>/dev/null; then
  err "host docker.sock is bind-mounted into the container — isolation defeated (rejected pattern)"
else
  ok "no host docker.sock bind-mounted — engine is the nested DinD daemon"
fi

# Nested engine must actually work: build + run a probe.
tmp="$(mktemp -d)"
printf 'FROM busybox:stable\nCMD ["echo","mcm-engine-isolation-probe-ok"]\n' > "$tmp/Dockerfile"
if docker build -q -t "$PROBE:latest" "$tmp" >/dev/null 2>&1; then
  ok "in-container docker build succeeded"
else
  err "in-container docker build FAILED (DinD engine or registry allowlist broken — see init-firewall.sh)"
fi
docker rm -f "$PROBE" >/dev/null 2>&1 || true
if docker run --name "$PROBE" "$PROBE:latest" 2>/dev/null | grep -q 'mcm-engine-isolation-probe-ok'; then
  ok "in-container docker run succeeded"
else
  err "in-container docker run FAILED"
fi

# The nested engine lists the probe (proves it's a real, working, separate daemon).
docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "$PROBE" \
  && ok "nested engine lists the probe container" \
  || err "nested engine does not list the probe container"

daemon_id="$(docker info -f '{{.ID}}' 2>/dev/null || echo unknown)"
echo "  → nested daemon ID: ${daemon_id}"
echo "  → COMPLETE SC-002 from the HOST:  bash .devcontainer/verify/verify-engine-isolation.sh --host-check ${PROBE}"
echo "     (run it while KEEP_PROBE=1 kept the probe alive; the host engine must NOT list it)"

# Cleanup unless the host side needs the probe to observe.
if [ "${KEEP_PROBE:-}" != "1" ]; then
  docker rm -f "$PROBE" >/dev/null 2>&1 || true
  docker rmi -f "$PROBE:latest" >/dev/null 2>&1 || true
  rm -rf "$tmp"
fi

[ "$fail" -eq 0 ] && { echo "[verify-engine-isolation] PASS in-container (SC-002; complete host side)"; exit 0; }
echo "[verify-engine-isolation] FAIL in-container (SC-002)"; exit 1
