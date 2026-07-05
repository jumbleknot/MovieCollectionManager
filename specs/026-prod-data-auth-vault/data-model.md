# Data Model: Production Data-Tier Authentication & Secrets-Management Standard

**Feature**: 026-prod-data-auth-vault | **Date**: 2026-07-04 | **Phase**: 1

This is an infrastructure/security feature. The "entities" are **configuration and credential artifacts**, not application domain objects. No MongoDB document schema changes (the stored movie/collection/agent-config documents are untouched — auth is a transport/access-control layer, not a data-shape change).

---

## Entity: MongoDB deployment (per store)

| Attribute | `mc-service-store-mongo` | `mcm-bff-store-mongo` |
|---|---|---|
| Topology | single-member replica set `rs0` | standalone |
| Prod command (target) | `mongod --replSet rs0 --keyFile <path> --bind_ip_all` (+ `--transitionToAuth` during Phase 1) | `mongod --auth --bind_ip_all` (+ `--transitionToAuth` during Phase 1) |
| Member auth | keyfile (mandatory for RS) | n/a (no members) |
| Client auth | SCRAM-SHA-256 | SCRAM-SHA-256 |
| Data volume | `mc-service-store-mongo-data` (external, unchanged) | `mcm-bff-store-mongo-data` (external, unchanged) |
| Network | `mc-service-network` (unchanged) | `mcm-bff-network` (unchanged) |
| Steady-state healthcheck (target) | credential-less `db.adminCommand('ping').ok` | credential-less `db.adminCommand('ping').ok` (unchanged shape) |
| Published port | none (unchanged) | none (unchanged) |

**State transition (per store)** — the cutover lifecycle:

```
no-auth (today)
  → Phase 1: transitionToAuth  [accepts auth'd + anonymous; keyfile enforced on RS]
      → users created (root + app)
      → consumer switched to authenticated URL
  → Phase 2: enforced auth  [anonymous rejected]
  → (rollback at any step: revert command → redeploy; data untouched)
```

**Validation / invariants**:
- Data volume identity is preserved across all transitions (no recreate, no rename).
- Record/collection counts pre-cutover == post-cutover (SC-003).
- After Phase 2, an anonymous connection is rejected (SC-001).

---

## Entity: MongoDB identity (SCRAM user)

| Field | Values |
|---|---|
| `admin` root user | `mc_root` (movie), `bff_root` (bff) — role `root` on `admin`; **setup/administration only**, never in a running service's env on a populated volume |
| app user | `mc_service_app` (movie), `bff_app` (bff) — role `readWrite` on the store's DB only |
| database | movie → `mc_db`; bff → `bff_db` |
| `authSource` | `admin` (both) |

**Invariants**: exactly one app user per store, `readWrite`-scoped to its single DB; no app-runtime use of a root/administrative identity (SC-002); user set is uniform across both stores (consistency).

---

## Entity: Secret (new for this feature)

| Secret variable | Purpose | Runtime-injected into | Source (prod) | Source (scratch/rehearsal) |
|---|---|---|---|---|
| `MONGO_MC_APP_PASSWORD` | `mc_service_app` password (in `MC_DB_URL`) | mc-service | Komodo Variable → `.env.prod` | `gen-dev-secrets` (`<generate:complex-16>`) |
| `MONGO_MC_ROOT_PASSWORD` | `mc_root` password (setup + fresh-volume bootstrap) | not steady-state | Komodo Variable | `gen-dev-secrets` |
| `MONGO_BFF_APP_PASSWORD` | `bff_app` password (in `MONGO_URL`) | BFF | Komodo Variable → `.env.prod` | `gen-dev-secrets` |
| `MONGO_BFF_ROOT_PASSWORD` | `bff_root` password (setup + fresh-volume bootstrap) | not steady-state | Komodo Variable | `gen-dev-secrets` |
| `MONGO_MC_KEYFILE` | replica-set keyfile content (movie store only) | rendered to bind-mounted file | Komodo Variable → rendered `0400` host file | locally generated keyfile |

**Invariants** (gate-enforced):
- No secret value literal in git; every `*_PASSWORD` in compose is `${VAR:?…}`; passwords in URLs are `${VAR}` sentinels.
- Keyfile material is never committed and never a `-data` volume; the rendered file + any generated `.env` are gitignored.
- Dev local stacks (`compose.yaml`) remain unauthenticated — these secrets appear only in prod compose + the scratch/rehearsal env.

---

## Entity: Keyfile (movie store only)

| Attribute | Value |
|---|---|
| Content | `openssl rand -base64 756` (base64, single logical secret) |
| Mount | bind-mounted host file, read-only (`:ro`) |
| Permissions | mode `0400`, owner = image mongod uid (to be confirmed for `8.0.8-ubi9`) |
| Location | gitignored host path (prod: rendered from `MONGO_MC_KEYFILE`; scratch: generated) |

**Invariant**: `mongod` starts only if the keyfile is present with restrictive perms and correct owner (a negative test: a group/world-readable keyfile must cause startup failure).

---

## Entity: Secrets-management decision record (Workstream B / US2 deliverable)

An ADR-style document (the authoritative single record) with fields:

| Field | Content |
|---|---|
| Decision | exactly one sanctioned prod-secrets mechanism (Komodo Variables **or** Vault backbone) |
| Rationale | rotation / lease / audit / operational burden / availability-on-deploy trade-offs |
| Secret-category map | every prod secret category → the chosen mechanism (identity-provider DB/bootstrap, BFF client/cookie/subject-token, agent gateway/agent-DB, datastore creds from Workstream A) |
| Agent-layer reconciliation | fate of the existing optional `secrets.py` Vault reader (kept as scoped optional, unified, or retired) |
| Constitution note | which principle leg it satisfies; ratification vs enhancement |
| Revisit trigger | (if B-opt-1) the condition under which Vault adoption is reconsidered |
| Migration plan reference | (if B-opt-2) link to the US3 migration plan; full rollout deferred to a follow-up feature |

**Invariants**: exactly one mechanism named (no dual ambiguity — FR-013); 100% secret-category coverage (SC-006); constitution-compliant (FR-015).
