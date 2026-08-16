#!/usr/bin/env bash
# verify-firewall-allowlist.sh — feature 038 (full dev-container toolchain)
#
# Governing success criterion: SC-009 (the extended egress firewall allows exactly the added
# package sources — Rust/crates, Python/PyPI, Expo — and still REFUSES any non-allowlisted host).
# Governing requirement: FR-012 (extend the allowlist by exactly the added sources; stay default-deny).
#
# Asserts, from INSIDE the dev container AFTER init-firewall.sh has run, that:
#   1. the newly-added package sources are REACHABLE (crates.io, pypi.org, api.expo.dev)
#   2. an arbitrary NON-allowlisted host is REFUSED / times out (default-deny still holds)
#
# RED-first: before init-firewall.sh's ALLOWED_DOMAINS is extended (T030), the crates/PyPI/Expo
# fetches are DROPped → they time out → check 1 fails.
# Exit 0 = allowlist correct AND default-deny intact; non-zero otherwise.
#
# NOTE: this asserts the RUNTIME firewall. It requires the firewall to be active (postStartCommand
# ran). If run before the firewall is applied, everything is reachable and the default-deny check
# (2) will correctly fail — signalling "apply the firewall first", which is the intended guard.

set -uo pipefail

fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }

echo "[verify-firewall-allowlist] SC-009"

if [ "${MCM_DEVCONTAINER:-}" != "1" ]; then
  echo "  ✗ MCM_DEVCONTAINER != 1 — run inside the dev container (RED)" >&2
  echo "[verify-firewall-allowlist] FAIL (not in container)"; exit 1
fi

command -v curl >/dev/null 2>&1 || { err "curl not found"; echo "[verify-firewall-allowlist] FAIL"; exit 1; }

TIMEOUT=8

# reachable <url> <label> — a connection that completes (any HTTP status) proves egress is allowed.
# --max-time bounds a DROP-induced hang; we only care that the TCP/TLS handshake is not blackholed.
reachable() {
  local url="$1" label="$2"
  if curl -fsS --max-time "$TIMEOUT" -o /dev/null "$url" 2>/dev/null \
     || curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "$url" 2>/dev/null | grep -qE '^[0-9]{3}$'; then
    ok "reachable: $label ($url)"
  else
    err "NOT reachable: $label ($url) — allowlist missing this source (SC-009)"
  fi
}

# ── 060 T033: the expectation is READ from the canonical list, never re-listed here ─────────────
#
# This script used to carry its own inline copy of the destinations it checked. A check that holds
# its own copy of the expectation CANNOT DETECT DRIFT IN THE THING IT IS CHECKING — it passes
# happily while the canonical list and the live ruleset disagree, which is exactly the R8 failure
# the extraction exists to prevent. Demonstrated before this change: adding a destination to
# egress-allowlist.json that the live ipset did not contain left this script reporting PASS.
#
# The live ruleset is the ipset `allowed-domains`, which holds IPs. So drift is detected by
# resolving each canonical domain and asserting at least one of its addresses is in the set. That
# also makes the CDN-rotation class visible: a `cdnRotating: true` entry whose A-records have moved
# since the last run shows up here as drift, which is the documented "re-run init-firewall.sh"
# reflex rather than a missing rule.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="$REPO_ROOT/scripts/gen-egress-policy.mjs"

echo "  — the live ruleset matches the canonical destination list"
if [ ! -f "$GEN" ]; then
  err "generator not found at $GEN — cannot derive the expectation"
elif ! command -v ipset >/dev/null 2>&1; then
  err "ipset not available — cannot read the live ruleset"
