# Phase 1 Data Model: DAST Security Scanning

These are configuration/report entities (no database). Fields describe the version-controlled config and the scan's runtime artifacts.

## Scan Definition

The config-as-code description of a scan. Realized as two ZAP Automation Framework plans that share context/auth blocks.

| Field | Type | Notes |
|---|---|---|
| `name` | string | `baseline` or `full`. |
| `mode` | enum | `baseline` (spider + passive, non-destructive) or `full` (active for BFF+mc-service, passive for gateway). |
| `targets` | ScanTarget[] | Ordered list of targets in scope. |
| `reportFormats` | string[] | Always `[traditional-html, traditional-json, sarif-json]`. |
| `reportDir` | path | Gitignored output dir (`security/zap/reports/`). |

**Validation**: `baseline` MUST NOT enable any active-scan rule. `full` MUST restrict the gateway target to spider+passive. Exactly the three in-scope targets; Keycloak MUST NOT appear.

## Scan Target

A running service exposed to the scanner.

| Field | Type | Notes |
|---|---|---|
| `key` | enum | `bff` \| `mc-service` \| `agent-gateway`. |
| `baseUrl` | url | Compose DNS: `http://mcm-bff-service-nonsecure:3000`, `http://mc-service:3001`, `http://movie-assistant-gateway:8000`. |
| `authStyle` | enum | `session-cookie` (bff) \| `bearer` (mc-service, agent-gateway). |
| `activeAllowed` | bool | `true` for bff + mc-service; `false` for agent-gateway. |

**Validation**: `agent-gateway.activeAllowed` MUST be `false`. `baseUrl` MUST resolve on the attached Compose network; MUST NOT be a shared/prod host (D8 guard).

## Scan Test User

The identity the scanner authenticates as. Not created by this feature — reused.

| Field | Type | Notes |
|---|---|---|
| `username` | string | `e2e-test-user` (CI realm) / `testuser` (local). Source: env, never committed. |
| `password` | secret | `${E2E_TEST_PASSWORD}` — from secret store / `.env.e2e.local`. |
| `role` | enum | `mc-user` (non-privileged; NOT admin). |
| `ropcClientId` | string | `mcm-bff-test`. |
| `ropcClientSecret` | secret | `${E2E_ROPC_CLIENT_SECRET}`. |

**Validation**: MUST be non-admin. Credentials MUST come from env; a literal in any committed file is a violation (FR-015).

## Finding

One reported security issue in a scan report.

| Field | Type | Notes |
|---|---|---|
| `pluginId` | string | ZAP rule id (stable key for allowlisting). |
| `name` | string | Human title. |
| `riskLevel` | enum | `High` \| `Medium` \| `Low` \| `Informational`. |
| `uri` | url | Affected request URL. |
| `method` | string | HTTP method. |
| `evidence` | string | Snippet (MUST NOT contain scan credentials/tokens). |

**Gate rule**: a `High` finding not matched by the allowlist ⇒ pipeline fails. `Medium`/`Low`/`Informational` ⇒ warning only.

## Finding Allowlist Entry

A triaged suppression. File: `security/zap/allowlist.yaml`.

| Field | Type | Notes |
|---|---|---|
| `pluginId` | string | Rule id to suppress. |
| `uriPattern` | regex | Scopes the suppression to matching URLs (avoid blanket suppression). |
| `justification` | string | Why it's a false positive / accepted risk (required). |
| `addedBy` | string | Who triaged it (accountability). |

**Validation**: every entry MUST have a non-empty `justification`. Suppression removes the finding from the **gate** only — it remains visible in HTML/JSON reports (FR-010). A missing/blank field is a gate error.

## Scan Report

The output of one scan run.

| Field | Type | Notes |
|---|---|---|
| `html` | file | `traditional-html` — human triage. |
| `json` | file | `traditional-json` — authoritative gate input + machine record. |
| `sarif` | file | `sarif-json` — portable interchange artifact. |
| `crawledUrls` | url[] | Used to assert authenticated coverage (SC-002). |

**Validation**: reports MUST include protected post-auth URLs (else auth silently failed → fail fast, FR-012). Reports MUST NOT contain secret material (SC-008).

## Relationships

```text
Scan Definition 1───* Scan Target
Scan Target      *───1 Scan Test User   (all targets authenticate as the same user)
Scan Definition  1───1 Scan Report       (per run)
Scan Report      1───* Finding
Finding          *───? Finding Allowlist Entry   (0..1 matching suppression)
```
