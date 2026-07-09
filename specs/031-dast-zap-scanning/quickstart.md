# Quickstart & Validation: DAST Security Scanning

Runnable scenarios that prove the feature works end-to-end. Contracts: [zap-scan-contract.md](./contracts/zap-scan-contract.md), [ci-integration-contract.md](./contracts/ci-integration-contract.md).

## Prerequisites

- Docker running; the local `auth` + `mcm` stacks up (see [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md)):
  - `node scripts/gen-dev-secrets.mjs`
  - `pnpm nx up-auth infrastructure-as-code`
  - `pnpm nx up-mcm infrastructure-as-code` (`--profile app --profile bff-nonsecure`; add `--profile agents` to include the gateway)
- `frontend/mcm-app/.env.e2e.local` present with `E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `E2E_ROPC_CLIENT_ID`, `E2E_ROPC_CLIENT_SECRET`.

## Scenario 1 — Local authenticated baseline (P1 / SC-001, SC-002, SC-003)

```bash
pnpm nx dast infrastructure-as-code        # or: node scripts/zap-scan.mjs --target local --mode baseline
```

**Expected**:
- ZAP container starts on the Compose network, authenticates, spiders + passive-scans all three targets.
- Reports appear at `security/zap/reports/report.{html,json,sarif}`.
- **SC-002**: `report.json` `crawledUrls` include protected post-auth endpoints (e.g. `/bff-api/collections`, `mc-service /api/v1/...`) — not just `/login`, `/register`, `/init`.
- **SC-003**: collection/movie counts are unchanged before vs after (baseline is non-destructive).

**Fail-fast check (FR-012)**: temporarily break the test password → the run exits non-zero with a clear "could not establish authenticated session" message, not a green public-only report.

## Scenario 2 — Gate fails on an un-allowlisted High (P2 / SC-004)

Prove RED without shipping a real vuln, using a synthetic report:

```bash
node scripts/check-dast-findings.mjs --selftest        # embedded High → expects exit 1 path proven
echo $?                                                 # 0  (selftest asserts both RED and GREEN internally)
```

Or against a crafted report containing a High finding:

```bash
node scripts/check-dast-findings.mjs --report tmp/high.json --allowlist security/zap/allowlist.yaml
echo $?                                                 # 1  (un-allowlisted High → gate fails)
```

**Expected**: gate prints the High finding grouped by risk and exits `1`.

## Scenario 3 — Allowlist suppresses without hiding (P3 / SC-006)

Add the finding to `security/zap/allowlist.yaml` (`pluginId` + `uriPattern` + `justification` + `addedBy`), then:

```bash
node scripts/check-dast-findings.mjs --report tmp/high.json --allowlist security/zap/allowlist.yaml
echo $?                                                 # 0  (allowlisted → gate passes)
```

**Expected**: exit `0`; the finding is **still present** in `report.html`/`report.json` (visible, not hidden — FR-010). A *different* un-allowlisted High still returns `1`.

## Scenario 4 — CI active scan + artifacts (SC-004, SC-005, SC-007)

- Open a PR touching `frontend/**` (or any `app`-filter path). The `dast` job runs the **full** scan (active BFF+mc-service, passive gateway) against the throwaway stack, uploads `dast-report`, and gates on un-allowlisted High.
- Open a docs-only PR → the `dast` job is **skipped** (SC-007); no scan runs.

## Scenario 5 — No-SaaS / no-secret-leak (SC-008, SC-009)

- Grep the committed tree + generated reports for the test password / tokens → none present (SC-008).
- Scan runs entirely against local/CI containers and Keycloak — no external SaaS endpoint contacted (SC-009).

## Final validation checklist (feature done)

- [ ] Scenario 1 green locally with the `agents` profile up (all three targets scanned; gateway not silently skipped).
- [ ] `check-dast-findings.mjs --selftest` and `zap-scan.mjs` guard reject `--mode full` outside a disposable target (FR-017).
- [ ] CI `dast` job brings up the agent stack, greens on a benign PR, reds on an injected High, and is skipped on docs-only.
- [ ] Report secret-leak check passes (no test password/token in `security/zap/reports/*`) before artifact upload (SC-008).
- [ ] `pnpm nx e2e mcm-app` still green (no app regression from infra changes).
- [ ] `check-prod-ci-port-collision.mjs` green (no new published ports).
- [ ] Runbook [docs/runbooks/dast-scanning.md](../../docs/runbooks/dast-scanning.md) written.
