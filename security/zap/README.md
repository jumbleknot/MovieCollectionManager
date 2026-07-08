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

## Triage / allowlist

A High finding fails the CI gate unless it is suppressed in [`allowlist.yaml`](./allowlist.yaml). An allowlist
entry removes the finding from the **gate only** — it stays visible in the HTML/JSON reports. Every entry
requires a non-empty `justification` and `addedBy`. See `allowlist.yaml` for the schema and a worked example.

<!-- Placeholder: finalized in T024/T026 with the full triage workflow. -->
