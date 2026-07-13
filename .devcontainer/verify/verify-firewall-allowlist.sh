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

echo "  — added package sources are reachable"
reachable "https://static.crates.io/config.json" "Rust crates (static.crates.io)"
reachable "https://index.crates.io/config.json" "Rust crates index (index.crates.io)"
reachable "https://pypi.org/simple/" "PyPI (pypi.org)"
reachable "https://files.pythonhosted.org/" "PyPI files (files.pythonhosted.org)"
reachable "https://astral.sh/" "astral (uv installer)"
reachable "https://api.expo.dev/" "Expo (api.expo.dev)"

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
