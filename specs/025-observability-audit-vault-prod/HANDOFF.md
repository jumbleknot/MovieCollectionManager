# HANDOFF — Feature 025: Production Observability, Audit & Vault Stacks

**Status**: SDD artifacts COMPLETE through `/speckit-analyze` (specify → clarify → plan → tasks → analyze, all done + reconciled). **Nothing implemented yet.** Next action in a fresh session: `/speckit-implement` (or work tasks.md T001→T032 manually).

**Branch**: `025-observability-audit-vault-prod` (numbered 025 — 024 was taken by the merged Vault-decision PR).

## Read these first (in order)

1. [spec.md](./spec.md) — 3 stories, FR-001..018, SC-001..010, Clarifications (Session 2026-07-03).
2. [plan.md](./plan.md) — approach, Constitution Check (PASS), file map, Complexity Tracking.
3. [research.md](./research.md) — 10 decisions (R1–R10). **R10 = operator-UI tailnet bind** (added in analyze).
4. [tasks.md](./tasks.md) — **32 tasks, T001–T032**, MVP = US1 (T001–T012).
5. [data-model.md](./data-model.md) + [contracts/](./contracts/) — service/volume/network/Variable inventory + consumer-env, komodo-variables, health/audit contracts.
6. Source PRD (final, Vault-decided): `docs/proposals/prod-hardening/PRD-024-Observability-Audit-Vault-Prod.md` (the decision commit is on the merged `024-prd-vault-decision` history).

## What this feature IS

Promote the already-built, env-gated Control Tower services to prod as **3 Komodo ResourceSync stacks** — `prod-audit` (OpenSearch, P1/MVP), `prod-observability` (LangFuse + otel-lgtm + OPA + Unleash, P2), `prod-vault` (dormant, P3) — then wire `prod-mcm-bff` + `prod-movie-assistant` to consume them via **env vars only**. Upstream images ⇒ **no CI/build/digest**, deploy from committed `compose.prod.yaml` + Komodo Variables, exactly like `prod-auth`/Keycloak.

## Load-bearing decisions (do NOT re-derive)

- **Zero app code changes.** All integrations are env-gated; unset ⇒ no-op. OPA already fails-closed on unreachable (`agents/movie-assistant/src/tools/opa.py` L59-61). If implementation seems to need a code change, the scope guard (FR-016/018) is being violated — stop.
- **Fail-closed policy** on enabled-but-unreachable (clarified) — already true in code.
- **Always-on + memory caps** (clarified). OpenSearch `-Xms1g -Xmx1g`; cap ClickHouse (R5). Opt-in only if the T013 capacity check fails.
- **Audit user via one-shot init service** (clarified) — `agent-audit-init`. ⚠️ **image MUST have bash+curl** (`init-audit-user.sh` is `#!/usr/bin/env bash`; `curlimages/curl` lacks bash — see T005).
- **Vault = standalone `prod-vault` stack**, `after=["prod-auth"]`, deployed **uninitialized+sealed** (raft, `vault-store-data`), health endpoint override `?uninitcode=200&sealedcode=200&standbycode=200`. **Do NOT `vault operator init`.** Not `-dev` mode.
- **Networking**: prod-audit on a **dedicated `agent-audit-network`** (FR-001 isolation — only gateway+BFF join); observability on shared `backend-network`.
- **Operator UIs (R10)**: ONLY `langfuse-web` (`${TS_ADMIN_IP}:3030`) + Grafana (`${TS_ADMIN_IP}:3002`) publish, tailnet-only (Keycloak-admin pattern). `NEXTAUTH_URL=http://${TAILNET_HOST}:3030`. **These are the only 2 published ports in the whole feature.** `TS_ADMIN_IP`/`TAILNET_HOST` already exist as Komodo Variables (no new seed).
- **Secrets**: all `${VAR:?}` fail-fast; real values = masked Komodo Variables (`[[NAME]]`) → gitignored `.env.prod`. **15 new Variables** (13 observability + 2 audit); Vault dormant needs none. Consumer app-stack refs are **optional** (`${VAR}`, never `:?` — would break SC-008).

## Two guardrails-gate edits required BEFORE committing new compose (T001)

`scripts/check-resource-naming.mjs`:
- add `'agent-audit-network'` to `APPROVED_NETWORKS`;
- extend `VOLUME_RE` prefix alternation to include `vault` (admits `vault-store-data`; `agent-audit-opensearch-data` already matches via `agent`).

Then baseline-green: `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs`; `node scripts/check-no-inline-secrets.mjs`; `node scripts/check-resource-naming.mjs`.

## Files to author / edit (from plan.md)

- NEW: `infrastructure-as-code/docker/opensearch/compose.prod.yaml` (+ reuse `init-audit-user.sh`)
- NEW: `infrastructure-as-code/docker/observability/compose.prod.yaml`
- NEW: `infrastructure-as-code/docker/vault/compose.prod.yaml` + `vault/config/vault.hcl`
- EDIT: `infrastructure-as-code/docker/bff/compose.prod.yaml`, `agents/compose.prod.yaml` (consumer env + join `agent-audit-network`)
- EDIT: `infrastructure-as-code/komodo/stacks.toml` (add prod-audit, prod-observability, prod-vault blocks; extend prod-mcm-bff + prod-movie-assistant `environment`)
- EDIT: `scripts/check-resource-naming.mjs` (T001)

## Deploy/verify reality

- Deploy = merge to `main` → Komodo ResourceSync webhook. This needs the prod host + Komodo (homelab). CI monitor access + how to watch: see memory `reference_mcm_ci_monitor_access.md`.
- Host prereqs (one-time): `docker volume create …` (8 volumes) + `docker network create agent-audit-network` — see [quickstart.md](./quickstart.md).
- Acceptance oracles = the existing env-gated integration tests (`agents/movie-assistant/tests/integration/test_{audit_opensearch,observability_sc008,opa_authz,unleash_flags}.py`) run against the deployed stacks + the quickstart SC checklist.

## Open LOW items (deferred, optional)

- G1: no explicit prod task exercises the OPA unreachable→deny path (unit-tested already).
- A1: `prod-observability` `after` is a soft choice (`["prod-mcm-bff"]` chosen; no hard dep).