else
  live_ips="$(sudo ipset list allowed-domains 2>/dev/null || ipset list allowed-domains 2>/dev/null || true)"
  if [ -z "$live_ips" ]; then
    err "ipset 'allowed-domains' is empty or unreadable — has init-firewall.sh run?"
  else
    checked=0; drifted=0
    while read -r d; do
      [ -z "$d" ] && continue
      checked=$(( checked + 1 ))
      found=0
      for ip in $(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u); do
        printf '%s' "$live_ips" | grep -qF "$ip" && { found=1; break; }
      done
      if [ "$found" -eq 0 ]; then
        echo "      … not in the live ipset: $d" >&2
        drifted=$(( drifted + 1 ))
      fi
    done < <(FORGE_REGISTRY_HOST="${FORGE_REGISTRY_HOST:-}" node "$GEN" --format ipset-domains \
               ${FORGE_REGISTRY_HOST:+--forge-host "$FORGE_REGISTRY_HOST"} 2>/dev/null)

    if [ "$checked" -eq 0 ]; then
      err "derived ZERO destinations from the canonical list — this check asserted nothing"
    elif [ "$drifted" -eq 0 ]; then
      ok "all $checked canonical destinations are represented in the live ipset"
    else
      err "$drifted of $checked canonical destinations are NOT in the live ipset — the layers have drifted (re-run init-firewall.sh; if that does not fix it, the rule is genuinely missing)"
    fi
  fi
fi

echo "  — a representative destination per group is actually reachable"
# Reachability is still probed, but the SAMPLE is derived from the canonical file rather than
# hardcoded, so a new group cannot be silently left unprobed.
if [ -f "$REPO_ROOT/.devcontainer/egress-allowlist.json" ]; then
  while read -r group domain; do
    [ -z "$domain" ] && continue
    reachable "https://${domain}/" "${domain} (group: ${group})"
  done < <(node -e '
    const l = require(process.argv[1]);
    const seen = new Set();
    for (const d of l.destinations) if (!seen.has(d.group)) { seen.add(d.group); console.log(d.group + " " + d.domain); }
  ' "$REPO_ROOT/.devcontainer/egress-allowlist.json" 2>/dev/null)
else
  err "canonical list not found — cannot derive reachability probes"
fi

# ── 060 T046/T047 (G5): THE SIBLING PROBE — the security payoff of the whole feature ────────────
#
# This is the assertion the migration exists to make true, and it must be a REAL probe from a REAL
# sibling container. Inferring it from the policy's stated scope proves nothing: the entire claim is
# that enforcement happens OUTSIDE the VM and therefore covers containers the assistant creates, and
# the only way to know is to have such a container try.
#
# It is RED by design on the Docker Desktop path. init-firewall.sh's own header says it does not
# police the FORWARD chain, so a nested container there reaches anything it likes — the documented
# 037 residual. Seeing it fail there is what makes the GREEN here mean something.
echo "  — sibling-container egress is governed (G5 — the closed 037 residual)"
if ! command -v docker >/dev/null 2>&1; then
  err "docker CLI absent — cannot run the sibling probe"
else
  # curlimages/curl is tiny and has no shell, so the probe is exactly one request.
  sib_out="$(docker run --rm curlimages/curl:latest \
      -s -i --max-time 15 "https://${BLOCKED_HOST_SIBLING:-example.com}/" 2>&1 || true)"
  if printf '%s' "$sib_out" | grep -q 'Blocked by network policy'; then
    ok "sibling container REFUSED ${BLOCKED_HOST_SIBLING:-example.com} (refusal came from the sandbox policy)"
  elif [ -z "$(printf '%s' "$sib_out" | tr -d '[:space:]')" ]; then
    ok "sibling container could not reach ${BLOCKED_HOST_SIBLING:-example.com} (no response — blackholed)"
  else
    err "sibling container REACHED ${BLOCKED_HOST_SIBLING:-example.com} — nested/sibling egress is UNFILTERED"
  fi
fi

echo "  — default-deny still holds (arbitrary host refused)"
# A host that is DEFINITELY not on the allowlist. Under default-deny the OUTPUT DROP blackholes it →
# curl times out (exit 28) or fails to connect. If it SUCCEEDS, egress is open → default-deny broken
# (or the firewall was not applied).
BLOCKED_URL="https://example.com/"
if curl -sS --max-time "$TIMEOUT" -o /dev/null "$BLOCKED_URL" 2>/dev/null; then
  err "arbitrary host $BLOCKED_URL is REACHABLE — default-deny NOT in effect (is the firewall applied?)"
else
  ok "arbitrary host refused/timed out ($BLOCKED_URL) — default-deny intact"
fi

if [ "$fail" -eq 0 ]; then
  echo "[verify-firewall-allowlist] PASS (SC-009 — allowlist exact, default-deny intact)"; exit 0
else
  echo "[verify-firewall-allowlist] FAIL (SC-009)"; exit 1
fi
