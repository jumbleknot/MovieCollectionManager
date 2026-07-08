# Runbook: DAST security scanning (OWASP ZAP) — feature 031

Config-as-code Dynamic Application Security Testing with **OSS OWASP ZAP** (no SaaS). One scan
definition, two modes: a non-destructive **baseline** developers run locally, and a destructive
**full** (active) scan the Forgejo CI `dast` job runs against the ephemeral throwaway stack, gating
merges on any un-allowlisted High finding.

Design/decisions: [specs/031-dast-zap-scanning/](../../specs/031-dast-zap-scanning/). Config tree:
[security/zap/](../../security/zap/) (README there covers reports + the triage/allowlist workflow).

## Targets & auth

| Target | Compose DNS | Auth | Active scan |
|---|---|---|---|
| BFF | `mcm-bff-service-nonsecure:3000` | session cookie (headless PKCE login → `mcm_*` cookies) | yes |
| mc-service | `mc-service:3001` | bearer JWT (Keycloak ROPC, client `mcm-bff-test`) | yes |
| agent gateway | `movie-assistant-gateway:8000` | bearer JWT (same ROPC token) | **no** — spider + passive only |

Keycloak authenticates the scan but is **not** a scan target. ZAP runs as a container attached to the
shared external `backend-network`, reaching every target by DNS — **no new published host ports** (keeps
`check-prod-ci-port-collision.mjs` green, FR-016).

Credentials come from env: the scripts read `DAST_TEST_USER` / `DAST_TEST_PASSWORD` /
`DAST_ROPC_CLIENT_ID` / `DAST_ROPC_CLIENT_SECRET`, each defaulting to its `E2E_*` equivalent when unset —
so the existing E2E secrets are reused with **no new secret material**. Nothing is ever logged or written
to a report (SC-008).

## Local baseline run

Prerequisites — the local stack must be up (add the agent stack for gateway coverage):

```bash
node scripts/gen-dev-secrets.mjs
pnpm nx up-auth infrastructure-as-code
pnpm nx up-mcm infrastructure-as-code            # add --profile agents (or pnpm nx up-agents-prod) for the gateway target
```

`frontend/mcm-app/.env.e2e.local` must supply `E2E_TEST_USER` / `E2E_TEST_PASSWORD` /
`E2E_ROPC_CLIENT_ID` / `E2E_ROPC_CLIENT_SECRET`.

**PowerShell** (load `.env.e2e.local` into the session, then run):

```powershell
Get-Content frontend/mcm-app/.env.e2e.local | Where-Object { $_ -and $_ -notmatch '^\s*#' } | ForEach-Object {
  $k, $v = $_ -split '=', 2; [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim())
}
pnpm nx dast infrastructure-as-code               # or: node scripts/zap-scan.mjs --target local --mode baseline
```

**Bash**:

```bash
set -a; . <(sed -e '/^\s*#/d' -e '/^\s*$/d' frontend/mcm-app/.env.e2e.local); set +a
pnpm nx dast infrastructure-as-code
```

Reports land in `security/zap/reports/`: `report.html` (triage), `report.json` (gate input),
`report-sarif.json` (SARIF). If a target is unreachable (e.g. the agent stack is down) the runner logs a
**WARNING and skips it** — it never silently reports a clean pass (C6). If the BFF session cannot be
established the run **fails fast** (FR-012), never a green public-only report.

## Active (destructive) scan — disposable environments ONLY

The active scan sends attack payloads and is destructive. The runner refuses `--mode full` unless
`DAST_ALLOW_ACTIVE=1` **and** `--target` is a disposable env (`ci`/`local`) — the D8 guard (FR-017):

```bash
DAST_ALLOW_ACTIVE=1 node scripts/zap-scan.mjs --target local --mode full
```

Never point active mode at shared or production data. The active scan hits BFF + mc-service only; the
agent gateway stays spider + passive (active fuzzing there triggers real LLM runs — slow, non-deterministic).

## CI behavior (`dast` job in `.forgejo/workflows/app-ci.yml`)

- **Runner** `kvm`; **path-gated** on the `changes.app` filter (which now includes `security/zap/**`,
  `scripts/zap-scan.mjs`, `scripts/check-dast-findings.mjs`). Docs-/Komodo-only PRs **skip** it (SC-007).
- Brings up `auth` + `mcm` (`--profile app --profile bff-nonsecure`) + the agent stack
  (`up-agents-prod`, so the gateway target exists — C1), runs `zap-scan.mjs --target ci --mode full`
  (`DAST_ALLOW_ACTIVE=1` set only here).
- **Secret-leak check** scans `security/zap/reports/*` for the test password / ROPC secret / any JWT and
  fails **before** artifact upload (SC-008).
- Always uploads the `dast-report` artifact (`upload-artifact@v3`), then **gates** with
  `check-dast-findings.mjs` — the job **fails on any un-allowlisted High** (Medium/Low are warnings).
- `always()` teardown of both stacks + `down-agents-prod` (never hold a host port against prod — feature 029).
- `trigger-cd` tolerates a **skipped** `dast` (path-gated out) but is blocked by a **failed** one.

## Triage a failing gate

See the [triage/allowlist workflow](../../security/zap/README.md#triage--allowlist-workflow): fix the app,
or add a fully-justified entry to `security/zap/allowlist.yaml` (suppresses the finding from the **gate
only** — it stays visible in the reports, FR-010). Verify the gate logic with
`node scripts/check-dast-findings.mjs --selftest`.

## Why network-attach, not published ports

Publishing a temporary host port per target would reintroduce the prod↔CI port-collision risk on the
shared homelab host (feature 029) and could not reach the gateway (no host port). Attaching ZAP to
`backend-network` reaches all targets by DNS and introduces zero new ports — satisfying
`check-prod-ci-port-collision.mjs` by construction (FR-016).
