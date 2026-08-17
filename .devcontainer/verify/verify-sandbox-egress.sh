#!/usr/bin/env bash
# verify-sandbox-egress.sh — feature 060 (dev container on Docker Sandbox)
#
# Governing: FR-008 (deny-by-default egress, enforced OUTSIDE the microVM so it cannot be altered
#            from within, with an audit record of refusals), FR-010 (the workstation's loopback
#            services are unreachable from inside), US2-AC1/AC2/AC5/AC6.
# Contract:  specs/060-devcontainer-docker-sandbox/contracts/verify-harness.md
#
# Modes:
#   (default)       VM-side. Run in the sandbox shell: probes egress from inside the microVM.
#   --audit-check   HOST-side. Run on the workstation: asserts the refusal reached `sbx policy log`
#                   and that the live policy matches the canonical list. Blocked-but-unaudited is a
#                   weaker posture than FR-008 claims, so the audit half is asserted separately
#                   rather than inferred from the block.
#
# ── Two measured traps this script is written around ─────────────────────────────────────────────
#
# 1. A REFUSAL IS AN HTTP 403, NOT A TIMEOUT. The sandbox egress proxy answers a disallowed host
#    with a real response:
#        HTTP/1.1 403 Forbidden
#        Blocked by network policy: domain example.com:443
#    The in-VM iptables layer, by contrast, blackholes the packet and curl times out. A probe that
#    asserts "blocked == timeout" (the shape init-firewall.sh produces) silently MISREADS the
#    sandbox layer as a pass. Both shapes are therefore accepted, and the proxy's own marker string
#    is preferred because it is unambiguous — a bare 403 could equally come from the origin server.
#
# 2. A TCP CONNECT PROVES NOTHING HERE. Measured: `/dev/tcp/gateway.docker.internal/11434` and
#    `/dev/tcp/<forge>/443` both "succeed" while no service answers — the gateway accepts TCP on
#    arbitrary ports without forwarding. Every probe below is therefore APPLICATION-level (HTTP).
#    Using a connect test would report the workstation's loopback services as reachable and fail
#    this script for a reason that is not true.
#
# Exit 0 = pass, 1 = fail. One ✓/✗ line per assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIST="$REPO_ROOT/.devcontainer/egress-allowlist.json"

MODE="${1:-vm}"
TIMEOUT="${MCM_EGRESS_TIMEOUT:-15}"

# A destination that must never be allowlisted, used as the refusal probe.
BLOCKED_HOST="example.com"
# The proxy's own refusal marker — see trap 1 above.
BLOCK_MARKER="Blocked by network policy"

failures=0
ok()  { printf '  ✓ %s\n' "$*"; }
err() { printf '  ✗ %s\n' "$*" >&2; failures=$(( failures + 1 )); }

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# HOST-SIDE MODE — the audit trail and the policy/canonical-list correspondence
# ─────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = "--audit-check" ]; then
  echo "[verify-sandbox-egress] --audit-check (host-side)"
  SBX="${SBX_BIN:-sbx}"
  command -v "$SBX" >/dev/null 2>&1 || SBX="$LOCALAPPDATA/DockerSandboxes/bin/sbx.exe"
  if ! command -v "$SBX" >/dev/null 2>&1; then
    err "sbx CLI not found — set SBX_BIN (it is NOT on PATH in a fresh shell; see the runbook)"
    echo "[verify-sandbox-egress] FAIL"; exit 1
  fi

  # US2-AC2 (audit half): the refusal must be recorded, not merely enforced.
  if "$SBX" policy log 2>/dev/null | grep -q "$BLOCKED_HOST"; then
    ok "refusal of $BLOCKED_HOST appears in the governance audit log"
  else
    err "no audit entry naming $BLOCKED_HOST — blocked-but-unaudited does not satisfy FR-008"
  fi

  # US2-AC1: the enforced allowlist derives from the canonical list, with nothing hand-added.
  #
  # MUST use --json. The default `sbx policy ls <sandbox>` output is a SUMMARY ("allow 31 hosts
  # from <rule-ids>") that names no resources at all, so grepping it reports every destination as
  # absent — a confident, entirely false "the layers have diverged". Measured 2026-08-16.
  SANDBOX_NAME="${MCM_SANDBOX_NAME:-mcm}"
  if [ -f "$LIST" ]; then
    live="$("$SBX" policy ls "$SANDBOX_NAME" --json 2>/dev/null)"
    if [ -z "$live" ]; then
      err "could not read the live policy for sandbox '$SANDBOX_NAME' (--json returned nothing)"
    else
      missing=0; checked=0
      while read -r d; do
        [ -z "$d" ] && continue
        checked=$(( checked + 1 ))
        printf '%s' "$live" | grep -q "\"$d\"" || { echo "      … not in live policy: $d"; missing=$(( missing + 1 )); }
      done < <(node "$REPO_ROOT/scripts/gen-egress-policy.mjs" --format ipset-domains 2>/dev/null)

      if [ "$checked" -eq 0 ]; then
        err "derived zero destinations from the canonical list — the check asserted nothing"
      elif [ "$missing" -eq 0 ]; then
        ok "all $checked canonical destinations are present in the live sandbox policy"
      else
        err "$missing of $checked canonical destination(s) absent from the live policy — the layers have diverged"
      fi
    fi
  else
    err "canonical list not found at $LIST"
  fi

  echo
  [ "$failures" -eq 0 ] && { echo "0 failures — audit checks passed"; exit 0; }
  echo "$failures failure(s)"; exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# VM-SIDE MODE — probes from inside the microVM
