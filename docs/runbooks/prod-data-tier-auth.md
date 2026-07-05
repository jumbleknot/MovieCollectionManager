# Runbook — Production Data-Tier Authentication (feature 026, Workstream A)

Enable SCRAM authentication on the two production MongoDB stores **without data loss**. Movie store
(`mc-service-store-mongo`) is a single-member replica set → keyfile + SCRAM. BFF store
(`mcm-bff-store-mongo`) is standalone → SCRAM only, **no keyfile**.

**Window**: scheduled, ≤ 60 minutes per store, safety-first stop-start (brief service unavailability is
acceptable — feature 026 clarification; zero-downtime rolling is NOT required). **Rehearse the whole
procedure on a restored volume snapshot in a scratch environment BEFORE touching production.**

Acceptance oracles: [../../specs/026-prod-data-auth-vault/quickstart.md](../../specs/026-prod-data-auth-vault/quickstart.md)
(Scenarios 1–5). Contract: [../../specs/026-prod-data-auth-vault/contracts/mongo-auth-contract.md](../../specs/026-prod-data-auth-vault/contracts/mongo-auth-contract.md).

---

## 0. Prerequisites (one-time)

1. **Seed the Komodo Variables** (masked) for both stores:
   - `MONGO_MC_APP_PASSWORD`, `MONGO_MC_ROOT_PASSWORD` (movie)
   - `MONGO_BFF_APP_PASSWORD`, `MONGO_BFF_ROOT_PASSWORD` (bff)
   - `MONGO_MC_KEYFILE` — the replica-set keyfile content, single line:
     ```bash
     openssl rand -base64 756 | tr -d '\n'
     ```
     Paste that value into the Komodo Variable. (Dev/scratch mints it via `gen-dev-secrets.mjs`.)
   **Generate the values on the prod host:**
   ```bash
   openssl rand -hex 24          # MONGO_MC_APP_PASSWORD   (hex = fully URL-safe)
   openssl rand -hex 24          # MONGO_MC_ROOT_PASSWORD
   openssl rand -hex 24          # MONGO_BFF_APP_PASSWORD
   openssl rand -hex 24          # MONGO_BFF_ROOT_PASSWORD
   openssl rand -base64 756 | tr -d '\n'   # MONGO_MC_KEYFILE (replica-set keyfile, one line)
   ```
   Add each as a **masked Komodo Variable** (Komodo UI → Variables), names matching stacks.toml. Only
   `MONGO_MC_APP_PASSWORD`, `MONGO_MC_KEYFILE` (prod-mc-service) and `MONGO_BFF_APP_PASSWORD`
   (prod-mcm-bff) are wired into compose; the two `*_ROOT_PASSWORD` values are setup-only (used to create
   users during the cutover) — store them in Komodo too for future admin use.
2. **mongod runtime uid — confirmed `uid=998(mongod)`** (2026-07-05, image `8.0.8-ubi9`; non-root). The
   entrypoint writes `/tmp/mongo-keyfile` as 998 and execs mongod as 998, so keyfile ownership matches by
   construction — **no chown needed**. (Re-confirm on an image bump: `docker run --rm --entrypoint id <image>`.)
3. **Back up** each prod volume before the window (rollback insurance — auth flags never mutate data, but
   a verified backup makes rollback guaranteed):
   ```bash
   docker run --rm -v mc-service-store-mongo-data:/v -v "$PWD":/b alpine tar czf /b/mc-mongo-backup.tgz -C /v .
   docker run --rm -v mcm-bff-store-mongo-data:/v   -v "$PWD":/b alpine tar czf /b/bff-mongo-backup.tgz -C /v .
   ```

> **Deploy model — read this first.** Production deploys via **Komodo ResourceSync on `main`**, not manual
> `docker` commands. Merging this feature branch is what puts the auth-enabled compose live. Therefore:
> **(1)** seed the Komodo Variables (step 1) BEFORE merging — the compose uses fail-fast `${VAR:?}`, so a
> missing secret aborts the deploy; **(2)** the recommended low-risk sequence is **§1.5 (pre-create the
> users while still unauthenticated) → merge → §4 verify**, which avoids any unhealthy window. The
> localhost-exception path in §2/§3 is the fallback if you flip auth on before creating users.

> **On the scratch-env rehearsal**: the spec's gold-standard is to restore the volume backups into a
> throwaway stack and run the cutover there first. For this single-host homelab, a **verified backup
> (step 3) + the reversible pre-create sequence (§1.5)** delivers the same "no data loss" guarantee with
> far less setup — recommended. Do the full scratch rehearsal only if you want to dry-run the exact
> commands before the window.

---

## 1. Baseline (per store, before the window)

Capture rollback-reference counts while the store is still unauthenticated:

