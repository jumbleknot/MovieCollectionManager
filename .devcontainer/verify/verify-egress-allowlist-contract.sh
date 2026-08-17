#!/usr/bin/env bash
# verify-egress-allowlist-contract.sh — feature 060 (dev container on Docker Sandbox)
#
# Governing: FR-007 (one canonical destination list, every enforcement configuration derived
#            from it), FR-011 (no topology-sensitive literal in git),
#            specs/060-devcontainer-docker-sandbox/contracts/egress-allowlist.md.
#
# Asserts that scripts/gen-egress-policy.mjs satisfies its contract, so that the two egress
# enforcement layers (host-side sandbox policy, in-VM iptables) cannot fork into two truths.
#
# Mode: ANY. This is a pure generator check — it shells out to node and reads only committed
# files, so it runs on the Windows host, in the dev container, or in the sandbox VM alike.
#
# Exit 0 = pass, 1 = fail. One ✓/✗ line per assertion. Eight assertions.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="$REPO_ROOT/scripts/gen-egress-policy.mjs"
LIST="$REPO_ROOT/.devcontainer/egress-allowlist.json"

# A synthetic, deliberately non-resolvable stand-in. The REAL forge host is topology-sensitive
# and must never appear in a committed file — that is half of what this script exists to enforce.
FAKE_FORGE="forge.test.invalid"

