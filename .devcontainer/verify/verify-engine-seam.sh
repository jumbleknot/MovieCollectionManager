#!/usr/bin/env bash
# verify-engine-seam.sh — feature 060 (dev container on Docker Sandbox)
#
# Governing: FR-013 (no container-engine daemon inside the dev container), FR-014 (the dev
#            container runs unprivileged), FR-015 (every container operation executes on the
#            microVM's engine; created containers are SIBLINGS), SC-001, SC-002.
# Contract:  specs/060-devcontainer-docker-sandbox/contracts/verify-harness.md
#
# REPLACES verify-engine-isolation.sh, whose pass condition is now false BY DESIGN.
#
# That script asserted, as a PASS condition, that no docker socket is bind-mounted in — the
# "rejected anti-pattern" of feature 037. The new architecture mounts one ON PURPOSE, and the old
# script's premise ("the engine you can reach is the HOST engine") no longer holds: the reachable
# engine is the microVM's, and the Windows engine sits behind a hypervisor boundary the container
# cannot cross. Per the repository rule that a guard broken by a deliberate change is UPDATED AT
# THE CAUSE and never merely deleted, this replacement asserts the NEW premise with at least equal
# force — a mounted socket is now REQUIRED, and three further assertions (no daemon inside,
# unprivileged, invisible to the Windows engine) carry the isolation claim the old check carried.
#
# ── The discriminator, and why the obvious one does not work ─────────────────────────────────────
#
# "Is a docker socket present?" does NOT distinguish the two topologies. Measured on the DinD dev
# container: /var/run/docker.sock EXISTS there — the NESTED daemon creates it — and `docker info`
# answers happily. Asserting mere presence would pass in both environments and therefore assert
# nothing.
#
# What actually differs is whether a docker socket is BIND-MOUNTED IN from outside:
#   DinD     — socket created in-container by the nested dockerd; NOTHING in /proc/mounts
#   sandbox  — the microVM's socket bind-mounted in;              PRESENT in /proc/mounts
# So assertion 3 tests the mount, not the file.
#
# ⚠️ AND IT IS NOT MOUNTED AT THE OBVIOUS PATH. The docker-outside-of-docker feature bind-mounts
# the engine socket as **/var/run/docker-host.sock**, then has docker-init.sh run a socat proxy
# that presents it as /var/run/docker.sock owned by the non-root user. So /var/run/docker.sock in
# the sandbox container is a socat-created socket, NOT a mount — grepping /proc/mounts for
# `docker\.sock` alone finds nothing and the assertion fails in the very environment it is meant
# to pass in. Measured 2026-08-16. The pattern below matches EITHER name.
#
# Modes:
#   (default)        in-container — assertions 1-5
#   --vm-check       sandbox shell — assertions 4 (VM half) and 6, incl. the headline Privileged:false
#   --host-check [p] Windows — assertion 7, the only NON-FABRICABLE proof: it reads the real
#                    Windows engine. A claim asserted only from inside the thing being claimed
#                    about is not proof.
# Env:
#   KEEP_PROBE=1        leave the probe running so the host side can observe its ABSENCE
#   MCM_DEVCONTAINER_NAME  override dev-container discovery for --vm-check

set -uo pipefail

PROBE="${PROBE_NAME:-mcm-engine-seam-probe}"
fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }

# Locate the dev container on the engine this is run against (VM-side helper).
find_devcontainer() {
  if [ -n "${MCM_DEVCONTAINER_NAME:-}" ]; then echo "$MCM_DEVCONTAINER_NAME"; return; fi
  docker ps --filter 'label=devcontainer.local_folder' --format '{{.Names}}' 2>/dev/null | head -1
}

