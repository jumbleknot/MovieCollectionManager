# Research: Production Data-Tier Authentication & Secrets-Management Standard

**Feature**: 026-prod-data-auth-vault | **Date**: 2026-07-04 | **Phase**: 0

This document resolves the technical unknowns before design. It is grounded in the current-state map of the two production MongoDB stores, the Komodo/secrets machinery, and the feature-025 Vault deployment.

---

## Current state (verified)

| Store | Komodo stack | Topology | Prod command (today) | Auth today | Conn-string env | Consumer code | Volume (external) | Network |
|---|---|---|---|---|---|---|---|---|
| `mc-service-store-mongo` (movie data) | `prod-mc-service` | single-member replica set `rs0` | `mongod --replSet rs0 --bind_ip_all` | **none** | `MC_DB_URL` = `mongodb://mc-service-store-mongo:27017/mc_db?replicaSet=rs0&directConnection=true` | Rust — `config.rs` reads `MC_DB_URL`, `adapters/mongodb/client.rs` `Client::with_uri_str` | `mc-service-store-mongo-data` | `mc-service-network` |
| `mcm-bff-store-mongo` (agent-config, 018) | `prod-mcm-bff` | **standalone** | `mongod --bind_ip_all` | **none** | `MONGO_URL` = `mongodb://mcm-bff-store-mongo:27017` (+ `MONGO_DB_NAME=bff_db`) | TS — `config/env.ts` reads `MONGO_URL`, `bff-server/mongo-client.ts` `new MongoClient` | `mcm-bff-store-mongo-data` | `mcm-bff-network` |

Both prod Mongos publish **no host port** (internal-only). Both consumers read the connection string from env — **no application code parses credentials**, so enabling auth is a connection-string + compose + secrets change only. No `--auth`, `--keyFile`, `authSource`, `MONGO_INITDB_ROOT_*`, or SCRAM scaffolding exists anywhere in the repo today.

Prod healthcheck divergence: `mc-service-store-mongo` runs a **self-initializing** healthcheck (`rs.status()...rs.initiate()`) unauthenticated; `mcm-bff-store-mongo` runs `db.adminCommand('ping').ok`.

---

## Decision 1 — Per-store authentication model (they are NOT symmetric)

**Decision**: Apply SCRAM to both, but a keyfile **only** to the replica-set store.

- `mc-service-store-mongo` (replica set): `mongod --replSet rs0 --keyFile <path> --bind_ip_all`. A replica set enforces **internal member authentication**; the keyfile is mandatory and `--keyFile` on a replica set **implies `--auth`** for clients. So SCRAM client auth + keyfile member auth both apply.
- `mcm-bff-store-mongo` (standalone): `mongod --auth --bind_ip_all`. A standalone has **no members to authenticate**, so **no keyfile is required** — `--auth` + a SCRAM user is sufficient.

**Rationale**: The source PRD assumed "a replica set requires internal member auth even single-member, so a keyfile is mandatory" and said "apply to BOTH." That is correct for the movie store but over-specified for the BFF store, which is standalone. Forcing a keyfile onto a standalone adds a secret and a permission-sensitive mounted file for zero security benefit. Keeping them divergent is simpler and still delivers the goal (both reject anonymous connections).

**Alternatives considered**: (a) Convert the BFF store to a single-member replica set for symmetry — rejected: gratuitous topology change, new failure modes, out of scope. (b) x.509 member auth instead of a keyfile for the movie store — rejected: requires a CA + per-member certs; heavier than a keyfile for a single-member homelab set (PRD lists keyfile as the primary option).

---

## Decision 2 — Least-privilege user/role model

**Decision**: Per store, create a root user at `admin` (used only for setup/administration, never at app runtime) and a least-privilege application user with `readWrite` scoped to that store's database only.

| Store | Admin user (setup-only) | App user (runtime) | Role | Scope | `authSource` |
|---|---|---|---|---|---|
| movie | `mc_root` | `mc_service_app` | `readWrite` | `mc_db` | `admin` |
| bff | `bff_root` | `bff_app` | `readWrite` | `bff_db` | `admin` |

