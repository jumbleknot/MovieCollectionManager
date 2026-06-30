# PRD — Production Data-Tier Authentication & Vault-Backed Secrets

**Status:** Proposed / Deferred (not blocking feature 023 Milestone B)
**Created:** 2026-06-30
**Context:** feature 023 (homelab CI/CD) Milestone B — full-app prod stacks
**Related:** [docs/proposals/homelab-setup/Phase-15-Work-Order.md](../homelab-setup/Phase-15-Work-Order.md),
[Phase-15-Operator-Checklist.md](../homelab-setup/Phase-15-Operator-Checklist.md),
constitution §Secrets Management, features 018/021/022.

---

## 1. Context & motivation

Bringing the full app to production (Milestone B) surfaced two defense-in-depth questions about the
data tier and secret storage. Neither is an *exposure* gap today (nothing is host-/internet-reachable),
but both are single-layer where a second layer is warranted for production. This PRD captures the two
hardening workstreams as deliberate, deferred work so they aren't lost.

It does **not** block Milestone B: the app ships on the current posture (network-segmented, no published
ports) plus the just-landed network-scoping fix (below).

## 2. Current state (2026-06-30)

**Network segmentation — the present boundary.** No prod container publishes a host port. Inter-service
reachability is governed entirely by Docker networks:

- `mc-service-store-mongo` — **isolated on `mc-service-network`** (landed this session): only `mc-service`
  (+ rs-init) can reach it. The broad `backend-network` is no longer a DB peer.
- `mcm-bff-store-mongo` — on `mcm-bff-network`: only the BFF reaches it.
- `movie-assistant-store-postgres` (agent-db) — on `backend-network`; consumed only by the gateway.
- `web-api-mcp` — on `movie-assistant-mcp-network` only (no backend access; egress-to-TMDB only).

**Datastore authentication.**

| Store | Auth today | Notes |
|-------|-----------|-------|
| `mc-service-store-mongo` (movie data) | **none** | single-member replica set `rs0`, no credential |
| `mcm-bff-store-mongo` (per-user agent config, 018) | **none** | encrypted-at-rest *payloads* (AES-256-GCM), but the DB itself is unauthenticated |
| `movie-assistant-store-postgres` (agent state) | **password** (`AGENT_DB_PASSWORD`) | already authenticated |
| `keycloak-store-postgres` | **password** (`KC_DB_PASSWORD`) | already authenticated |

So the **two MongoDBs are the only unauthenticated stores**; both Postgres stores already require a
password. After the network-scoping fix, each Mongo is reachable by exactly one service — but a
compromise of *that one service* (or a misconfigured network attach) still yields credential-free DB
access. Authentication is the missing second layer.

**Secrets management.** Prod secrets are **Komodo Variables** (masked) interpolated into each stack's
`.env.prod` at deploy — satisfying the constitution (no clear-text in git, fail-fast `${VAR:?}`, injected
at deploy). **Vault** exists in the repo only as an *optional, env-gated* secret source for the **agent
layer** (`agent-gateway`'s `secrets.py` reads `AGENT_GATEWAY_CLIENT_SECRET` / `ANTHROPIC_API_KEY` from
Vault iff `VAULT_ADDR`+`VAULT_TOKEN` are set; falls back to env; off by default, `--profile observability`).
It is **not** the secrets backbone for Keycloak, the BFF, or the databases.

## 3. Problem statement

1. **Unauthenticated MongoDB** (movie data + BFF agent-config store) relies solely on network scope.
   A single compromised/misattached container on the DB's network reads/writes all data with no credential.
2. **No uniform prod secrets manager.** Komodo Variables are adequate but secrets live in Komodo's store
   (and rendered into on-host `.env.prod` files, chmod 600). There is no central rotation, audit, lease/TTL,
   or dynamic-credential capability. Vault is present but only optionally wired for the agent layer.

## 4. Goals / Non-goals

**Goals**
- G1 — Authenticate both production MongoDBs (SCRAM least-privilege user per consumer) without data loss.
- G2 — Make Vault the prod secrets backbone (or consciously decide Komodo Variables are sufficient and
  document that as the standard), covering Keycloak, BFF, agents, and DB credentials.
- G3 — Preserve the "no clear-text in git + fail-fast" guarantees and the per-user-BYO model (018).

**Non-goals**
- Changing the network-segmentation model (already landed; this PRD is the layer *on top*).
- mTLS between services / a service mesh (separate, larger effort).
- Re-encrypting at-rest payloads (the 018 AES-256-GCM agent-config encryption is unaffected).

## 5. Workstream A — MongoDB authentication

### A.1 Approach
- Enable SCRAM auth on each Mongo. **A replica set requires internal member auth even single-member**, so
  a **keyfile** (or x.509) is mandatory in addition to the SCRAM users: `--replSet rs0 --keyFile <path>`
  (+ `--auth` implied by keyFile on an RS).
