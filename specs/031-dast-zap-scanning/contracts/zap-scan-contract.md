# Contract: Scan Config, Allowlist & Report

Defines the versioned interfaces the scan tooling exposes. Field-level shapes live in [data-model.md](../data-model.md); this fixes the file locations, invocation, and I/O guarantees.

## ZAP Automation Framework plans

**Files**: `security/zap/zap-baseline.yaml`, `security/zap/zap-full.yaml`

Each plan MUST contain these AF jobs, in order:

1. `addOns` — ensure required add-ons present (spider, active-scan for `full`, `reports` incl. SARIF template).
2. `environment` — the three contexts (`bff`, `mc-service`, `agent-gateway`) with `urls`/`includePaths`; `agent-gateway` include limited to its reachable paths.
3. `script` — register `bearer-auth.js` (auth) and `bff-session-refresh.js` (httpsender).
4. `spider` (+ optional `spiderAjax` for the BFF web UI).
5. `passiveScan-wait`.
6. `activeScan` — **only in `zap-full.yaml`**, scoped to the `bff` and `mc-service` contexts (never `agent-gateway`).
7. `report` × 3 — templates `traditional-html`, `traditional-json`, `sarif-json`, all written to `security/zap/reports/`.

**Invariants**:
- `zap-baseline.yaml` MUST NOT contain an `activeScan` job.
- No credential literals; auth params come from env vars read by the scripts.
- Contexts MUST NOT include any Keycloak URL as a scan target (auth calls to Keycloak are allowed, scanning it is not).

## In-scanner auth scripts

**`security/zap/scripts/bearer-auth.js`** — ZAP authentication script.
- Input (env): `KC_TOKEN_URL`, `DAST_ROPC_CLIENT_ID`, `DAST_ROPC_CLIENT_SECRET`, `DAST_TEST_USER`, `DAST_TEST_PASSWORD`.
- Behavior: POST ROPC `grant_type=password` → set `Authorization: Bearer <access_token>` on outgoing requests to bearer targets. Re-mint when verification detects 401.
- Output: authenticated requests; MUST NOT log the token.

**`security/zap/scripts/bff-session-refresh.js`** — ZAP httpsender script.
- Behavior: on a `401` from a `bff` context request, call `POST /bff-api/auth/refresh` with the current `mcm_refresh_token`, update `mcm_access_token`, and retry once. MUST NOT log cookie values.

## Allowlist

**File**: `security/zap/allowlist.yaml` — list of entries `{pluginId, uriPattern, justification, addedBy}` (see data-model). Consumed **only** by the gate; ignored by ZAP so findings stay visible in reports.

## Gate script

**File**: `scripts/check-dast-findings.mjs`

```text
Usage: node scripts/check-dast-findings.mjs --report <zap-json> [--allowlist security/zap/allowlist.yaml]
       node scripts/check-dast-findings.mjs --selftest
```

- **Input**: ZAP `traditional-json` report + allowlist.
- **Behavior**: parse findings; drop those matched by an allowlist entry (`pluginId` == and `uri` matches `uriPattern`); of the remainder, if any `riskLevel == High` → print summary + **exit 1**; else print Medium/Low as warnings → **exit 0**.
- **`--selftest`**: run with an embedded synthetic report containing (a) an un-allowlisted High (expect exit 1) and (b) the same High allowlisted (expect exit 0); prove both, exit 0 iff detection works. Read-only; never touches the repo.
- **Output**: stdout summary grouped by risk; deterministic exit code. MUST NOT print secrets.

## Report output

Written to `security/zap/reports/` (gitignored): `report.html`, `report.json`, `report.sarif`. The CI job uploads this dir as an artifact. `report.json` is the gate's authoritative input.
