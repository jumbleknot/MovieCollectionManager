#!/usr/bin/env bash
# Feature 055 (backlog item #179) — catch the agent gateway in the act of wedging.
#
# WHY THIS EXISTS: `movie-assistant-gateway` has wedged three times under sustained web-E2E agent
# load — 100% CPU on one core, memory at 1%, `/health` timing out, its log tens of minutes stale —
# while Docker reported `status=running OOMKilled=false ExitCode=0 RestartCount=0`. It has been
# diagnosed ZERO times, because capturing a spin requires acting on the LIVE process and nobody was
# watching. A host reboot then destroyed the only wedged instance that existed.
#
# 100% CPU is the discriminator: a deadlock or a blocked await waits near 0%. Something is executing
# a tight loop, and on a single-threaded asyncio event loop that starves everything else on it —
# which is exactly why /health cannot be answered while the process stays alive. WHICH loop is what
# this script exists to find out.
#
# Arm it before a full E2E suite:
#
#     bash scripts/capture-gateway-wedge.sh --out /tmp/wedge &
#     … run the suite …
#
# Contract: it captures ONCE, on the FIRST health failure, and then stops. The wedged state persists,
# so a second dump would only bury the first.
#
# It exits 0 whether or not a wedge occurred, and SAYS WHICH. An absent capture must never be
# mistaken for a capture that found nothing — the same 0-vs-unavailable rule the E2E tallies enforce.
set -uo pipefail

CONTAINER="${GATEWAY_CONTAINER:-movie-assistant-gateway}"
PROBE_FROM="${PROBE_FROM_CONTAINER:-mcm-bff-service-nonsecure}"
INTERVAL="${POLL_INTERVAL_SECONDS:-10}"
MAX_SECONDS="${MAX_WATCH_SECONDS:-5400}"
OUT_DIR="${HOME:-/tmp}/gateway-wedge-$(date -u +%Y%m%dT%H%M%SZ)"
MARKER='[wedge-watch]'

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    *) echo "$MARKER unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR"
echo "$MARKER watching $CONTAINER every ${INTERVAL}s for up to ${MAX_SECONDS}s; captures to $OUT_DIR"

# Probe from a SIBLING container on the same network rather than from here: the gateway publishes no
# host port (private network only), which is the same reason agent-stack.mjs probes it that way.
gateway_healthy() {
  docker exec "$PROBE_FROM" wget -qO- --timeout=5 "http://${CONTAINER}:8000/health" 2>/dev/null | grep -q ok
}

capture() {
  echo "$MARKER ⚠️  $CONTAINER stopped answering /health — capturing while it is still wedged"

  # 1. Container state FIRST and fastest — this is what distinguishes a livelock (running, 100% CPU)
  #    from a crash (exited) or an OOM kill, and it is the cheapest thing to lose.
  docker inspect "$CONTAINER" > "$OUT_DIR/inspect.json" 2>&1
  docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} ({{.MemPerc}})' \
    "$CONTAINER" > "$OUT_DIR/stats.txt" 2>&1
  cat "$OUT_DIR/stats.txt"

  # 2. The in-process dump. Primary mechanism, because it needs no privilege and no tooling in the
  #    image: faulthandler writes from the C signal handler, so it does not need the interpreter to
  #    reach a safe point in Python-level scheduling — which is precisely what a busy loop denies.
  local before
  before=$(docker logs "$CONTAINER" 2>&1 | wc -l)
  docker kill -s USR1 "$CONTAINER" >/dev/null 2>&1 \
    && echo "$MARKER sent SIGUSR1" \
    || echo "$MARKER could not signal the container"
  sleep 3
  docker logs "$CONTAINER" 2>&1 | tail -n +"$((before + 1))" > "$OUT_DIR/faulthandler-stack.txt"

  # 3. py-spy, from a sibling sharing the target's PID namespace. Second mechanism deliberately: it
  #    also shows WHERE THE CPU IS GOING (`top`), which for a spin is the direct answer — but it needs
  #    SYS_PTRACE, which a rootless daemon may refuse. Neither mechanism is trusted alone.
  # py-spy ships on PyPI, NOT as a container image — `benfred/py-spy` does not exist on Docker Hub
  # and a drill against it failed with `pull access denied`, which reads like a permissions problem
  # and is actually a wrong name. Installed into a throwaway python container instead.
  local pyspy='pip install --quiet --disable-pip-version-check py-spy >/dev/null 2>&1 || exit 90;'
  docker run --rm --pid="container:${CONTAINER}" --cap-add SYS_PTRACE python:3.13-slim \
    sh -c "${pyspy} py-spy dump --pid 1" > "$OUT_DIR/py-spy-dump.txt" 2>&1 \
    && echo "$MARKER py-spy dump captured" \
    || echo "$MARKER py-spy dump unavailable (see the file for why) — faulthandler is the fallback"
  docker run --rm --pid="container:${CONTAINER}" --cap-add SYS_PTRACE python:3.13-slim \
    sh -c "${pyspy} py-spy top --pid 1 --duration 10 --nonblocking" > "$OUT_DIR/py-spy-top.txt" 2>&1 || true

  # 4. The tail of its own log — what it was doing immediately before it stopped.
  docker logs --tail 400 -t "$CONTAINER" > "$OUT_DIR/gateway-tail.log" 2>&1

  echo "$MARKER captured to $OUT_DIR"
  echo "$MARKER   faulthandler-stack.txt  <- the spinning frame should be here"
  echo "$MARKER   py-spy-top.txt          <- where the CPU is going"
}

elapsed=0
while [ "$elapsed" -lt "$MAX_SECONDS" ]; do
  if ! gateway_healthy; then
    # Confirm before capturing: one dropped probe is not a wedge, and a false capture would waste the
    # single shot this script gets per run.
    sleep 5
    if ! gateway_healthy; then
      capture
      echo "$MARKER WEDGE CAPTURED — stopping. The state persists; a second dump would bury the first."
      exit 0
    fi
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

# NOT the same statement as "captured and found nothing".
echo "$MARKER NO WEDGE OBSERVED in ${MAX_SECONDS}s — nothing was captured, which is not evidence that"
echo "$MARKER the defect is fixed. It has reproduced 3 of 3 full suites; this run is one more sample."
exit 0
