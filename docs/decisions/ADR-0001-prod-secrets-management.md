# ADR-0001 — Production Secrets-Management Standard

**Status**: Accepted
**Date**: 2026-07-04
**Feature**: 026-prod-data-auth-vault (Workstream B / US2)
**Deciders**: Steven Watson
**Supersedes / relates to**: feature 021 (externalized compose secrets), feature 022 (single-source `.env.prod`, file-secrets removed), feature 025 (dormant prod Vault), constitution §Data Protection → Secrets Management, [PRD-Data-Auth-and-Vault](../proposals/prod-hardening/PRD-Data-Auth-and-Vault.md), [PRD-Vault](../PRD-Vault.md).

---

## 1. Decision

**Selected: B-opt-1 — Ratify Komodo Variables as the sanctioned production secrets mechanism for all core stacks.**

- [x] **B-opt-1** — Masked **Komodo Variables** (`[[NAME]]`), interpolated into each stack's gitignored `.env.prod` at deploy behind fail-fast `${VAR:?}` compose references, are the standard prod-secrets mechanism.
- [ ] B-opt-2 — Adopt HashiCorp Vault as the production secrets backbone. *(Not selected. See §7 revisit trigger.)*

HashiCorp Vault remains deployed **dormant** (feature 025) and **agent-layer-scoped only** — it is **not** the core-stack backbone. There is exactly **one** sanctioned mechanism (Komodo Variables) plus one narrowly-scoped, optional, fail-open reader (agent layer), reconciled in §4.

## 2. Rationale

The current reality is decisive: **all seven production stacks already run on Komodo Variables**, and the alternative (Vault) is a tool we deployed dormant but never operationalized. This is therefore "ratify what runs" vs "wake up and operationalize a new deploy-time dependency" — not a greenfield choice.

| Dimension | Komodo Variables (chosen) | Vault (deferred) |
|---|---|---|
| Effort to standardize | ~zero (this ADR) | High: init/unseal, storage backup, policies, per-stack injection, migrate every secret |
| Rotation | Manual (edit Variable → redeploy) | Central, scriptable/automatable |
| Dynamic DB credentials | No — static SCRAM | Yes — DB secrets engine issues short-lived users (would supersede Workstream A static SCRAM) |
| Audit ("who read what") | Deploy-action log only | Fine-grained secret-access audit |
| Lease / TTL / revocation | No | Yes |
| Availability coupling | No *new* dependency (Komodo already gates deploy) | Vault must be **unsealed + up** for every deploy; down ⇒ deploy blocked |
| Operational burden | Already carried | New: unseal ritual on every restart, storage backup, secret-zero bootstrap |
| Fit: single-host homelab, single operator, internal-only | Excellent | Heavy — Vault's value peaks in multi-node/multi-team/compliance shops |
| Constitution | Compliant ("environment variables" leg) | Compliant ("dedicated secret manager" leg) |

The three conditions that would justify Vault — mandatory central rotation/audit, dynamic short-lived DB credentials, or many teams/consumers — are **not** pressing on a single-operator, single-host, internal-only (no published ports) homelab production. Meanwhile Vault's recurring cost is concrete: on a homelab, every host reboot brings Vault up **sealed**, silently blocking deploys until a manual unseal (or additional auto-unseal infrastructure against a cloud KMS/Transit). That is a bad trade until at least one justifier is real.

A **half-adopted** Vault (some secrets in Vault, some in Komodo) is explicitly rejected as worse than either pure option — it is exactly the dual-mechanism ambiguity §4 forbids.

## 3. Secret-category coverage map (100%)

Every production secret category is governed by **Komodo Variables** (masked, `[[NAME]]` → `.env.prod`, fail-fast `${VAR:?}`, gitignored, chmod 600). Non-secret operational values (hosts, IPs, bind addresses, image digests) are out of scope for this map.

| Secret category | Representative variables | Governed by |
|---|---|---|
| Identity-provider DB & bootstrap | `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD` | Komodo Variables |
| BFF client / cookie / config-encryption / subject-token | `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `COOKIE_SECRET`, `AGENT_CONFIG_ENC_KEY`, `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` | Komodo Variables |
| Agent gateway / agent DB | `AGENT_GATEWAY_CLIENT_SECRET`, `AGENT_DB_PASSWORD` | Komodo Variables |
| Control-tower (feature 025) | `OPENSEARCH_PASSWORD`, `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, `OPENSEARCH_AUDIT_WRITER_PASSWORD`, `LANGFUSE_*` (salt, encryption key, nextauth, pg/clickhouse/redis/minio, init keys), `UNLEASH_*` | Komodo Variables |
| **Datastore credentials (Workstream A, feature 026)** | `MONGO_MC_APP_PASSWORD`, `MONGO_MC_ROOT_PASSWORD`, `MONGO_BFF_APP_PASSWORD`, `MONGO_BFF_ROOT_PASSWORD`, `MONGO_MC_KEYFILE` | Komodo Variables |