```bash
# movie store
docker exec mc-service-store-mongo mongosh "mongodb://localhost:27017/mc_db?directConnection=true" \
  --quiet --eval 'db.getCollectionNames().forEach(c=>print(c, db[c].countDocuments()))'
# bff store
docker exec mcm-bff-store-mongo mongosh "mongodb://localhost:27017/bff_db" \
  --quiet --eval 'db.getCollectionNames().forEach(c=>print(c, db[c].countDocuments()))'
```

Record the output.

---

## 1.5 Recommended: pre-create users while still unauthenticated (minimal downtime)

`createUser` works on an **unauthenticated** mongod and the users persist on the data volume. Create them
**now** — before enabling auth. When the merge flips `--auth`/`--keyFile` on, the services authenticate
immediately with users that already exist: no localhost-exception timing, no unhealthy window.

First export the passwords you seeded in Komodo (so they never appear in a mongosh script or the container
arg list — `docker exec -e VAR` forwards them into the container env, and the quoted heredoc reads
`process.env`):

```bash
export MONGO_MC_ROOT_PASSWORD=... MONGO_MC_APP_PASSWORD=... \
       MONGO_BFF_ROOT_PASSWORD=... MONGO_BFF_APP_PASSWORD=...

# movie store (still unauthenticated)
docker exec -e MONGO_MC_ROOT_PASSWORD -e MONGO_MC_APP_PASSWORD -i mc-service-store-mongo mongosh --quiet <<'JS'
const a = db.getSiblingDB('admin');
a.createUser({ user:'mc_root', pwd:process.env.MONGO_MC_ROOT_PASSWORD, roles:['root'] });
a.createUser({ user:'mc_service_app', pwd:process.env.MONGO_MC_APP_PASSWORD, roles:[{role:'readWrite',db:'mc_db'}] });
print('mc users created');
JS

# bff store (still unauthenticated)
docker exec -e MONGO_BFF_ROOT_PASSWORD -e MONGO_BFF_APP_PASSWORD -i mcm-bff-store-mongo mongosh --quiet <<'JS'
const a = db.getSiblingDB('admin');
a.createUser({ user:'bff_root', pwd:process.env.MONGO_BFF_ROOT_PASSWORD, roles:['root'] });
a.createUser({ user:'bff_app', pwd:process.env.MONGO_BFF_APP_PASSWORD, roles:[{role:'readWrite',db:'bff_db'}] });
print('bff users created');
JS
```

Then **merge the feature branch to `main`** → Komodo ResourceSync redeploys `prod-mc-service` +
`prod-mcm-bff` with the auth-enabled compose. Because the users already exist and the app URLs carry the
matching `${MONGO_*_APP_PASSWORD}`, the services reconnect immediately. Skip to §4 (verify).

