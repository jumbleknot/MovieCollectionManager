# DAST Security Scanning (OWASP ZAP) — feature 031

Config-as-code Dynamic Application Security Testing with **OSS OWASP ZAP** (no SaaS). Two modes share one
scan definition:

- **baseline** — non-destructive (spider + passive), run locally by developers. Default mode.
- **full** — destructive active scan (attack payloads) against BFF + mc-service, passive-only against the
  agent gateway. Run by Forgejo CI against the ephemeral throwaway stack; gates merges on any un-allowlisted
  High-risk finding.

Three targets are scanned authenticated as the existing `e2e-test-user` (mc-user, non-admin):

| Target | Compose DNS | Auth style | Active allowed |
|---|---|---|---|
| BFF | `mcm-bff-service-nonsecure:3000` | session cookie (`mcm_*`) | yes |
| mc-service | `mc-service:3001` | bearer JWT (ROPC) | yes |
| agent gateway | `movie-assistant-gateway:8000` | bearer JWT (ROPC) | **no** (passive only) |

Keycloak is used for auth but is **out of scope** as a scan target.

ZAP runs as a container attached to the Compose networks (reaches targets by DNS); **no new published host
ports** are introduced (keeps `check-prod-ci-port-collision.mjs` green).

## How to run

> Full procedure (PowerShell + Bash, CI behavior, triage) → [docs/runbooks/dast-scanning.md](../../docs/runbooks/dast-scanning.md).

Prerequisites: Docker running; local `auth` + `mcm` stacks up (add `--profile agents` for the gateway target):

```bash
node scripts/gen-dev-secrets.mjs
pnpm nx up-auth infrastructure-as-code
pnpm nx up-mcm infrastructure-as-code            # add --profile agents for gateway coverage
```

Local baseline:

```bash
pnpm nx dast infrastructure-as-code              # or: node scripts/zap-scan.mjs --target local --mode baseline
```

Reports land in `security/zap/reports/` (gitignored): `report.html`, `report.json`, `report.sarif`.

## Reports

Each run writes three formats to `security/zap/reports/` (gitignored):

| File | Template | Purpose |
|---|---|---|
| `report.html` | `traditional-html` | human triage |
| `report.json` | `traditional-json` | **gate input** (`check-dast-findings.mjs` reads this) + machine record |
| `report-sarif.json` | `sarif-json` | portable SARIF interchange (distinct base name so it never overwrites `report.json`) |

## Triage / allowlist workflow

A **High**-risk finding fails the CI gate. Medium/Low/Informational never fail (warnings only). To resolve
a High you either **fix it** or, if it is a false positive / accepted risk, **triage it** into
[`allowlist.yaml`](./allowlist.yaml):

1. Open `report.html` from the failed `dast` job's `dast-report` artifact and read the finding.
2. If it is a real vulnerability → fix the app; re-run the scan.
3. If it is a false positive or a consciously-accepted risk → add an entry to `allowlist.yaml` with all
   four fields (a blank `justification` or `addedBy` is a **gate error**):

   ```yaml
   - pluginId: "10038"                                  # ZAP rule id from the report
     uriPattern: "http://mc-service:3001/api/v1/.*"     # scope it — avoid a blanket ".*"
     justification: "CSP not applicable to this JSON API response; no HTML rendered."
     addedBy: "steve"
   ```

4. Commit the allowlist change (it is version-controlled and code-reviewed). The gate now passes for that
   specific finding while it **stays visible** in `report.html`/`report.json` (FR-010) — suppression is
   gate-only, never a report edit. An unrelated new High still fails.

Verify the gate logic anytime with `node scripts/check-dast-findings.mjs --selftest`.