The Mongo replica-set keyfile (`MONGO_MC_KEYFILE`) is carried as an ordinary Komodo Variable / env value and materialized in-container by an entrypoint at start-up — consistent with the env-only, no-host-file-secret model established by feature 022 (see the 026 plan/research).

## 4. Agent-layer Vault reconciliation (no dual mechanism)

- [x] **Kept as a scoped, optional, fail-open reader** — not a competing backbone.

`agents/movie-assistant/src/secrets.py` reads a single secret (`AGENT_GATEWAY_CLIENT_SECRET`, optionally `AGENT_CONFIG_ENC_KEY`) from Vault **iff** `VAULT_ADDR` + `VAULT_TOKEN` are set, and otherwise **falls back to the same Komodo-injected environment**. It is env-gated, per-run, never crashes on Vault error, and never logs a secret value. Because it degrades to the Komodo-injected env, it is **not** a second source of truth — Komodo remains authoritative. In production today `VAULT_ADDR`/`VAULT_TOKEN` are unset, so this reader is inert and every agent secret resolves from Komodo.

**Rule going forward**: there is one sanctioned backbone (Komodo Variables). The agent Vault reader may remain as an optional enhancement but must always fail open to the Komodo-injected env; no core stack may take Vault as its primary or sole secret source while this ADR stands.

## 5. Constitution compliance

Satisfies the **"environment variables"** leg of the constitution's Secrets Management principle (§Data Protection): "Use environment variables **or** a dedicated secret management tool (e.g., Vault, AWS Secrets Manager)." Secrets are never in source, config files, or version control — they live in Komodo's masked store and are injected at deploy into a gitignored `.env.prod`. This decision is a **ratification of the existing, compliant status quo**, not an enhancement; adopting Vault (B-opt-2) would be the enhancement.

Rotation obligation (constitution: "rotated on a defined schedule and immediately upon suspected compromise") is met procedurally: rotate by editing the Komodo Variable and redeploying the affected stack; the datastore-credential rotation steps are documented in the feature-026 data-tier auth runbook.

## 6. Per-user bring-your-own-credentials preservation

User-provided provider credentials (TMDB key, model-provider API keys, Ollama URL) remain **per-run, BFF-encrypted (AES-256-GCM, feature 018), never centralized** into Komodo or Vault. This ADR governs **operator/shared infrastructure secrets only**. A request with no per-user credential fails closed with a configuration error — there is no shared fallback. (Consistent with PRD-Vault §"SHALL NOT store".)

## 7. Revisit trigger

Reconsider adopting Vault as the core-stack backbone (a clean follow-up feature — Vault is already deployed dormant; the work would be init/unseal + auto-unseal decision + stack-by-stack migration, per the deferred 026 US3 migration plan) when **any** of:

1. **Dynamic short-lived database credentials** are wanted (Vault's DB secrets engine issuing per-connection Mongo/Postgres users) — this would supersede Workstream A's static SCRAM and is the single strongest reason.
2. **Automated rotation** or **fine-grained secret-access audit** ("who read which secret when") becomes a security or compliance requirement.
3. The production footprint grows to **multiple hosts or multiple operators**, where Komodo's per-host `.env.prod` rendering and coarse audit stop scaling.

## 8. Migration plan reference

Not applicable — B-opt-1 selected. **Feature 026 US3 is not executed** (no migration plan artifact is produced). If the §7 trigger later fires, the migration plan becomes the first deliverable of the follow-up Vault-adoption feature.

## 9. Consequences

- **Positive**: zero new operational burden; no new deploy-time dependency; single, unambiguous, constitution-compliant standard; Workstream A ships static SCRAM without waiting on Vault; the door to Vault stays open (dormant deployment + documented trigger) without over-investing now.
- **Negative / accepted**: no central rotation, lease/TTL, dynamic DB credentials, or fine-grained secret-access audit until/unless the §7 trigger fires; rotation stays manual; Komodo host/DB remains the trust anchor for prod secrets.