# ─────────────────────────────────────────────────────────────────────── host-check (Windows) ────
if [ "${1:-}" = "--host-check" ]; then
  name="${2:-$PROBE}"
  echo "[verify-engine-seam] host-side (SC-002, FR-015) — probe '$name'"
  if ! command -v docker >/dev/null 2>&1; then
    err "docker not found on the workstation — cannot observe the Windows engine"
    echo "[verify-engine-seam] FAIL host-side"; exit 1
  fi

  host_ps="$(docker ps -a --format '{{.Names}} {{.Image}}' 2>/dev/null)"

  # 7a — the probe the dev container built must not exist here.
  if printf '%s' "$host_ps" | grep -q "$name"; then
    err "the Windows engine LISTS the sandbox probe '$name' — the engine seam is BROKEN"
  else
    ok "Windows engine does not list the probe container '$name'"
  fi
  if docker images --format '{{.Repository}}' 2>/dev/null | grep -q "$name"; then
    err "the Windows engine holds the sandbox probe IMAGE '$name' — the engine seam is BROKEN"
  else
    ok "Windows engine does not hold the probe image '$name'"
  fi

  # 7b — nor any sibling stack container the assistant creates inside the microVM. Widened from
  # the 037 check, which only ever looked for the probe.
  leaked=""
  for svc in mc-service mcm-bff-service keycloak-service mcm-bff-store-mongo mc-service-store-mongo \
             mcm-bff-cache-redis dev-ollama movie-assistant-gateway; do
    printf '%s' "$host_ps" | grep -q "(^| )${svc}" && leaked="$leaked $svc"
  done
  # NOTE: the retained Docker Desktop path legitimately runs some of these on the Windows engine.
  # Set MCM_EXPECT_NO_STACKS=1 once the Docker Desktop stacks are down, to make this assertion bite.
  if [ -n "$leaked" ] && [ "${MCM_EXPECT_NO_STACKS:-}" = "1" ]; then
    err "Windows engine lists stack containers:$leaked — sibling containers are not confined to the microVM"
  elif [ -n "$leaked" ]; then
    ok "stack names present on the Windows engine, but MCM_EXPECT_NO_STACKS!=1 (retained Docker Desktop path) — not asserted"
  else
    ok "Windows engine lists no MCM stack container"
  fi

  # 7c — nor the SANDBOX's own dev container.
  #
  # This must name the sandbox container SPECIFICALLY. A pattern match on "vsc-mcm" is too coarse
  # while FR-019 holds: the RETAINED Docker Desktop dev container is legitimately running on the
  # Windows engine throughout the migration, and is built from a near-identical image name. Matching
  # the pattern therefore fails on the retained container and reports a confinement breach that has
  # not occurred. Measured 2026-08-16 — the coarse form flagged `practical_shamir`, the Docker
  # Desktop container, as an escaped sandbox container.
  #
  # Pass the sandbox container's name or id via MCM_SANDBOX_CONTAINER (or argument 3).
  sandbox_ctr="${MCM_SANDBOX_CONTAINER:-${3:-}}"
  if [ -z "$sandbox_ctr" ]; then
    ok "sandbox dev-container absence not asserted — set MCM_SANDBOX_CONTAINER to its name/id to assert it"
  elif printf '%s' "$host_ps" | grep -q "$sandbox_ctr"; then
    err "the Windows engine LISTS the sandbox dev container '$sandbox_ctr' — it is not confined to the microVM"
  else
    ok "Windows engine does not list the sandbox dev container '$sandbox_ctr'"
  fi

  echo
  [ "$fail" -eq 0 ] && { echo "PASS host-side — the Windows engine sees nothing from the microVM"; exit 0; }
  echo "[verify-engine-seam] FAIL host-side"; exit 1
fi