> If a service still can't connect after the redeploy, the password in the Komodo Variable does not match
> the one you created here — recreate the user (auth'd as `*_root`) or fix the Variable and redeploy.

The §2/§3 localhost-exception procedure below is the **fallback** (used if auth got enabled before users
existed); with §1.5 done you do not need it.

---

## 2. Movie store cutover — `mc-service-store-mongo` (replica set + keyfile)

1. **Redeploy `prod-mc-service`** (Komodo ResourceSync / redeploy the stack). The committed
   `compose.prod.yaml` now starts mongod via `mongo-entrypoint.sh` (materializes the keyfile to
   `/tmp/mongo-keyfile`, `0400`) with `--keyFile` → member auth + implied client `--auth`. `mc-service`
   itself will report **unhealthy** until its app user exists (expected — brief window).
2. **Create the users** via the localhost exception (no users exist yet, so this is permitted):
   ```bash
   docker exec -i mc-service-store-mongo mongosh --quiet <<'JS'
   const admin = db.getSiblingDB('admin');
   admin.createUser({ user: 'mc_root', pwd: process.env.MONGO_MC_ROOT_PASSWORD, roles: ['root'] });
   admin.auth('mc_root', process.env.MONGO_MC_ROOT_PASSWORD);
   admin.createUser({ user: 'mc_service_app', pwd: process.env.MONGO_MC_APP_PASSWORD,
                      roles: [{ role: 'readWrite', db: 'mc_db' }] });
   print('users created');
   JS
   ```
   (Pass the passwords into the container's env for the exec, or inline them from the Komodo-rendered
   `.env.prod`. Never echo them to logs.)
3. **`mc-service` reconnects** with `mc_service_app` (its `MC_DB_URL` already carries
   `${MONGO_MC_APP_PASSWORD}`) → the stack goes healthy. Restart `mc-service` if it has backed off.
4. **Verify** (Scenarios 2–4):
   ```bash
   # anonymous rejected:
   docker exec mc-service-store-mongo mongosh "mongodb://localhost:27017/mc_db?directConnection=true" \
     --quiet --eval 'db.runCommand({listCollections:1})'   # → requires authentication
   # counts match the §1 baseline (authenticated):
   docker exec mc-service-store-mongo mongosh \
     "mongodb://mc_service_app:$MONGO_MC_APP_PASSWORD@localhost:27017/mc_db?replicaSet=rs0&authSource=admin&directConnection=true" \
     --quiet --eval 'db.getCollectionNames().forEach(c=>print(c, db[c].countDocuments()))'
   ```

### Zero-downtime alternative (optional)

If a brief mc-service window is unacceptable, temporarily add `--transitionToAuth` to the mongod command
(accepts authenticated **and** anonymous connections), create the users (step 2), then redeploy WITHOUT
`--transitionToAuth` to enforce. Not required for the chosen stop-start window.

---

## 3. BFF store cutover — `mcm-bff-store-mongo` (standalone, no keyfile)

1. **Redeploy `prod-mcm-bff`**. mongod now starts `--auth` (no keyfile — standalone). The BFF's per-user
   agent-config features (feature 018) will error until `bff_app` exists; **login/collections are
   unaffected** (they go through mc-service).
2. **Create the users** (localhost exception):
   ```bash
   docker exec -i mcm-bff-store-mongo mongosh --quiet <<'JS'
   const admin = db.getSiblingDB('admin');
   admin.createUser({ user: 'bff_root', pwd: process.env.MONGO_BFF_ROOT_PASSWORD, roles: ['root'] });
   admin.auth('bff_root', process.env.MONGO_BFF_ROOT_PASSWORD);
   admin.createUser({ user: 'bff_app', pwd: process.env.MONGO_BFF_APP_PASSWORD,
                      roles: [{ role: 'readWrite', db: 'bff_db' }] });
   print('users created');
   JS
   ```
3. **BFF reconnects** with `bff_app` (its `MONGO_URL` carries `${MONGO_BFF_APP_PASSWORD}`).
4. **Verify**: anonymous rejected; agent-config read/write works; counts match §1 baseline.

---

## 4. Keyfile negative test (movie store, in rehearsal — Scenario 5)

Prove `mongod` refuses a too-open keyfile (defense-in-depth check on the entrypoint's `0400`):

```bash
docker exec mc-service-store-mongo sh -c 'chmod 0444 /tmp/mongo-keyfile'   # make it group/world readable
docker restart mc-service-store-mongo
docker logs mc-service-store-mongo 2>&1 | grep -i 'permissions on .* are too open'   # → mongod exits
```

The entrypoint re-materializes the keyfile at `0400` on the next clean start, so no manual repair is
needed — just redeploy.

---

## 5. Rollback (any step, no data loss)

Auth flags do not mutate data. To revert:

1. Redeploy the stack from a compose that omits `--keyFile`/`--auth` (or `git revert` the feature-026
   compose change and redeploy), restoring the pre-auth command.
2. The store returns to unauthenticated; the app reconnects on the old (credential-less) URL.
3. Only if a **volume-level** problem is detected, restore from the §0 snapshot.

---

## Appendix A — Fresh-volume bootstrap (DR / new host) — FR-008

This is **not** the populated-volume cutover. On a genuinely empty volume the replica set must be
initiated **after** auth is enabled, using an **authenticated** connection:

1. Start mongod with the keyfile (entrypoint materializes it) — a fresh keyfile-enabled set with no
   users leaves the localhost exception open.
2. Create `mc_root` + `mc_service_app` (as in §2 step 2) via the localhost exception.
3. **Initiate the replica set authenticated** (FR-008 — the reconfig/initiate tooling authenticates):
   ```bash
   docker exec -i mc-service-store-mongo mongosh \
     "mongodb://mc_root:$MONGO_MC_ROOT_PASSWORD@localhost:27017/?authSource=admin&directConnection=true" \
     --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
   ```
4. The steady-state healthcheck stays credential-less (`ping`); it does not re-initiate.

The BFF store, being standalone, needs no initiation — just `--auth` + user creation on the fresh volume
(the image's `MONGODB_INITDB_ROOT_*` env may seed the root user on an empty volume as an alternative).

---

## Notes

- Passwords/keyfile are Komodo Variables → `.env.prod` (chmod 600, gitignored) → env. Never commit, never
  log. The keyfile is **never** a host file or data volume — it is materialized in-container by
  `mongo-entrypoint.sh` (feature 022 env-only model).
- Root users (`mc_root`/`bff_root`) are for setup/administration only; the running services use the
  least-privilege app users. Do not put root passwords in a running service's env.
- After both cutovers, run the full web E2E regression against the containerized BFF
  (`E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`) — feature 026 SC-004 / quickstart Scenario 6.