**Rationale**: Satisfies FR-002 (least-privilege, no root at runtime). `readWrite` on the single app DB is exactly what each service needs (mc-service does multi-doc transactions on `mc_db`; the BFF does upserts on `bff_db`). Users live in `admin` with `authSource=admin` — the conventional MongoDB placement so the app URL points `authSource=admin`.

**Runtime healthcheck under auth**: `ping` and `hello` are runnable **without authentication** even when `--auth` is on. So the steady-state liveness probe becomes credential-less `mongosh --quiet --eval "db.adminCommand('ping').ok"` for **both** stores — no monitoring user needed, and the movie store's self-initializing `rs.status()`/`rs.initiate()` probe is retired (it would fail under auth and is unnecessary on an already-initialized set). Fresh-volume replica-set initialization becomes an explicit authenticated bootstrap step (Decision 3), not a healthcheck side effect.

**Alternatives considered**: A dedicated `clusterMonitor` user for the healthcheck — rejected: unnecessary once the probe is credential-less `ping`.

---

## Decision 3 — Populated-volume migration mechanism

**Decision**: A scripted, rehearsed **`--transitionToAuth` two-phase cutover** per store, run inside a scheduled ≤60-minute window (per clarification), rehearsed first against a **restored snapshot** of the prod volume in a scratch environment.

Procedure (per store), rehearsed on a snapshot copy before prod:

1. **Capture** pre-cutover record/collection counts (rollback baseline).
2. **Phase 1 — transition**: redeploy `mongod` with the auth flags **plus `--transitionToAuth`** (movie store also gains `--keyFile`). In this mode the server accepts **both** authenticated and anonymous connections, so it stays up while users are created — the keyfile immediately enforces member auth on the replica set without a chicken-and-egg on the first user.
3. **Create users**: connect and create the `admin` root user + the least-privilege app user for that store.
4. **Switch the consumer**: update the service's connection string to the authenticated form and redeploy the service (mc-service / BFF).
5. **Phase 2 — enforce**: redeploy `mongod` **without `--transitionToAuth`** (full `--auth`); anonymous connections are now rejected.
6. **Verify**: anonymous `mongosh` is rejected; the app reads/writes normally; post-cutover counts equal the baseline.
7. **Rollback path**: if any step fails, revert the compose to the pre-auth command and redeploy — data is untouched (auth flags do not mutate data); restore from snapshot only if a volume-level problem is detected.

**Rationale**: `--transitionToAuth` is MongoDB's supported zero-lockout path for enabling auth on a live, already-initialized deployment; it removes the localhost-exception timing fragility and keeps the replica set healthy throughout. The chosen extended (≤60 min) safety-first window gives room for unhurried count verification and the two redeploys per store. Rehearsing on a restored snapshot (clarification) means the exact script is proven against real data shape/volume before the production window.

**Alternatives considered**: (a) Plain stop-start with the **localhost exception** to create the first user — viable within the window but more fragile on a keyfile-enabled replica set (localhost exception + member auth interactions); kept as the documented fallback. (b) Dump/restore into a fresh auth-enabled volume — rejected: far higher risk and time on a populated volume, unnecessary when in-place transition works.

**Fresh-volume bootstrap (disaster recovery / new host)**: documented separately — start with keyfile + `--auth`, use `MONGODB_INITDB_ROOT_USERNAME/PASSWORD` (only honored on an empty volume) or the localhost exception to seed users, then `rs.initiate()` (movie store) as an authenticated one-shot init container mirroring the dev pattern. This is a documented procedure, not part of the production cutover.

---

## Decision 4 — Keyfile provisioning (movie store only) — **materialize from env at container start**

**Decision**: The replica-set keyfile is generated with `openssl rand -base64 756` and carried as a **single-value secret in the `MONGO_MC_KEYFILE` env var** (Komodo Variable in prod → `.env.prod`; minted by `gen-dev-secrets` for the scratch/rehearsal env). A small **entrypoint wrapper** materializes it at container start: write `$MONGO_MC_KEYFILE` to an in-container file (e.g. `/etc/mongo/keyfile`), `chmod 0400`, `chown` to the mongod uid, then `exec mongod "$@"`. It is **never** a host bind-mount, **never** a named `-data` volume, and **never** committed.

