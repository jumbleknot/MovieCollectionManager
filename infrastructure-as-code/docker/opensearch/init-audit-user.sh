#!/usr/bin/env bash
# init-audit-user.sh — Idempotent setup of the write-only agent-audit role + user.
#
# Run ONCE after `docker compose --profile audit up -d` (and after opensearch is healthy).
# Safe to re-run: uses PUT (upsert) for all three resources.
#
# Usage:
#   bash infrastructure-as-code/docker/opensearch/init-audit-user.sh
#
# Credentials created:
#   Role:    agent-audit  (create_index + write/index + write/bulk on `mcm-agent-audit` AND
#                          `mcm-agent-audit-*` — see the index_patterns below; the LIVE index is the
#                          EXACT name, so the wildcard alone would not cover it)
#   User:    agent-audit  (password: $OPENSEARCH_AUDIT_WRITER_PASSWORD — generated, from stacks/audit.env)
#   Mapping: agent-audit user → agent-audit role
#
# Dev-only credentials for the local audit stack (--profile audit). Values are generated per-machine
# by `node scripts/gen-dev-secrets.mjs` into infrastructure-as-code/docker/stacks/audit.env
# (gitignored, feature 021); this script sources that file so no secret is hardcoded here (feature 022).

set -euo pipefail

# Load the generated audit-stack credentials (OPENSEARCH_INITIAL_ADMIN_PASSWORD +
# OPENSEARCH_AUDIT_WRITER_PASSWORD) unless already exported by the caller.
_STACK_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/../stacks" && pwd)/audit.env"
if [ -f "${_STACK_ENV}" ]; then set -a; . "${_STACK_ENV}"; set +a; fi

OPENSEARCH_URL="${OPENSEARCH_URL:-https://localhost:9200}"
ADMIN_USER="${OPENSEARCH_ADMIN_USER:-admin}"
ADMIN_PASS="${OPENSEARCH_INITIAL_ADMIN_PASSWORD:?set OPENSEARCH_INITIAL_ADMIN_PASSWORD (run: node scripts/gen-dev-secrets.mjs → stacks/audit.env)}"
AUDIT_PASS="${OPENSEARCH_AUDIT_WRITER_PASSWORD:?set OPENSEARCH_AUDIT_WRITER_PASSWORD (run: node scripts/gen-dev-secrets.mjs → stacks/audit.env)}"

echo "==> Creating agent-audit role (write-only on mcm-agent-audit and mcm-agent-audit-*)..."
curl -sk -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X PUT "${OPENSEARCH_URL}/_plugins/_security/api/roles/agent-audit" \
  -H "Content-Type: application/json" \
  -d '{
    "cluster_permissions": ["cluster_composite_ops"],
    "index_permissions": [{
      "index_patterns": ["mcm-agent-audit-*", "mcm-agent-audit"],
      "allowed_actions": [
        "create_index",
        "indices:data/write/index",
        "indices:data/write/bulk",
        "indices:data/write/bulk*"
      ]
    }]
  }' | tee /dev/stderr | grep -qE '"CREATED"|"OK"'
echo ""
echo "==> Creating agent-audit internal user..."
curl -sk -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X PUT "${OPENSEARCH_URL}/_plugins/_security/api/internalusers/agent-audit" \
  -H "Content-Type: application/json" \
  -d "{
    \"password\": \"${AUDIT_PASS}\",
    \"backend_roles\": [],
    \"description\": \"Write-only audit sink user (feature 012 T076a)\"
  }" | tee /dev/stderr | grep -qE '"CREATED"|"OK"'
echo ""
echo "==> Mapping agent-audit user to agent-audit role..."
curl -sk -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X PUT "${OPENSEARCH_URL}/_plugins/_security/api/rolesmapping/agent-audit" \
  -H "Content-Type: application/json" \
  -d '{"users": ["agent-audit"]}' | tee /dev/stderr | grep -qE '"CREATED"|"OK"'
echo ""
echo "==> Verifying write (should be 201)..."
WRITE_BODY="$(mktemp)"
HTTP_CODE=$(curl -sk -u "agent-audit:${AUDIT_PASS}" \
  -X POST "${OPENSEARCH_URL}/mcm-agent-audit/_doc" \
  -H "Content-Type: application/json" \
  -d '{"action":"init-verify","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' \
  -w "%{http_code}" -o "${WRITE_BODY}")
if [ "${HTTP_CODE}" = "201" ]; then
  echo "  PASS: write returned 201"
else
  echo "  FAIL: write returned ${HTTP_CODE}" && exit 1
fi

# The id of the doc just written. READ and DELETE are probed against a doc that DEMONSTRABLY EXISTS,
# because a random id would prove nothing: a wrongly-permissive role answers 404 for a missing doc,
# which is indistinguishable from a correct denial if you only check "not 200". With a real id, a
# permissive role returns 200 and the document — unambiguous.
DOC_ID=$(sed -n 's/.*"_id":"\([^"]*\)".*/\1/p' "${WRITE_BODY}")
rm -f "${WRITE_BODY}"
[ -n "${DOC_ID}" ] || { echo "  FAIL: could not parse _id from the write response" && exit 1; }

echo "==> Verifying READ is blocked (should be 403)..."
HTTP_CODE=$(curl -sk -u "agent-audit:${AUDIT_PASS}" \
  "${OPENSEARCH_URL}/mcm-agent-audit/_doc/${DOC_ID}" \
  -w "%{http_code}" -o /dev/null)
if [ "${HTTP_CODE}" = "403" ]; then
  echo "  PASS: read returned 403"
else
  echo "  FAIL: read returned ${HTTP_CODE} (expected 403) — the write-only account can READ audit events" && exit 1
fi

echo "==> Verifying DELETE is blocked (should be 403)..."
HTTP_CODE=$(curl -sk -u "agent-audit:${AUDIT_PASS}" \
  -X DELETE "${OPENSEARCH_URL}/mcm-agent-audit/_doc/${DOC_ID}" \
  -w "%{http_code}" -o /dev/null)
if [ "${HTTP_CODE}" = "403" ]; then
  echo "  PASS: delete returned 403"
else
  echo "  FAIL: delete returned ${HTTP_CODE} (expected 403) — an APPEND-ONLY sink whose writer can delete" && exit 1
fi

echo "==> Verifying search is blocked (should be 403)..."
HTTP_CODE=$(curl -sk -u "agent-audit:${AUDIT_PASS}" \
  "${OPENSEARCH_URL}/mcm-agent-audit/_search" \
  -w "%{http_code}" -o /dev/null)
if [ "${HTTP_CODE}" = "403" ]; then
  echo "  PASS: search returned 403"
else
  echo "  FAIL: search returned ${HTTP_CODE} (expected 403)" && exit 1
fi

echo ""
echo "Done. OpenSearch audit posture verified."
echo "  Admin:         ${ADMIN_USER} / ${ADMIN_PASS}"
echo "  Write-only:    agent-audit / ${AUDIT_PASS}"
