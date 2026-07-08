# Contract: CI `dast` Job Integration

Defines how the DAST scan plugs into `.forgejo/workflows/app-ci.yml` (Forgejo Actions, not GitHub).

## Job identity

- **Job id**: `dast` (posts status `app-ci/dast` → covered by the existing `app-ci*` required-check glob on protected `main`).
- **Runner**: `runs-on: kvm` (needs the rootless Docker socket to launch the ZAP container + Compose stacks).
- **Dependencies**: `needs: [changes]`.

## Trigger / path-gate

- **Gate**: `if: ${{ needs.changes.outputs.app == 'true' }}` — reuses the existing `changes` job's `app` filter (already covers `frontend/**`, `backend/**`, `agents/**`, `mcp-servers/**`, `infrastructure-as-code/docker/**`, `.forgejo/workflows/app-ci.yml`).
- **New paths to add to the `app` filter**: `security/zap/**` and `scripts/zap-scan.mjs` / `scripts/check-dast-findings.mjs` so scan-config changes re-run the scan. (Docs-only / Komodo-only changes still skip — FR-011, SC-007.)

## Inputs (secrets & env)

Reuses the exact wiring `app-e2e` already uses — no new secrets:

- `E2E_TEST_PASSWORD` (job env), `E2E_ROPC_CLIENT_SECRET` (minted per-run), realm client secrets consumed by `compose.ci.yaml` import.
- `gen-dev-secrets.mjs` → `stacks/auth.env` + `stacks/mcm.env`; `gen-ci-env.mjs` → BFF `.env.docker`.
- `DAST_ALLOW_ACTIVE=1` set only in this job to permit `--mode full` (D8 safety guard).
- **Env-var mapping (no new secrets)**: the scan scripts consume `DAST_TEST_USER` / `DAST_TEST_PASSWORD` / `DAST_ROPC_CLIENT_ID` / `DAST_ROPC_CLIENT_SECRET`; `zap-scan.mjs` populates each from its `E2E_*` equivalent when the `DAST_*` var is unset. The job therefore sets nothing new — it inherits the existing `E2E_*` values.

## Steps (contract, not final YAML)

1. Checkout; install Docker CLI in the job container; verify `docker info`.
2. `gen-dev-secrets` + `gen-ci-env` (same as app-e2e).
3. Bring up stacks: `auth` (`auth.compose.yaml` + `keycloak/compose.ci.yaml`) then `mcm` (`--profile app --profile bff-nonsecure`), each `up -d --wait`, **then the agent stack `pnpm nx up-agents-prod infrastructure-as-code`** so the `agent-gateway` scan target actually exists (without it the gateway target would be unreachable and silently skipped).
4. Run `node scripts/zap-scan.mjs --target ci --mode full` — mints/loads auth, launches ZAP attached to the Compose network, writes reports to `security/zap/reports/`.
5. **Secret-leak check**: scan `security/zap/reports/*` for the test password / minted tokens; fail the job if any appears (SC-008) — runs before upload so a leaking report is never published.
6. **Always** upload `security/zap/reports/**` via `actions/upload-artifact@v3` (name `dast-report`, `if-no-files-found: ignore`).
7. Gate: `node scripts/check-dast-findings.mjs --report security/zap/reports/report.json --allowlist security/zap/allowlist.yaml` — non-zero exit fails the job.
8. `if: always()` teardown: `down -v --remove-orphans` for both `auth` + `mcm` stacks **and `pnpm nx down-agents-prod infrastructure-as-code`** — matches the existing teardown to avoid holding ports (feature 029).

## Outputs

- **Artifact** `dast-report` (HTML/JSON/SARIF) — available on every run that reaches step 5 (pass or fail).
- **Status**: job **fails** iff step 6 finds an un-allowlisted High (FR-009); Medium/Low never fail (warnings in log + report).

## CD interaction

- Add `dast` to `trigger-cd`'s `needs:`; apply the same tolerance rule as app-e2e: a **skipped** `dast` (path-gated out) MUST NOT block CD; a **failed** `dast` MUST block it.

## Guardrails interaction

- The two new scripts each expose `--selftest`; add a guardrails step (or fold into the existing `naming`/gates job) running `node scripts/check-dast-findings.mjs --selftest` so the gate logic itself is verified on every push — matching the repo's `--selftest`-then-scan convention. (`zap-scan.mjs` is not a tree gate, so it needs no guardrails entry.)
- No new published host ports are introduced (ZAP attaches to the Compose network) → `check-prod-ci-port-collision.mjs` stays green (FR-016).