**Rationale — this reconciles a hard constraint discovered in analysis**: the production secrets model is **env-var-only** — feature 022 deliberately **removed file-secrets** (`secrets/*.txt`) so every prod secret arrives via `.env.prod` (chmod 600, Komodo-rendered). There is **no mechanism to place a secret *file* on the prod host**, so a host bind-mount has no delivery path and would reintroduce exactly the file-secret pattern 022 retired. But `mongod --keyFile` requires a *file*. The resolution is to keep the secret as an **env var** (022-compliant, Komodo-delivered) and materialize the file **inside the container** at start-up. `mongod` refuses a group/world-readable keyfile or one not owned by its runtime uid, so the entrypoint sets `0400` + correct owner before exec. This keeps the file off any data volume (also avoiding the resource-naming gate — Decision 6) and out of git.

**Env-exposure note**: yes, the keyfile value is in the container's environment (visible to `docker inspect` on the host). This is the **same exposure class as every other prod secret today** (all `.env.prod` values are in-container env), so it does not lower the bar. The keyfile authenticates *replica-set members to each other* (a single-member set here) — it is not a client credential; the SCRAM passwords (also env, same class) are what gate client access. Acceptable and consistent with the existing model.

**Open item (task, not assumption)**: confirm the mongod runtime uid for `mongodb/mongodb-community-server:8.0.8-ubi9` so the entrypoint `chown`s correctly; the ubi9 image runs mongod as a non-root uid.

**Alternatives considered**: (a) Host bind-mounted keyfile rendered by Komodo — **rejected** (chosen originally, now reversed): no host-file delivery mechanism exists post-022; reintroduces a retired file-secret pattern. (b) Docker Compose `secrets:` (file- or env-backed) — viable but 022 standardized on `.env.prod` env-only; a one-line entrypoint is more consistent than adding a `secrets:` subsystem. (c) An init container that writes the keyfile to a *shared volume* before mongod starts — rejected: needs a shared volume + ordering; the entrypoint wrapper is simpler and self-contained.

---

## Decision 5 — Connection-string contract & gate compliance

**Decision**: Move each consumer to an authenticated connection string with the password as a `${VAR}` interpolation embedded in the URL; introduce new secret variables; keep both CI secret gates green.

- movie: `MC_DB_URL=mongodb://mc_service_app:${MONGO_MC_APP_PASSWORD}@mc-service-store-mongo:27017/mc_db?replicaSet=rs0&authSource=admin&directConnection=true`
- bff: `MONGO_URL=mongodb://bff_app:${MONGO_BFF_APP_PASSWORD}@mcm-bff-store-mongo:27017/?authSource=admin` (db still `MONGO_DB_NAME=bff_db`)

New secrets: `MONGO_MC_APP_PASSWORD`, `MONGO_MC_ROOT_PASSWORD`, `MONGO_BFF_APP_PASSWORD`, `MONGO_BFF_ROOT_PASSWORD`, and `MONGO_MC_KEYFILE` (movie store keyfile content). Root passwords are setup/administration secrets (not injected into the steady-state `mongod` service env on a populated volume; held in Komodo for admin use + fresh-volume bootstrap).

**Gate compliance** (verified against `check-no-inline-secrets.mjs` + `secret-scan.mjs`):
- The password sits in the URL password position as a `${VAR}` **sentinel**, which the inline-secret gate's `://user:pw@host` check accepts. Never inline a literal.
- `MC_DB_URL` / `MONGO_URL` keys do not match the secret-key regex, but any `*_PASSWORD` key added to compose/env must be pure `${VAR:?…}` form.
- The keyfile file and any generated `.env` stay **gitignored** (add `*.mongo-keyfile` / the rendered file path to `.gitignore`) so `secret-scan.mjs` never sees key-shaped material in the tree.
- Dev-secret templates gain the new placeholders (`<generate:complex-16>` for passwords, a new keyfile kind) so `gen-dev-secrets.mjs` mints them for the rehearsal/scratch env — **but production local dev stays unauthenticated** (FR-009): the new auth flags live only in the prod compose files, not the plain `compose.yaml` dev stacks.

**Rationale**: Reuses the existing fail-fast `${VAR:?}` + Komodo-Variable + gitignore machinery exactly; no gate weakening, no allowlist changes for secrets.

---

## Decision 6 — Resource-naming gate