failures=0
ok()  { echo "✓ $*"; }
err() { echo "✗ $*"; failures=$(( failures + 1 )); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------------------------
# Preconditions. If the generator is absent every assertion below fails — which is exactly the
# expected RED state before T006 implements it.
# ---------------------------------------------------------------------------------------------
GEN_PRESENT=1
if [ ! -f "$GEN" ]; then
  err "scripts/gen-egress-policy.mjs not found"
  GEN_PRESENT=0
fi
if [ ! -f "$LIST" ]; then
  err ".devcontainer/egress-allowlist.json not found"
fi

# Destination count read from the canonical file itself — never hardcoded here. A hardcoded
# expectation is precisely the drift-blind failure mode this contract exists to prevent.
EXPECTED_COUNT=0
if [ -f "$LIST" ]; then
  EXPECTED_COUNT="$(node -e '
    const l = require(process.argv[1]);
    process.stdout.write(String((l.destinations || []).length));
  ' "$LIST" 2>/dev/null || echo 0)"
fi

# run_gen <outfile> <args...> ; echoes exit code, captures stdout/stderr separately
run_gen() {
  local out="$1"; shift
  if [ "$GEN_PRESENT" -eq 0 ]; then return 127; fi
  node "$GEN" "$@" >"$out" 2>"$out.err"
}

# Build a temporary variant of the canonical list with one field mutated, for the --check probes.
mutate_list() {  # $1=outfile  $2=node expression mutating `l`
  node -e '
    const fs = require("fs");
    const l = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    (0, eval)(process.argv[3]);
    fs.writeFileSync(process.argv[2], JSON.stringify(l, null, 2));
  ' "$LIST" "$1" "$2" 2>/dev/null
}

# ---------------------------------------------------------------------------------------------
# 1 — sbx-policy emits exactly one directive per destination
# ---------------------------------------------------------------------------------------------
if run_gen "$TMP/policy.txt" --format sbx-policy; then
  n="$(grep -c . "$TMP/policy.txt" || true)"
  if [ "$n" -eq "$EXPECTED_COUNT" ] && [ "$EXPECTED_COUNT" -gt 0 ]; then
    ok "--format sbx-policy emits one line per destination ($n)"
  else
    err "--format sbx-policy emitted $n lines, expected $EXPECTED_COUNT"
  fi
else
  err "--format sbx-policy failed to run"
fi

# ---------------------------------------------------------------------------------------------
# 2 — ipset-domains emits exactly one domain per destination
# ---------------------------------------------------------------------------------------------
if run_gen "$TMP/ipset.txt" --format ipset-domains; then
  n="$(grep -c . "$TMP/ipset.txt" || true)"
  if [ "$n" -eq "$EXPECTED_COUNT" ] && [ "$EXPECTED_COUNT" -gt 0 ]; then
    ok "--format ipset-domains emits one line per destination ($n)"
  else
    err "--format ipset-domains emitted $n lines, expected $EXPECTED_COUNT"
  fi
else
  err "--format ipset-domains failed to run"
fi

# ---------------------------------------------------------------------------------------------
# 3 — output is deterministic and stably ordered, so a regenerated form diffs empty
# ---------------------------------------------------------------------------------------------
if run_gen "$TMP/policy2.txt" --format sbx-policy && run_gen "$TMP/ipset2.txt" --format ipset-domains; then
  if cmp -s "$TMP/policy.txt" "$TMP/policy2.txt" && cmp -s "$TMP/ipset.txt" "$TMP/ipset2.txt"; then
    ok "both formats are deterministic and stably ordered across runs"
  else
    err "generator output is not stable across runs — a regenerated form would diff spuriously"
  fi
else
  err "could not re-run generator to compare ordering"
fi

# ---------------------------------------------------------------------------------------------
# 4 — --forge-host appends the forge entry to sbx-policy
# ---------------------------------------------------------------------------------------------
if run_gen "$TMP/policy-forge.txt" --format sbx-policy --forge-host "$FAKE_FORGE"; then
  before="$(grep -c . "$TMP/policy.txt" 2>/dev/null || echo 0)"
  after="$(grep -c . "$TMP/policy-forge.txt" || true)"
  if grep -q "$FAKE_FORGE" "$TMP/policy-forge.txt" && [ "$after" -eq $(( before + 1 )) ]; then
    ok "--forge-host appends exactly one forge entry to sbx-policy"
  else
    err "--forge-host did not append exactly one forge entry to sbx-policy (before=$before after=$after)"
  fi
else
  err "--format sbx-policy --forge-host failed to run"
fi

# ---------------------------------------------------------------------------------------------
# 5 — --forge-host appends the forge entry to ipset-domains
# ---------------------------------------------------------------------------------------------
if run_gen "$TMP/ipset-forge.txt" --format ipset-domains --forge-host "$FAKE_FORGE"; then
  before="$(grep -c . "$TMP/ipset.txt" 2>/dev/null || echo 0)"
  after="$(grep -c . "$TMP/ipset-forge.txt" || true)"
  if grep -q "^${FAKE_FORGE}$" "$TMP/ipset-forge.txt" && [ "$after" -eq $(( before + 1 )) ]; then
    ok "--forge-host appends exactly one forge entry to ipset-domains"
  else
    err "--forge-host did not append exactly one forge entry to ipset-domains (before=$before after=$after)"
  fi
else
  err "--format ipset-domains --forge-host failed to run"
fi

# ---------------------------------------------------------------------------------------------
# 6 — omitting --forge-host omits the entry CLEANLY: exit 0, no literal, no fallback, no error.
#     This mirrors init-firewall.sh's long-standing unset-skips-cleanly behaviour. A generator
#     that errored here would break every developer who has not set FORGE_REGISTRY_HOST.
# ---------------------------------------------------------------------------------------------
if [ "$GEN_PRESENT" -eq 1 ]; then
  node "$GEN" --format ipset-domains >"$TMP/noforge.txt" 2>"$TMP/noforge.err"
  rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$TMP/noforge.err" ] && ! grep -qi 'forge' "$TMP/noforge.txt"; then
    ok "omitting --forge-host omits the entry cleanly (exit 0, no literal, no stderr)"
  else
    err "omitting --forge-host was not clean (rc=$rc, stderr=$( [ -s "$TMP/noforge.err" ] && echo yes || echo no ))"
  fi
else
  err "omitting --forge-host omits the entry cleanly — generator absent"
fi

# ---------------------------------------------------------------------------------------------
# 7 — --check accepts the committed canonical file
# ---------------------------------------------------------------------------------------------
if [ "$GEN_PRESENT" -eq 1 ]; then
  if node "$GEN" --check >"$TMP/check.txt" 2>&1; then
    ok "--check accepts the committed egress-allowlist.json"
  else
    err "--check rejected the committed egress-allowlist.json: $(head -3 "$TMP/check.txt" | tr '\n' ' ')"
  fi
else
  err "--check accepts the committed egress-allowlist.json — generator absent"
fi

# ---------------------------------------------------------------------------------------------
# 8 — --check REJECTS each malformed shape: a bare IP, an empty reason, an unknown group.
#     All three must fail; a check that catches two of three is a check that lets one through.
# ---------------------------------------------------------------------------------------------
if [ "$GEN_PRESENT" -eq 1 ] && [ -f "$LIST" ]; then
  rejected=0; probes=0

  probe() {  # $1=label  $2=mutation
    probes=$(( probes + 1 ))
    mutate_list "$TMP/bad.json" "$2"
    if node "$GEN" --check --file "$TMP/bad.json" >"$TMP/bad.out" 2>&1; then
      echo "    … NOT rejected: $1"
    else
      rejected=$(( rejected + 1 ))
    fi
  }

  probe "bare IP"       'l.destinations[0].domain = "203.0.113.7"'
  probe "empty reason"  'l.destinations[0].reason = ""'
  probe "unknown group" 'l.destinations[0].group  = "wat"'

  if [ "$rejected" -eq "$probes" ]; then
    ok "--check rejects a bare IP, an empty reason, and an unknown group ($rejected/$probes)"
  else
    err "--check rejected only $rejected of $probes malformed shapes"
  fi
else
  err "--check rejects malformed shapes — generator absent"
fi

# ---------------------------------------------------------------------------------------------
echo
if [ "$failures" -eq 0 ]; then
  echo "0 failures — 8 assertions passed"
  exit 0
fi
echo "$failures failure(s)"
exit 1
