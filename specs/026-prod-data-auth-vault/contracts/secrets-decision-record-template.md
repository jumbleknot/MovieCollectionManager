# Contract: Secrets-Management Decision Record (ADR) — Template

**Feature**: 026-prod-data-auth-vault | **Phase**: 1 | **Workstream B / US2 deliverable**

This is the required shape of the single authoritative decision record produced by Workstream B. The implementation task fills this in and commits it (suggested location: `docs/decisions/ADR-0001-prod-secrets-management.md` or the repo's existing ADR home). Acceptance = every field below is present, exactly one mechanism is named, and 100% of secret categories are mapped.

---

## Required fields

### 1. Decision
State exactly ONE sanctioned production-secrets mechanism:
- [ ] **B-opt-1** — Ratify **Komodo Variables** (masked, `${VAR:?}` fail-fast, injected at deploy) as the standard for the core stacks; Vault stays agent-layer-only. *(recommended default — see research.md Decision 7)*
- [ ] **B-opt-2** — Adopt **HashiCorp Vault** as the production secrets backbone for all core stacks. *(if chosen, 026 delivers only the migration plan — the rollout is a follow-up feature)*

### 2. Rationale
Document the trade-off across: central rotation, lease/TTL, audit, operational burden (unseal/backup/secret-zero), availability-on-deploy, and current reality (all 7 prod stacks already on Komodo; Vault deployed **dormant** from feature 025).

### 3. Secret-category coverage map (must be 100%)
| Secret category | Example variables | Governed by (chosen mechanism) |
|---|---|---|
| Identity-provider DB & bootstrap | `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD` | … |
| BFF client / cookie / subject-token | `KEYCLOAK_CLIENT_SECRET`, `COOKIE_SECRET`, `AGENT_CONFIG_ENC_KEY`, `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` | … |
| Agent gateway / agent DB | `AGENT_GATEWAY_CLIENT_SECRET`, `AGENT_DB_PASSWORD` | … |
| Control-tower (025) | `OPENSEARCH_*`, `LANGFUSE_*`, `UNLEASH_*` | … |
| **Datastore credentials (Workstream A)** | `MONGO_MC_APP_PASSWORD`, `MONGO_BFF_APP_PASSWORD`, `MONGO_*_ROOT_PASSWORD`, `MONGO_MC_KEYFILE` | … |

### 4. Agent-layer Vault reconciliation (FR-013 — no dual mechanism)
State the fate of the existing optional, env-gated `agents/movie-assistant/src/secrets.py` Vault reader:
- [ ] Kept as a **scoped optional reader** (per-run, fail-open to Komodo-injected env) — not a competing backbone.
- [ ] Unified into the chosen backbone.
- [ ] Retired.

### 5. Constitution compliance (FR-015)
Cite the Secrets Management principle leg satisfied (env-vars **or** dedicated manager — both permitted). State whether this decision is a **ratification** of the status quo or an **enhancement**.

### 6. Per-user BYO preservation (FR-014)
Confirm user-provided provider credentials remain **per-run, never centralized** into any shared secrets store.

### 7. Revisit trigger  *(required if B-opt-1)*
The concrete condition under which Vault adoption is reconsidered (e.g., "central rotation/audit becomes a compliance requirement" or "dynamic short-lived DB credentials are wanted").

### 8. Migration plan reference  *(required if B-opt-2)*
Link to the US3 migration plan (secret categories, sequence, rotation procedure, manager-unavailable behavior, injector secret-zero bootstrap). The full rollout is deferred to a follow-up feature; 026 does not execute it.