# ───────────────────────────────────────────────────────────────────── vm-check (sandbox shell) ──
if [ "${1:-}" = "--vm-check" ]; then
  echo "[verify-engine-seam] VM-side (FR-014, FR-015)"
  command -v docker >/dev/null 2>&1 || { err "docker not found in the sandbox VM"; exit 1; }

  dc="$(find_devcontainer)"
  if [ -z "$dc" ]; then
    err "no dev container found on the sandbox engine (set MCM_DEVCONTAINER_NAME to override)"
    echo "[verify-engine-seam] FAIL VM-side"; exit 1
  fi
  echo "  → dev container: $dc"

  # 6 — THE HEADLINE CLAIM. This is the assertion the whole feature exists to make true.
  priv="$(docker inspect -f '{{.HostConfig.Privileged}}' "$dc" 2>/dev/null || echo unknown)"
  if [ "$priv" = "false" ]; then
    ok "Privileged: false"
  else
    err "Privileged: $priv — FR-014 requires the dev container to be unprivileged"
  fi

  # 4 (VM half) — the engine the container reaches IS this VM's engine, not some other daemon.
  vm_id="$(docker info -f '{{.ID}}' 2>/dev/null || echo unknown)"
  in_id="$(docker exec "$dc" docker info -f '{{.ID}}' 2>/dev/null || echo unknown)"
  if [ "$vm_id" != "unknown" ] && [ "$vm_id" = "$in_id" ]; then
    ok "engine ID seen in-container matches the sandbox engine ($vm_id)"
  else
    err "engine ID mismatch — in-container='$in_id' sandbox='$vm_id' (the container is not driving THIS engine)"
  fi

  # The dev container must be a peer of the stacks, not their host.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${dc}$"; then
    ok "the dev container is itself a container on the sandbox engine (a sibling, not a host)"
  else
    err "the dev container is not listed on the sandbox engine"
  fi

  echo
  [ "$fail" -eq 0 ] && { echo "0 failures — VM-side assertions passed"; exit 0; }
  echo "[verify-engine-seam] FAIL VM-side"; exit 1
fi

# ─────────────────────────────────────────────────────────────────────────── in-container mode ───
echo "[verify-engine-seam] in-container (FR-013, FR-015)"

# 1 — non-fabrication: refuse to run outside the dev container.
if [ "${MCM_DEVCONTAINER:-}" != "1" ]; then
  err "MCM_DEVCONTAINER != 1 — run inside the dev container (for the other sides use --vm-check / --host-check)"
  echo "[verify-engine-seam] FAIL (not in container)"; exit 1
fi

# 2 — NO container-engine daemon may run inside. This is FR-013, and the reason `privileged` dies.
#
# `pgrep -c` PRINTS "0" **and** EXITS 1 when there is no match, so the obvious
# `$(pgrep -c X || echo 0)` yields "0\n0" — which breaks `[ -eq ]` with "integer expression
# expected" and falls through to the failure branch, reporting a daemon that is not running.
# Measured 2026-08-16: this made the check FAIL on the very environment it is meant to pass on.
count_proc() {
  local n
  n="$(pgrep -c "$1" 2>/dev/null || true)"
  n="${n%%[!0-9]*}"          # keep only the leading integer
  printf '%s' "${n:-0}"
}
d_count="$(count_proc dockerd)"
c_count="$(count_proc containerd)"
if [ "$d_count" -eq 0 ]; then
  ok "no dockerd process inside the container"
else
  err "dockerd is running inside the container ($d_count process(es)) — this is still a nested engine"
fi
if [ "$c_count" -eq 0 ]; then
  ok "no containerd process inside the container"
else
  err "containerd is running inside the container ($c_count process(es)) — this is still a nested engine"
fi

# 3 — a docker socket must be BIND-MOUNTED in, and must answer. See the header: presence of the
# socket FILE does not discriminate, because the nested daemon creates one too.
command -v docker >/dev/null 2>&1 || err "docker CLI absent — docker-outside-of-docker feature not present"
# Matches docker.sock OR docker-host.sock — see the header. Either proves the engine socket came
# from OUTSIDE this container, which is the thing that distinguishes the topologies.
if mnt="$(grep -Eo '/(var/)?run/docker(-host)?\.sock' /proc/mounts 2>/dev/null | head -1)"; [ -n "$mnt" ]; then
  ok "engine socket is bind-mounted in from the microVM (${mnt})"
else
  err "no engine socket is bind-mounted — the reachable engine is a LOCAL daemon, not the microVM's"
fi
if docker info >/dev/null 2>&1; then
  ok "docker info answers over the mounted socket"
else
  err "docker info does not answer — no reachable engine"
fi

