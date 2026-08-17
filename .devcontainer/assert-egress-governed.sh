#!/usr/bin/env bash
# assert-egress-governed.sh — feature 060 (Docker Sandbox rehost), decision D-18.
#
# WHAT THIS REPLACES, AND WHY.
#
# On the Docker Desktop path the dev container programs its OWN egress firewall at every start
# (init-firewall.sh: ipset + iptables default-DROP, inside the container's private network
# namespace). On the SANDBOX path that is both unnecessary and actively hazardous, and neither of
# those was theory — both were measured on 2026-08-16:
#
#   1. IT IS NOT CONTAINER-SCOPED HERE. The sandbox dev container runs with `--network=host`, where
#      "host" is the microVM. Measured:
#          VM   netns: net:[4026532855]
#          cont netns: net:[4026532855]     ← the SAME namespace, not merely similar
#      So `iptables -P OUTPUT DROP` from inside this container is a VM-WIDE default-deny. It would
#      apply to the sandbox's own policy proxy and to every sibling container's egress path. The
#      blast radius of a mistake is the whole environment, not one container.
#
#   2. IT WAS NOT RUNNING ANYWAY — and nothing noticed. The container had `-P OUTPUT ACCEPT` and no
#      `allowed-domains` ipset at all, because postStartCommand is a DEVCONTAINER-lifecycle hook: it
#      fires on `devcontainer up`, NOT on a Docker-level restart. This VM idle-stops after ~30 s with
#      no attached session and `--restart=always` brings the container back through Docker, so the
#      in-VM layer silently disappears on the first idle cycle. Measured on the live container:
#      created=19:17:32, started=19:41:01, restartCount=0.
#
#   3. EGRESS WAS FULLY GOVERNED THE ENTIRE TIME REGARDLESS. With zero in-VM rules present, three
#      independent probes still refused non-allowlisted traffic (see G5 evidence in tasks.md):
#        • dev container  → example.com    : no route, curl writes 000
#        • sibling ctr    → example.com    : rc=6, NXDOMAIN (DNS-layer refusal)
#        • sibling ctr    → 1.1.1.1 raw IP : rc=35, TLS terminated — raw IP does NOT bypass
#      while all five allowlist groups stayed reachable, and registry-1.docker.io answered 401 from
#      a sibling. Enforcement lives OUTSIDE the VM. That is the entire point of the migration.
#
# So this path does not re-implement enforcement. It VERIFIES it, and fails loudly if it is absent.
# The distinction matters: removing the second layer without a check would mean a future regression
# in the sandbox policy leaves the container silently unprotected, which is precisely the class of
# failure this feature exists to eliminate.
#
# ⚠️ KNOWN GAP, stated rather than papered over: this guard runs from postStartCommand and therefore
# inherits the SAME restart blindness described in (2) — it will not re-run after a Docker-level
# restart. It is a creation/attach-time assertion, not a continuous monitor. The continuous
# guarantee is the host-side policy itself, which does survive restarts because it is not in the VM.
# verify-firewall-allowlist.sh re-asserts this on demand at any time.

set -uo pipefail

BLOCKED_HOST="${MCM_EGRESS_BLOCKED_PROBE:-example.com}"
ALLOWED_URL="${MCM_EGRESS_ALLOWED_PROBE:-https://registry.npmjs.org/}"
TIMEOUT=10

echo "[assert-egress-governed] D-18 — verifying the host-side sandbox policy governs this container"

if ! command -v curl >/dev/null 2>&1; then
  echo "[assert-egress-governed] curl absent — cannot verify egress; refusing to claim it is governed" >&2
  exit 1
fi

fail=0

# 1. A non-allowlisted destination MUST NOT be reachable.
#
# Deliberately checks for SUCCESS and treats every failure mode as a pass, rather than matching one
# refusal signature. This environment produces THREE different ones depending on vantage point
# (000 / NXDOMAIN / TLS eof), and a check keyed to one of them reports a hole when the mechanism
# merely changed. "Did the request succeed?" is the question that stays correct.
if curl -sS --max-time "$TIMEOUT" -o /dev/null "https://${BLOCKED_HOST}/" 2>/dev/null; then
  echo "  ✗ ${BLOCKED_HOST} is REACHABLE — egress is NOT governed on this container" >&2
  echo "    The sandbox policy is the only enforcement layer on this path (D-18); if it is not" >&2
  echo "    applied, this container has UNRESTRICTED outbound access. Check: sbx policy ls <name> --json" >&2
  fail=1
else
  echo "  ✓ ${BLOCKED_HOST} refused — default-deny is in effect"
fi

# 2. An allowlisted destination MUST still work.
#
# Without this, a totally severed network passes check 1 and the container looks "secure" while
# being merely broken — the same false-green shape as a skipped test reading as a pass.
if curl -sS --max-time "$TIMEOUT" -o /dev/null "$ALLOWED_URL" 2>/dev/null; then
  echo "  ✓ ${ALLOWED_URL} reachable — the allowlist is applied, not a blanket block"
else
  echo "  ✗ ${ALLOWED_URL} is NOT reachable — egress appears severed rather than filtered" >&2
  echo "    This is not a security pass: it means the allowlist is not working either." >&2
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "[assert-egress-governed] PASS — host-side policy governs this container (D-18)"
  exit 0
fi
echo "[assert-egress-governed] FAIL — egress posture is not as designed; do not treat this container as sandboxed" >&2
exit 1