- Provision least-privilege users: a `mc_service_app` user with `readWrite` on `mc_db` only (not root);
  same shape for the BFF mongo (`bff_app` on `bff_db`). Root user created at init, then unused.
- Connection strings move to `mongodb://<user>:${<PW>}@host:27017/<db>?replicaSet=rs0&authSource=admin&directConnection=true`.
- Store the keyfile + SCRAM passwords as secrets (Komodo Variable today, or Vault per Workstream B).

### A.2 Complexity & risks
- **Keyfile lifecycle**: generate (`openssl rand -base64 756`), mount read-only with `0400` + correct
  owner (mongod refuses a group/world-readable keyfile), keep it out of git.
- **Migration on a populated volume**: the prod Mongo volumes may already hold data once Milestone B is
  live. Enabling auth on an initialized RS is a careful procedure (start with keyfile but `--transitionToAuth`,
  create users, then enforce) — must be scripted and rehearsed on a copy first.
- **rs-init** must authenticate once auth is on (its `mongosh` calls need the admin credential).
- Consistency: apply to BOTH mongos (mc-service + BFF) so the pattern is uniform.

### A.3 Acceptance
- Each Mongo rejects an unauthenticated connection (`mongosh host:27017` → auth error).
- mc-service / BFF connect with a least-privilege app user; root is not used at runtime.
- No keyfile or password in git; the inline-secret + secret-scan gates stay green.
- Data preserved across the cutover (verified row/collection counts before/after).

## 6. Workstream B — Vault as the prod secrets backbone

### B.1 Approach (decision-first)
Two viable end-states; pick one as an explicit decision before building:
- **B-opt-1 — Ratify Komodo Variables as the standard.** Document that masked Komodo Variables + fail-fast
  `${VAR:?}` are the sanctioned prod-secrets mechanism; keep Vault scoped to the agent layer. Lowest effort;
  closes the "should we use Vault?" question by deciding *no* for the core stacks. Loses central
  rotation/lease/audit.
- **B-opt-2 — Vault-backed injection for all stacks.** Stand up Vault as a first-class prod service
  (unsealed, HA or auto-unseal), store every prod secret there, and inject at deploy. Injection options:
  Komodo → Vault lookup, a Vault Agent sidecar / `vault agent` template into `.env.prod`, or
  `envconsul`. Enables rotation, leases/TTL, dynamic DB creds (Vault's database secrets engine can issue
  short-lived Mongo/Postgres users — pairs naturally with Workstream A).

### B.2 Scope (if B-opt-2)
Keycloak (`KC_DB_PASSWORD`, bootstrap admin), BFF (client secrets, cookie/enc keys, subject-token secret),
agents (`AGENT_GATEWAY_CLIENT_SECRET`, `AGENT_DB_PASSWORD`), DB creds (Workstream A). Reconcile with the
existing optional agent-layer Vault path (`secrets.py`) so there's one mechanism, not two.

### B.3 Complexity & risks
- Vault operational burden: unseal/auto-unseal, backup, the "secret-zero" bootstrap (how the injector
  authenticates to Vault), availability (Vault down ⇒ deploy blocked unless cached).
- Avoid regressing the per-user-BYO model (018): user provider keys remain per-run, never centralized.
- The constitution already names "Komodo/Vault" as acceptable — so B-opt-1 is constitution-compliant;
  B-opt-2 is an enhancement, not a fix.

### B.4 Acceptance
- A single documented, sanctioned prod-secrets mechanism (whichever option).
- If B-opt-2: every core-stack secret resolves from Vault at deploy; rotation procedure documented;
  Vault-down behavior defined; agent-layer Vault path unified (no dual mechanism).

## 7. Sequencing & priority

1. **Workstream A (Mongo auth)** is the higher-value, more self-contained item — recommend first, after
   Milestone B is stable. Rehearse the populated-volume migration on a copy.
2. **Workstream B** is a *decision* before a build: ratify Komodo Variables (B-opt-1, cheap) or commit to
   Vault-everywhere (B-opt-2). If B-opt-2, Vault's database secrets engine can supersede A.2's static
   SCRAM passwords with dynamic creds — so decide B before over-investing in A's static-credential tooling.
3. Optional minor: scope `agent-db` (already authenticated) to a gateway-private network for symmetry.

## 8. Open questions
- Auto-unseal source if Vault is adopted (cloud KMS vs Transit vs manual) on a homelab.
- Do we want Vault dynamic DB credentials (short-lived Mongo/Postgres users) — i.e., couple A and B?
- Migration window tolerance for enabling Mongo auth on the live volumes.

## 9. Out of scope
Network model changes, service mesh / mTLS, at-rest payload encryption changes, non-prod (dev/CI keeps the
simpler unauthenticated-Mongo + gen-dev-secrets flow).