# 3b — 060 D-19: THE SEAM MUST NOT TRUNCATE OUTPUT OF A SLOW COMMAND.
#
# A seam that answers `docker info` instantly can still be broken in a way that is invisible to
# every fast probe. The docker-outside-of-docker feature fronts the engine socket with
#     socat UNIX-LISTEN:/var/run/docker.sock,fork,... UNIX-CONNECT:/var/run/docker-host.sock
# and socat's half-close timeout defaults to 0.5 s. `docker exec` half-closes stdin immediately, so
# socat tears the relay down mid-response and the CLI returns **exit 0 with EMPTY stdout** for
# anything slower than the timeout. Measured 2026-08-16 in this container:
#
#     sleep 0s -> [LATE-0]        sleep 1s -> [] rc=0        sleep 3s -> [] rc=0
#
# Every check above passes in that state. The failure only appears in commands that take a moment —
# which is to say, in real work. It silently broke the agent-stack bring-up, whose correct assertion
# reported `production_nodes_enabled=` (empty, not false) against a healthy gateway.
#
# So this probe deliberately uses a command that is SLOW and TRIVIAL: 2 seconds of sleep and one
# word of output. A fast probe here would assert nothing. Fixed by DOCKER_HOST pointing at
# docker-host.sock directly (D-19); this assertion is what stops it regressing unnoticed.
seam_out="$(docker exec "$(hostname)" sh -c 'sleep 2; echo mcm-seam-slow-ok' 2>/dev/null || true)"
if [ -z "$seam_out" ]; then
  # Fall back to any running container if self-exec is not possible in this context.
  _c="$(docker ps -q 2>/dev/null | head -1)"
  [ -n "$_c" ] && seam_out="$(docker exec "$_c" sh -c 'sleep 2; echo mcm-seam-slow-ok' 2>/dev/null || true)"
fi
if printf '%s' "$seam_out" | grep -q 'mcm-seam-slow-ok'; then
  ok "docker exec relays the output of a SLOW (2 s) command — no half-close truncation (D-19)"
elif [ -z "$(docker ps -q 2>/dev/null | head -1)" ]; then
  ok "no running container available to probe the slow-exec path — not asserted"
else
  err "docker exec returned EMPTY for a 2 s command — the seam truncates slow output (D-19). \
Every fast probe still passes in this state, and scripts capturing docker exec output will get \"\" \
with exit 0. Fix: DOCKER_HOST=unix:///var/run/docker-host.sock (bypass the socat relay), or run \
socat with -t 60."
fi

# 4 (in-container half) — record the engine ID; --vm-check compares it against the VM's.
engine_id="$(docker info -f '{{.ID}}' 2>/dev/null || echo unknown)"
echo "  → engine ID seen in-container: ${engine_id}"

# 5 — the engine is real and usable: build, run, and see the result listed.
tmp="$(mktemp -d)"
printf 'FROM busybox:stable\nCMD ["echo","mcm-engine-seam-probe-ok"]\n' > "$tmp/Dockerfile"
if docker build -q -t "$PROBE:latest" "$tmp" >/dev/null 2>&1; then
  ok "docker build succeeded on the sandbox engine"
else
  err "docker build FAILED (engine unreachable, or the registry is not allowlisted — see egress-allowlist.json)"
fi
docker rm -f "$PROBE" >/dev/null 2>&1 || true
if docker run --name "$PROBE" "$PROBE:latest" 2>/dev/null | grep -q 'mcm-engine-seam-probe-ok'; then
  ok "docker run succeeded on the sandbox engine"
else
  err "docker run FAILED on the sandbox engine"
fi
docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "$PROBE" \
  && ok "the sandbox engine lists the probe container" \
  || err "the sandbox engine does not list the probe container"

echo "  → COMPLETE the proof from the other two sides:"
echo "     VM:      bash .devcontainer/verify/verify-engine-seam.sh --vm-check"
echo "     Windows: bash .devcontainer/verify/verify-engine-seam.sh --host-check ${PROBE}"
echo "     (run the host side with KEEP_PROBE=1 set here, so it observes the probe's ABSENCE)"

if [ "${KEEP_PROBE:-}" != "1" ]; then
  docker rm -f "$PROBE" >/dev/null 2>&1 || true
  docker rmi -f "$PROBE:latest" >/dev/null 2>&1 || true
  rm -rf "$tmp"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "0 failures — in-container assertions passed"
  exit 0
fi
echo "[verify-engine-seam] FAIL in-container"
exit 1