# ─────────────────────────────────────────────────────────────────────────────────────────────────
echo "[verify-sandbox-egress] VM-side (FR-008, FR-010)"

command -v curl >/dev/null 2>&1 || { err "curl not found"; echo "[verify-sandbox-egress] FAIL"; exit 1; }

# status <url> — the HTTP status code, or 000 if no exchange completed.
#
# Deliberately does NOT download the body. An earlier revision used `curl -i` and matched the
# status line out of the full response; that made every probe download the destination's entire
# homepage, and github.com's is large enough to exceed the timeout THROUGH THE PROXY — so a
# perfectly reachable host was reported unreachable. The probe was wrong, not the allowlist, and
# "fix the allowlist until the test passes" would have silently widened egress to chase a bug.
status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$@" 2>/dev/null || true
}

# is_policy_block <url> [curl-args…] — true when the refusal came from the SANDBOX POLICY.
# Only consulted for a 403, whose body is small, so this never downloads a real page. The marker
# is what distinguishes a policy refusal from an origin server's own 403.
is_policy_block() {
  curl -s --max-time "$TIMEOUT" "$@" 2>/dev/null | grep -q "$BLOCK_MARKER"
}

# refused <url> [curl-args…] — 0 when REFUSED, by either enforcement shape.
refused() {
  local code; code="$(status "$@")"
  [ "$code" = "000" ] && return 0                      # blackholed — the in-VM iptables shape
  [ "$code" = "403" ] && is_policy_block "$@" && return 0   # proxy refusal — the sandbox shape
  return 1
}

# reachable <url> — a completed HTTP exchange that is not a policy refusal. Any real status counts:
# this asserts EGRESS, not authentication, so 401/404 from a bare GET are passes.
reachable() {
  local code; code="$(status "$1")"
  [ "$code" = "000" ] && return 1
  [ "$code" = "403" ] && is_policy_block "$1" && return 1
  return 0
}

# ── US2-AC1: allowlisted destinations are reachable ──────────────────────────────────────────────
# One representative per group, DERIVED from the canonical file rather than hardcoded here: a check
# carrying its own copy of the expectation cannot detect drift in the thing it is checking.
echo "  — allowlisted destinations reachable (one per group, derived from egress-allowlist.json)"
if [ ! -f "$LIST" ]; then
  err "canonical list not found at $LIST"
else
  reps="$(node -e '
    const l = require(process.argv[1]);
    const seen = new Set();
    for (const d of l.destinations) {
      if (!seen.has(d.group)) { seen.add(d.group); console.log(d.group + " " + d.domain); }
    }
  ' "$LIST" 2>/dev/null)"
  if [ -z "$reps" ]; then
    err "could not derive group representatives from the canonical list"
  else
    while read -r group domain; do
      [ -z "$domain" ] && continue
      if reachable "https://$domain/"; then
        ok "reachable: $domain (group: $group)"
      else
        err "NOT reachable: $domain (group: $group) — allowlist does not cover this group"
      fi
    done <<< "$reps"
  fi
fi

# ── US2-AC2: a non-allowlisted destination is refused ────────────────────────────────────────────
echo "  — deny-by-default holds"
if refused "https://$BLOCKED_HOST/"; then
  ok "refused: $BLOCKED_HOST (not on the allowlist)"
else
  err "$BLOCKED_HOST is REACHABLE — deny-by-default is NOT enforcing"
fi

# ── US2-AC5: enforcement cannot be altered from inside the sandbox ───────────────────────────────
# The proxy is wired in by environment variables, so the obvious escape is to ignore them. If
# bypassing the proxy reaches the internet, enforcement is advisory rather than enforced, and the
# whole isolation claim of this feature is void.
echo "  — enforcement is not bypassable from inside"
if refused "https://$BLOCKED_HOST/" --noproxy '*'; then
  ok "bypassing the proxy env (--noproxy) does not reach $BLOCKED_HOST"
else
  err "--noproxy REACHED $BLOCKED_HOST — enforcement is advisory, not enforced (FR-008 void)"
fi

env_code="$(env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY \
  curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "https://$BLOCKED_HOST/" 2>/dev/null || true)"
if [ "$env_code" = "000" ] || [ "$env_code" = "403" ]; then
  ok "clearing the proxy environment does not reach $BLOCKED_HOST"
else
  err "clearing proxy env REACHED $BLOCKED_HOST (HTTP $env_code) — enforcement is env-dependent (FR-008 void)"
fi

# ── US2-AC6 / FR-010: the workstation's loopback services are unreachable ────────────────────────
# Application-level ONLY — see trap 2 in the header. A TCP connect to the gateway succeeds on
# arbitrary ports without forwarding, so a connect-based probe reports a false failure here.
echo "  — the workstation's loopback services are unreachable"
host_loopback_reachable=0
for hp in "gateway.docker.internal:11434" "host.docker.internal:11434" "gateway.docker.internal:5432"; do
  if curl -s -o /dev/null --max-time 6 --noproxy '*' "http://$hp/" 2>/dev/null; then
    err "workstation service REACHABLE from inside the sandbox: $hp"
    host_loopback_reachable=1
  fi
done
[ "$host_loopback_reachable" -eq 0 ] && ok "no workstation loopback service answered (ollama :11434, postgres :5432)"

echo
if [ "$failures" -eq 0 ]; then
  echo "0 failures — sandbox egress governed as specified"
  echo "NOTE: the audit half of US2-AC2 is asserted host-side — run: bash $0 --audit-check"
  exit 0
fi
echo "$failures failure(s)"
exit 1