**Decision**: Introduce **no new named volumes or networks** for Workstream A. The keyfile is a bind-mounted host file, not a `*-data` volume, so `check-resource-naming.mjs` needs no changes.

**Rationale**: The naming gate's volume regex requires a `-data` suffix; a `-keyfile` volume would fail it. Avoiding a new volume entirely sidesteps the gate. No new network is needed (each store already sits on its own isolated network).

---

## Decision 7 — Workstream B: the secrets-management decision (decision-first)

**Decision framework** (the actual selection is the US2 deliverable — an ADR — not pre-empted here, but this feature carries a **recommended default** for that ADR to ratify or override):

| Dimension | B-opt-1: Ratify Komodo Variables | B-opt-2: Adopt Vault backbone |
|---|---|---|
| Constitution | Compliant ("environment variables" leg) | Compliant ("dedicated secret manager", named for agents) |
| Effort | ~0 (document current mechanism) | High (unseal/auto-unseal, backup, secret-zero, per-stack injection) |
| Central rotation / lease / audit | No | Yes |
| Dynamic DB credentials (couples with Workstream A) | No (static SCRAM) | Possible (Vault DB secrets engine → short-lived Mongo users) |
| Operational burden | Lowest (Komodo already in use) | Vault must be up for every deploy; unseal ritual; backups |
| Current reality | All 7 prod stacks already use it | Vault deployed **dormant** (025), wired only for one agent secret via `secrets.py` |

**Recommended default for the ADR**: **B-opt-1 — ratify Komodo Variables as the sanctioned prod-secrets standard for the core stacks**, keeping Vault scoped to the agent layer, and record a documented "revisit trigger" (adopt Vault when central rotation/audit or dynamic DB credentials become worth the operational burden). This aligns with the **Bounded** scope decision (the full Vault rollout is already deferred to a follow-up feature), keeps Workstream A on **static SCRAM** (Decision 2), and avoids standing up Vault as a deploy-time dependency for a homelab-single-host prod.

**Reconciliation of the existing agent-layer Vault path** (required by FR-013): the ADR states that `secrets.py`'s optional, env-gated Vault reader **remains as-is** (a per-run, fail-open enhancement for `AGENT_GATEWAY_CLIENT_SECRET`), and that this is **not** a competing "backbone" — it is a scoped, optional reader that falls back to the same Komodo-injected env. One sanctioned backbone (Komodo) + one optional scoped reader (agent Vault) = no dual-mechanism ambiguity.

**If the ADR instead selects B-opt-2**: this feature delivers only the **migration plan** (US3), not the rollout — enumerating secret categories, sequence, rotation, manager-unavailable behavior, and the injector "secret-zero" bootstrap — for a follow-up feature to execute. Workstream A still ships static SCRAM in 026 regardless.

**Rationale**: The constitution permits both; Vault is already present but dormant; the Bounded decision defers any rollout; and a single-host homelab prod gains little from Vault's operational weight today while paying its full availability cost. Recording the revisit trigger keeps the door open without over-investing now.

---

## Resolved unknowns summary

| Unknown | Resolution |
|---|---|
| Are both Mongos replica sets? | No — movie=RS (keyfile), bff=standalone (no keyfile). |
| Any app code change? | None — both read the URL from env; auth is config only. |
| How to enable auth without data loss? | `--transitionToAuth` two-phase cutover, rehearsed on a restored snapshot, ≤60-min window. |
| Healthcheck under auth? | Credential-less `ping`; retire the self-initializing `rs.status()` probe. |
| Keyfile delivery? | Env-var-only (`MONGO_MC_KEYFILE`, Komodo → `.env.prod`); an entrypoint wrapper materializes it in-container `0400` owned by mongod uid then execs mongod. No host file-secret (022-compliant), no bind-mount, no data volume. |
| Keep secret gates green? | Password as `${VAR}` URL sentinel; keyfile gitignored; new `*_PASSWORD` vars pure `${VAR:?}`; no naming-gate changes. |
| Workstream B direction? | Recommend ratify Komodo (B-opt-1); ADR is the US2 deliverable; agent-layer Vault reader kept as scoped optional; Vault backbone deferred. |
| Dynamic vs static DB creds? | Static SCRAM in 026 (Bounded); dynamic creds only if a later Vault rollout adopts them. |
