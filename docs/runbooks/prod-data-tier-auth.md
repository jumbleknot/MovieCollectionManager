# Runbook — Production Data-Tier Authentication (feature 026, Workstream A)

Enable SCRAM authentication on the two production MongoDB stores **without data loss**. Movie store
(`mc-service-store-mongo`) is a single-member replica set → keyfile + SCRAM. BFF store
(`mcm-bff-store-mongo`) is standalone → SCRAM only, **no keyfile**.

**Window**: scheduled, ≤ 60 minutes per store, safety-first stop-start (brief service unavailability is
acceptable — feature 026 clarification; zero-downtime rolling is NOT required). **Rehearse the whole
procedure on a restored volume snapshot in a scratch environment BEFORE touching production.**

Acceptance oracles: [../../specs/026-prod-data-auth-vault/quickstart.md](../../specs/026-prod-data-auth-vault/quickstart.md)
(Scenarios 1–5). Contract: [../../specs/026-prod-data-auth-vault/contracts/mongo-auth-contract.md](../../specs/026-prod-data-auth-vault/contracts/mongo-auth-contract.md).

**Related (feature 028):** the `mc-service-store-mongo` keyfile entrypoint was made idempotent so a plain
restart over a leftover `0400` keyfile no longer crash-loops → [prod-reboot-resilience.md](prod-reboot-resilience.md).

**Related (feature 081 US8a):** the in-place MongoDB 8.0.8 → 9.0 upgrade of both stores — pre-flight, deploy,
verification, FCV raise and restore-based rollback — is [§6](#6-mongodb-808--90-upgrade-data-preserved-feature-081-us8a-t059).

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
2. **mongod runtime uid — `uid=998(mongod)` on `8.0.8-ubi9` (2026-07-05), `uid=1000(mongod)` on `9.0-ubi9`
   (2026-10-20, feature 081).** The keyfile entrypoint writes `/tmp/mongo-keyfile` and execs mongod as the
   same user, so keyfile ownership matches by construction. The uid change is why both stores now start as
   root only to re-own `/data/db` and then drop to `mongod` (§6.0). Re-confirm on every image bump:
   `docker run --rm --entrypoint id <image>` — a changed uid on a populated volume is an outage.
3. **Back up** each prod volume before the window (rollback insurance — auth flags never mutate data, but
   a verified backup makes rollback guaranteed):
   ```bash
   mkdir -p ~/mongo-backups   # a dir YOU own — with rootless Docker the container maps to your user,
                              # so it cannot write to host / or other root-owned paths (don't run from /).
   docker run --rm -v mc-service-store-mongo-data:/v -v ~/mongo-backups:/b alpine tar czf /b/mc-mongo-backup.tgz -C /v .
   docker run --rm -v mcm-bff-store-mongo-data:/v   -v ~/mongo-backups:/b alpine tar czf /b/bff-mongo-backup.tgz -C /v .
   ls -lh ~/mongo-backups     # verify two non-zero .tgz files
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

## 6. MongoDB 8.0.8 → 9.0 upgrade, data preserved (feature 081 US8a, T059)

Moves both production stores — `mc-service-store-mongo` (single-member replica set `rs0`, keyfile + SCRAM)
and `mcm-bff-store-mongo` (standalone, SCRAM) — from `8.0.8-ubi9` to `9.0-ubi9` (9.0.4) **in place**, on
their existing volumes. Rehearsed end to end on a copy of the dev volumes in the prod auth shape
(specs/081-major-dependency-upgrades/research.md R8, T056): counts and index lists identical at every
step, including a rollback onto a fresh 8.0.8 volume. **Every block below was then run verbatim** against a
prod-shaped stack (the real `compose.prod.yaml` files, container names substituted) — pre-flight, P7
rehearsal, deploy, V1–V4, FCV raise, and RB0–RB5 — and printed the stated **Expected** output.

### 6.0 What merging the PR does in production — read first

- **Merging deploys it.** `app-ci` on `main` → `trigger-cd` → `cd-deploy` (deploy=true) → Komodo
  ResourceSync webhook → the changed stacks redeploy in `after` order: **`prod-mc-service`, then
  `prod-mcm-bff`**. Expect it 45–90 minutes after the merge (main's CI runs first). The post-deploy
  health probe checks only the issuer and `https://mcm.<domain>` → 200, so **it does not notice a
  broken Mongo**; verification (§6.3) is yours.
- On deploy each Mongo container is **recreated** (image, `user`, `entrypoint` changed): the old 8.0.8
  container stops, the new one starts **as root**, logs `mongo-data-owner: re-owning /data/db to mongod
  (uid 1000)` **once**, re-owns the volume and drops to `mongod` before mongod starts. This is required:
  9.0-ubi9 runs mongod as **uid 1000**, 8.0.8-ubi9 ran it as **uid 998**, and without the re-own 9.0
  dies at start with `Unable to read the storage engine metadata file ... storage.bson` (`FileNotOpen`)
  — measured. mongod itself never runs as root (`scripts/__tests__/mongo-data-owner.guard.test.mjs`).
- **mongod 9.0 starts on the 8.0 data at FCV `"8.0"`** (measured: `9.0.4`, FCV `8.0`, `rs0` PRIMARY,
  counts and indexes unchanged). The FCV is **not** raised by the deploy — that is §6.4, after a soak.
- **Shutdown of the old BFF store is a SIGKILL, and that is survivable.** Both images start mongod
  under a Python entrypoint (PID 1) that does not forward SIGTERM, so `docker stop` waits out the
  timeout and kills mongod (measured on 8.0.8 and 9.0). The movie store's prod entrypoint `exec`s
  mongod and stops cleanly. 9.0 recovered the SIGKILLed 8.0.8 BFF volume from its journal with
  identical counts (rehearsed). Your backups (§6.1) are the insurance.
- **There is no image-revert rollback.** MongoDB supports a binary downgrade from 9.0 only to the
  *latest* 8.0 patch, never to 8.0.8, and the volume is re-owned to uid 1000. Rollback is **restore a
  dump onto a fresh volume** (§6.5) — rehearsed, including a dump taken from 9.0 at FCV 9.0.
- **Do NOT pre-chown the prod volumes before the merge** — 8.0.8 (uid 998) would then fail the same way.
- **HARD PRECONDITION — the host kernel.** mongod 9.0.4 refuses to start on **Linux 6.19.0 through 7.0.13**
  (`"id":12257600 … MongoDB cannot start: Linux kernel versions 6.19.0 through 7.0.13 have a known
  incompatibility with this version of MongoDB`, SERVER-121912) — there is no override flag. It crash-loops
  instead. Measured on PR #817's `app-e2e`: the CI daemon's kernel is in that range, and the CI and prod
  daemons share **one** physical host, so **prod is in that range too until the host kernel is upgraded**.
  P0 checks it; do not merge while it fails.

**How to use the blocks.** Run every block on the prod host, in the shell whose `docker` talks to the
**prod** rootless daemon (not the CI one). Paste one block at a time and compare with **Expected**.
Each block runs in a `( set -eu … )` subshell, so a failure stops that block without closing your
terminal; it never asks you to type a secret mid-block. `B` is the evidence directory, re-set in
every block so a new terminal works.

### 6.1 Pre-flight — read-only, before merging (same day as the merge)

**P0 — right daemon, both stores up**
```bash
uname -r; v=$(uname -r | cut -d- -f1); lo=$(printf '%s\n6.19.0\n' "$v" | sort -V | head -1); hi=$(printf '%s\n7.0.14\n' "$v" | sort -V | head -1); if { [ "$lo" = "$v" ] && [ "$v" != 6.19.0 ]; } || [ "$hi" = 7.0.14 ]; then echo KERNEL-OK; else echo "KERNEL-BLOCKED: $v is in 6.19.0..7.0.13 — mongod 9.0 will not start (SERVER-121912); upgrade the host kernel first"; fi
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -E '^(mc-service-store-mongo|mcm-bff-store-mongo|mc-service|mcm-bff-service) '
```
Expected: the kernel version, then `KERNEL-OK` (below 6.19.0, or 7.0.14 and later); `KERNEL-BLOCKED` → **stop,
do not merge**. Then four lines; both stores on `mongodb/mongodb-community-server:8.0.8-ubi9@sha256:784dd73b…`,
`Up … (healthy)`. Fewer lines → wrong daemon/user; stop.

**P1 — evidence directory (chmod 700)**
```bash
( set -eu; umask 077; B=~/mongo-upgrade-081; mkdir -p "$B"; chmod 700 "$B"; ls -ld "$B" )
```
Expected: `drwx------ … /home/<you>/mongo-upgrade-081`.

**P2a — movie-store root password.** This block is ONE line: paste it alone, press Enter, then paste
the value of the Komodo Variable `MONGO_MC_ROOT_PASSWORD` and press Enter (nothing echoes).
```bash
read -rs -p 'MONGO_MC_ROOT_PASSWORD: ' MONGO_MC_ROOT_PASSWORD && export MONGO_MC_ROOT_PASSWORD && echo " ok (${#MONGO_MC_ROOT_PASSWORD} chars)"
```
**P2b — BFF-store root password** (same, Komodo Variable `MONGO_BFF_ROOT_PASSWORD`):
```bash
read -rs -p 'MONGO_BFF_ROOT_PASSWORD: ' MONGO_BFF_ROOT_PASSWORD && export MONGO_BFF_ROOT_PASSWORD && echo " ok (${#MONGO_BFF_ROOT_PASSWORD} chars)"
```
Expected: ` ok (48 chars)` each (the runbook §0 values are `openssl rand -hex 24`).

**P3 — credentials work; FCV and replica-set state (both stores)**
```bash
( set -eu
docker exec -e MONGO_MC_ROOT_PASSWORD mc-service-store-mongo sh -c 'mongosh --quiet "mongodb://mc_root:${MONGO_MC_ROOT_PASSWORD}@localhost:27017/?authSource=admin&directConnection=true" --eval "print(\"mc  \"+db.version()+\" FCV=\"+db.adminCommand({getParameter:1,featureCompatibilityVersion:1}).featureCompatibilityVersion.version+\" \"+rs.status().members.map(m=>m.stateStr).join(\",\"))"'
docker exec -e MONGO_BFF_ROOT_PASSWORD mcm-bff-store-mongo sh -c 'mongosh --quiet "mongodb://bff_root:${MONGO_BFF_ROOT_PASSWORD}@localhost:27017/?authSource=admin" --eval "print(\"bff \"+db.version()+\" FCV=\"+db.adminCommand({getParameter:1,featureCompatibilityVersion:1}).featureCompatibilityVersion.version)"'
)
```
Expected:
```
mc  8.0.8 FCV=8.0 PRIMARY
bff 8.0.8 FCV=8.0
```
`Authentication failed` → wrong password; redo P2. **FCV not `8.0` → STOP, do not merge**: on that store
run `db.adminCommand({setFeatureCompatibilityVersion:"8.0", confirm:true})` as root, re-run P3, and
record it. (The 9.0 upgrade requires FCV 8.0; the dev volumes measured 8.0.)

**P4 — per-collection counts and index lists, to files**
```bash
( set -eu; umask 077; B=~/mongo-upgrade-081
cat > "$B/counts.js" <<'JS'
db.getMongo().getDBNames().filter(d=>!["admin","config","local"].includes(d)).sort().forEach(n=>{const d=db.getSiblingDB(n); d.getCollectionNames().sort().forEach(c=>print(n+"."+c+" "+d[c].countDocuments({})))})
JS
cat > "$B/indexes.js" <<'JS'
const srt=(o,keep)=>(!keep&&o&&typeof o==="object"&&!Array.isArray(o))?Object.keys(o).sort().reduce((r,k)=>(r[k]=srt(o[k],k==="key"),r),{}):o;
db.getMongo().getDBNames().filter(d=>!["admin","config","local"].includes(d)).sort().forEach(n=>{const d=db.getSiblingDB(n); d.getCollectionNames().sort().forEach(c=>d[c].getIndexes().sort((a,b)=>a.name<b.name?-1:1).forEach(i=>{delete i.v; print(n+"."+c+" "+EJSON.stringify(srt(i)))}))})
JS
for js in counts indexes; do
  docker exec -i -e MONGO_MC_ROOT_PASSWORD mc-service-store-mongo sh -c 'mongosh --quiet "mongodb://mc_root:${MONGO_MC_ROOT_PASSWORD}@localhost:27017/?authSource=admin&directConnection=true" --eval "$(cat)"' < "$B/$js.js" > "$B/mc-$js-before.txt"
  docker exec -i -e MONGO_BFF_ROOT_PASSWORD mcm-bff-store-mongo sh -c 'mongosh --quiet "mongodb://bff_root:${MONGO_BFF_ROOT_PASSWORD}@localhost:27017/?authSource=admin" --eval "$(cat)"' < "$B/$js.js" > "$B/bff-$js-before.txt"
done
wc -l "$B"/*-before.txt; cat "$B/mc-counts-before.txt" "$B/bff-counts-before.txt" )
```
Expected: four non-empty files; the counts print `mc_db.movie_collections <n>`, `mc_db.movies <n>`,
`bff_db.user_agent_config <n>`, `bff_db.backup_*` … Keep these numbers — they are the T059 "before"
record for the PR. The mc index file has 4 lines for `mc_db.movie_collections` and 15 for `mc_db.movies`
(two carry `"collation":{…"locale":"en"…"strength":2…}`).

**P5 — backups (full `mongodump` archives, users included)**
```bash
( set -eu; umask 077; B=~/mongo-upgrade-081
docker exec -e MONGO_MC_ROOT_PASSWORD mc-service-store-mongo sh -c 'mongodump --uri="mongodb://mc_root:${MONGO_MC_ROOT_PASSWORD}@localhost:27017/?authSource=admin&directConnection=true" --archive --gzip' > "$B/mc-full.archive.gz" 2> "$B/mc-dump.log"
docker exec -e MONGO_BFF_ROOT_PASSWORD mcm-bff-store-mongo sh -c 'mongodump --uri="mongodb://bff_root:${MONGO_BFF_ROOT_PASSWORD}@localhost:27017/?authSource=admin" --archive --gzip' > "$B/bff-full.archive.gz" 2> "$B/bff-dump.log"
gzip -t "$B/mc-full.archive.gz" && gzip -t "$B/bff-full.archive.gz" && echo GZIP-OK
grep -c 'done dumping' "$B/mc-dump.log" "$B/bff-dump.log"
grep -o 'done dumping [^ ]* ([0-9]* document' "$B/mc-dump.log" "$B/bff-dump.log" | grep -v -E 'admin\.|config\.'
! grep -i -E 'error|failed' "$B/mc-dump.log" "$B/bff-dump.log" && echo NO-DUMP-ERRORS
ls -l "$B" )
```
Expected: `GZIP-OK`; each `done dumping` count ≥ 2; the per-collection document numbers equal
`*-counts-before.txt`; `NO-DUMP-ERRORS`; both archives non-zero, mode `-rw-------`. (The completion check
is a grep for the marker, not a `tail`.) Copy `~/mongo-upgrade-081` off the host as well if you can.

**P6 — pre-pull the 9.0 image and check its user**
```bash
docker pull mongodb/mongodb-community-server:9.0-ubi9@sha256:6eefedc81a1dbe67e03bf543ad740c3ca7e968b71e57f8b722b74a8a0836d627 && docker run --rm --entrypoint sh mongodb/mongodb-community-server:9.0-ubi9@sha256:6eefedc81a1dbe67e03bf543ad740c3ca7e968b71e57f8b722b74a8a0836d627 -c 'mongod --version | head -1; id; command -v setpriv'
```
Expected: `db version v9.0.4`, `uid=1000(mongod) gid=1000(mongod) …`, `/usr/bin/setpriv`.

**P7 (recommended) — rehearse on YOUR data, in scratch containers that touch nothing live.** Restores
the P5 archives into throwaway 8.0.8 containers (no network, own volumes), stops them cleanly, re-owns
and starts 9.0 on the same volumes — exactly what the deploy does — and compares counts.

P7a — define the bounded wait (stays in your shell; harmless):
```bash
wait_mongo() { c=$1; i=0; while [ $i -lt 60 ]; do s=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing); if [ "$s" != running ]; then echo "FAIL: $c is $s"; docker logs --tail 40 "$c" 2>&1; return 1; fi; if docker exec "$c" mongosh --quiet --eval 'db.adminCommand("ping").ok' 2>/dev/null | grep -qx 1; then echo "$c answering after $((i*2))s"; return 0; fi; i=$((i+1)); sleep 2; done; echo "FAIL: $c not answering after 120s"; docker logs --tail 40 "$c" 2>&1; return 1; }
```
P7b — 8.0.8 scratch copies from the backups:
```bash
( set -eu; B=~/mongo-upgrade-081; OLD=mongodb/mongodb-community-server:8.0.8-ubi9@sha256:784dd73b701c3fb846876394c8137a9b42c35791ed1c8a931d8efa2cb0c8dd81
docker volume create r081-mc >/dev/null; docker volume create r081-bff >/dev/null
docker run -d --name r081-mc --network none -v r081-mc:/data/db "$OLD" mongod --replSet rs0 --bind_ip 127.0.0.1 >/dev/null
docker run -d --name r081-bff --network none -v r081-bff:/data/db "$OLD" mongod --bind_ip 127.0.0.1 >/dev/null
wait_mongo r081-mc; wait_mongo r081-bff
docker exec r081-mc mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]}).ok'
i=0; until docker exec r081-mc mongosh --quiet --eval 'db.hello().isWritablePrimary' | grep -qx true; do i=$((i+1)); [ $i -lt 30 ] || { echo "FAIL: no PRIMARY"; docker logs --tail 40 r081-mc; exit 1; }; sleep 2; done; echo PRIMARY
docker exec -i r081-mc mongorestore --archive --gzip < "$B/mc-full.archive.gz" 2>&1 | grep -E 'restored successfully'
docker exec -i r081-bff mongorestore --archive --gzip < "$B/bff-full.archive.gz" 2>&1 | grep -E 'restored successfully'
docker exec -i r081-mc sh -c 'mongosh --quiet --eval "$(cat)"' < "$B/counts.js" | diff "$B/mc-counts-before.txt" - && echo MC-COUNTS-EQUAL || echo "^^^ DIFFERENCE (above)"
docker exec -i r081-bff sh -c 'mongosh --quiet --eval "$(cat)"' < "$B/counts.js" | diff "$B/bff-counts-before.txt" - && echo BFF-COUNTS-EQUAL || echo "^^^ DIFFERENCE (above)" )
```
Expected: two `answering` lines, `1`, `PRIMARY`, two `… document(s) restored successfully. 0 document(s)
failed to restore.`, `MC-COUNTS-EQUAL`, `BFF-COUNTS-EQUAL`. (BFF `backup_runs` can be lower here only if
runs expired by TTL between P4 and now.)

P7c — clean stop, re-own, start 9.0 on the same volumes, compare:
```bash
( set -eu; B=~/mongo-upgrade-081; NEW=mongodb/mongodb-community-server:9.0-ubi9@sha256:6eefedc81a1dbe67e03bf543ad740c3ca7e968b71e57f8b722b74a8a0836d627
for c in r081-mc r081-bff; do docker exec "$c" mongosh --quiet --eval 'db.adminCommand({shutdown:1})' >/dev/null 2>&1 || true; done
i=0; while docker ps -q --filter name='^r081-(mc|bff)$' | grep -q .; do i=$((i+1)); [ $i -lt 30 ] || { echo "FAIL: scratch mongod did not stop"; exit 1; }; sleep 2; done; echo STOPPED
docker logs r081-mc 2>&1 | grep -c '"Now exiting"' || true
docker rm r081-mc r081-bff >/dev/null
for v in r081-mc r081-bff; do docker run --rm -u 0 -v "$v":/data/db --entrypoint chown "$NEW" -R mongod:mongod /data/db; done
docker run -d --name r081-mc --network none -v r081-mc:/data/db "$NEW" mongod --replSet rs0 --bind_ip 127.0.0.1 >/dev/null
docker run -d --name r081-bff --network none -v r081-bff:/data/db "$NEW" mongod --bind_ip 127.0.0.1 >/dev/null
wait_mongo r081-mc; wait_mongo r081-bff
for c in r081-mc r081-bff; do docker exec "$c" mongosh --quiet --eval 'print(db.version()+" FCV="+db.adminCommand({getParameter:1,featureCompatibilityVersion:1}).featureCompatibilityVersion.version)'; done
docker exec -i r081-mc sh -c 'mongosh --quiet --eval "$(cat)"' < "$B/counts.js" | diff "$B/mc-counts-before.txt" - && echo MC-COUNTS-EQUAL-ON-9 || echo "^^^ DIFFERENCE (above)"
docker exec -i r081-bff sh -c 'mongosh --quiet --eval "$(cat)"' < "$B/counts.js" | diff "$B/bff-counts-before.txt" - && echo BFF-COUNTS-EQUAL-ON-9 || echo "^^^ DIFFERENCE (above)"
docker exec -i r081-mc sh -c 'mongosh --quiet --eval "$(cat)"' < "$B/indexes.js" | diff "$B/mc-indexes-before.txt" - && echo MC-INDEXES-EQUAL-ON-9 || echo "^^^ DIFFERENCE (above)" )
```
Expected: `STOPPED`, `1`, two `answering` lines, `9.0.4 FCV=8.0` twice, then `MC-COUNTS-EQUAL-ON-9`,
`BFF-COUNTS-EQUAL-ON-9`, `MC-INDEXES-EQUAL-ON-9`. Anything else: **do not merge**; keep the scratch
containers and read their logs (`docker logs --tail 80 r081-mc`).

P7d — remove the scratch copies (only after you have read P7c's output):
```bash
docker rm -f r081-mc r081-bff; docker volume rm r081-mc r081-bff
```

### 6.2 Merge and deploy

**M1** — merge the PR (no further pre-merge change is needed: the re-own is in the compose). Avoid using
the app between P4 and the deploy if you want the counts to compare exactly.

**M2 — wait for the deploy, bounded, and catch a crash-loop** (polls for up to 2 hours):
```bash
( set -eu; NEW=mongodb/mongodb-community-server:9.0-ubi9@sha256:6eefedc81a1dbe67e03bf543ad740c3ca7e968b71e57f8b722b74a8a0836d627; i=0
while :; do
  for c in mc-service-store-mongo mcm-bff-store-mongo; do
    s=$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$c" 2>/dev/null || echo "missing 0")
    case "$s" in running*) ;; *) echo "WARN: $c is $s"; docker logs --tail 30 "$c" 2>&1 || true;; esac
    img=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || true); r=${s#* }
    if [ "$img" = "$NEW" ] && [ "$r" -gt 2 ]; then echo "FAIL: $c restarted $r times on 9.0 — crash-loop"; docker logs --tail 60 "$c" 2>&1; exit 1; fi
  done
  a=$(docker inspect -f '{{.Config.Image}}' mc-service-store-mongo 2>/dev/null || true); b=$(docker inspect -f '{{.Config.Image}}' mcm-bff-store-mongo 2>/dev/null || true)
  if [ "$a" = "$NEW" ] && [ "$b" = "$NEW" ]; then echo "BOTH ON 9.0 after $((i/2)) min"; break; fi
  i=$((i+1)); [ $i -lt 240 ] || { echo "TIMEOUT: still mc=$a bff=$b — deploy in Komodo (below)"; exit 1; }; sleep 30
done )
```
Expected: `BOTH ON 9.0 after <n> min`. On `TIMEOUT` (sync did not redeploy): Komodo UI → Stacks →
`prod-mc-service` → **Deploy**, wait healthy, then `prod-mcm-bff` → **Deploy**, then re-run M2. On
`FAIL … crash-loop`: read the printed logs, then go to §6.5.

### 6.3 Verify (right after M2)

**V1 — containers, re-own line, version and FCV**
```bash
( set -eu
docker inspect -f '{{.Name}} {{.Config.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}}' mc-service-store-mongo mcm-bff-store-mongo mc-service mcm-bff-service
for c in mc-service-store-mongo mcm-bff-store-mongo; do echo "== $c"; docker logs "$c" 2>&1 | grep 'mongo-data-owner' || echo "(no re-own line)"; docker logs "$c" 2>&1 | grep '"id":5853300' | tail -1 | grep -o '"featureCompatibilityVersion":"[0-9.]*"' || echo "(no FCV line in the retained log)"; done )
```
Expected: both stores on the `9.0-ubi9@sha256:6eefedc8…` image, `running healthy restarts=0`;
`mc-service` and `mcm-bff-service` `running healthy`; each store shows **one**
`mongo-data-owner: re-owning /data/db to mongod (uid 1000)` and `"featureCompatibilityVersion":"8.0"`.

**V2 — PRIMARY, counts after, compare** (P2 variables must still be set in this terminal):
```bash
( set -eu; umask 077; B=~/mongo-upgrade-081
docker exec -e MONGO_MC_ROOT_PASSWORD mc-service-store-mongo sh -c 'mongosh --quiet "mongodb://mc_root:${MONGO_MC_ROOT_PASSWORD}@localhost:27017/?authSource=admin&directConnection=true" --eval "print(db.version()+\" \"+rs.status().members.map(m=>m.stateStr).join(\",\"))"'
docker exec -i -e MONGO_MC_ROOT_PASSWORD mc-service-store-mongo sh -c 'mongosh --quiet "mongodb://mc_root:${MONGO_MC_ROOT_PASSWORD}@localhost:27017/?authSource=admin&directConnection=true" --eval "$(cat)"' < "$B/counts.js" > "$B/mc-counts-after.txt"
docker exec -i -e MONGO_BFF_ROOT_PASSWORD mcm-bff-store-mongo sh -c 'mongosh --quiet "mongodb://bff_root:${MONGO_BFF_ROOT_PASSWORD}@localhost:27017/?authSource=admin" --eval "$(cat)"' < "$B/counts.js" > "$B/bff-counts-after.txt"
diff "$B/mc-counts-before.txt" "$B/mc-counts-after.txt" && echo MC-COUNTS-EQUAL || echo "^^^ DIFFERENCE (above)"
diff "$B/bff-counts-before.txt" "$B/bff-counts-after.txt" && echo BFF-COUNTS-EQUAL || echo "^^^ DIFFERENCE (above)" )
```
Expected: `9.0.4 PRIMARY`, `MC-COUNTS-EQUAL`, `BFF-COUNTS-EQUAL`. A difference **only** in
`bff_db.backup_runs` is the backup scheduler or its TTL at work (check
`db.getSiblingDB("bff_db").backup_runs.find({},{startedAt:1,expiresAt:1}).sort({startedAt:-1}).limit(3)`);
any other difference — or movies/collections you did not add or delete — is a finding: stop and §6.5.

**V3 — restart the two services so their index passes run against 9.0, then compare indexes**
```bash
( set -eu; B=~/mongo-upgrade-081
docker restart mc-service >/dev/null; docker restart mcm-bff-service >/dev/null
i=0; until docker logs --since 2m mc-service 2>&1 | grep -q 'MongoDB indexes created/verified'; do i=$((i+1)); [ $i -lt 30 ] || { echo "FAIL: mc-service index pass not seen"; docker logs --tail 40 mc-service; exit 1; }; [ "$(docker inspect -f '{{.State.Status}}' mc-service)" = running ] || { echo "FAIL: mc-service exited"; docker logs --tail 40 mc-service; exit 1; }; sleep 2; done; echo MC-SERVICE-INDEX-PASS-OK
docker exec -i -e MONGO_MC_ROOT_PASSWORD mc-service-store-mongo sh -c 'mongosh --quiet "mongodb://mc_root:${MONGO_MC_ROOT_PASSWORD}@localhost:27017/?authSource=admin&directConnection=true" --eval "$(cat)"' < "$B/indexes.js" | diff "$B/mc-indexes-before.txt" - && echo MC-INDEXES-EQUAL || echo "^^^ DIFFERENCE (above)" )
```
Expected: `MC-SERVICE-INDEX-PASS-OK`, `MC-INDEXES-EQUAL`. Then in the app (**V4**): sign in at
`https://mcm.<domain>`, open a collection, page through movies, search; open **Settings → Backups**
(this is what runs the BFF's lazy index pass) and the assistant settings. Then:
```bash
( set -eu; B=~/mongo-upgrade-081
docker exec -i -e MONGO_BFF_ROOT_PASSWORD mcm-bff-store-mongo sh -c 'mongosh --quiet "mongodb://bff_root:${MONGO_BFF_ROOT_PASSWORD}@localhost:27017/?authSource=admin" --eval "$(cat)"' < "$B/indexes.js" | diff "$B/bff-indexes-before.txt" - && echo BFF-INDEXES-EQUAL || echo "^^^ DIFFERENCE (above)"
docker logs --since 30m mcm-bff-service 2>&1 | grep -c -E '"level":"error".*[Mm]ongo' || true )
```
Expected: `BFF-INDEXES-EQUAL` and `0`. Record before/after counts (P4 + V2 files) in the PR for T059.

### 6.4 Soak, then raise FCV to 9.0

**Soak 7 days at FCV 8.0.** Nothing is gained by raising early, and while FCV is 8.0 the store has not
yet written anything 9.0-only. (Either way rollback is §6.5 — a restore — because 8.0.8 cannot open a
volume 9.0 has run on.)

**F1 — fresh backups + counts** — re-run **P1–P5 with `B=~/mongo-upgrade-081-fcv`** (edit the `B=` in
each block; P2 only if this is a new terminal). Expected as before, now on `9.0.4`.

**F2 — raise FCV on both stores**
```bash
( set -eu
docker exec -e MONGO_MC_ROOT_PASSWORD mc-service-store-mongo sh -c 'mongosh --quiet "mongodb://mc_root:${MONGO_MC_ROOT_PASSWORD}@localhost:27017/?authSource=admin&directConnection=true" --eval "printjson(db.adminCommand({setFeatureCompatibilityVersion:\"9.0\",confirm:true}).ok); print(\"FCV=\"+db.adminCommand({getParameter:1,featureCompatibilityVersion:1}).featureCompatibilityVersion.version+\" term-in-config=\"+(\"term\" in rs.conf()))"'
docker exec -e MONGO_BFF_ROOT_PASSWORD mcm-bff-store-mongo sh -c 'mongosh --quiet "mongodb://bff_root:${MONGO_BFF_ROOT_PASSWORD}@localhost:27017/?authSource=admin" --eval "printjson(db.adminCommand({setFeatureCompatibilityVersion:\"9.0\",confirm:true}).ok); print(\"FCV=\"+db.adminCommand({getParameter:1,featureCompatibilityVersion:1}).featureCompatibilityVersion.version)"' )
```
Expected: `1` / `FCV=9.0 term-in-config=true`, then `1` / `FCV=9.0`. (Without `confirm:true` the command
refuses — measured; it is idempotent, so re-running is safe.)

**F3** — re-run **V2 and V3** with `B=~/mongo-upgrade-081-fcv` (its P4 files are the "before").
Expected: equal counts and `MC-INDEXES-EQUAL`/`BFF-INDEXES-EQUAL`. MongoDB 9.0's open known issue
SERVER-89953 says `listIndexes` may report `collation: {locale: "simple"}` on simple-collation indexes
at FCV 9.0; it did **not** appear in the rehearsal on 9.0.4, and this codebase never reads
`listIndexes` (mc-service re-issues named `createIndexes`, a no-op for an identical spec). If it does
appear here, it is a reporting difference on those index lines only, not a data change — record it.

### 6.5 Rollback — restore onto a FRESH 8.0.8 volume (before or after the FCV raise)

Use the newest dump you trust: the pre-flight `~/mongo-upgrade-081/*-full.archive.gz`, or — to keep
writes made on 9.0 — take a new one first (**RB0**: re-run P5 with `B=~/mongo-upgrade-081-rb`; a dump
taken from 9.0 at FCV 9.0 restores into 8.0.8 with identical counts and indexes — rehearsed).
Define `wait_mongo` (P7a) in this terminal first. Shown for the **movie store**; the BFF store is the
same with the names in brackets and **no** `--replSet`/`rs.initiate`.

**RB1** — Komodo UI → Stacks → `prod-mcm-bff` → **Stop**, then `prod-mc-service` → **Stop**. Then open
(do not merge yet) a revert PR of the US8a merge commit.

**RB2 — keep the 9.0 volume, then recreate an empty one under the original name**
```bash
( set -eu; NEW=mongodb/mongodb-community-server:9.0-ubi9@sha256:6eefedc81a1dbe67e03bf543ad740c3ca7e968b71e57f8b722b74a8a0836d627; V=mc-service-store-mongo-data   # [mcm-bff-store-mongo-data]
[ -z "$(docker ps -q --filter volume=$V)" ] || { echo "FAIL: $V still in use — stop the stack first"; exit 1; }
docker volume create "$V-9.0-keep" >/dev/null
docker run --rm -u 0 -v "$V":/src:ro -v "$V-9.0-keep":/dst --entrypoint sh "$NEW" -c 'cp -a /src/. /dst/ && du -s /src /dst'
docker rm mc-service-store-mongo >/dev/null 2>&1 || true   # [mcm-bff-store-mongo]
docker volume rm "$V" && docker volume create "$V" )
```
Expected: two `du` lines of about the same size, then the volume name printed twice (removed, created).

**RB3 — restore into the fresh volume with a throwaway 8.0.8** (only if RB2 printed its Expected output —
on a volume 9.0 has run on, 8.0.8 dies with `FileNotOpen`, measured)
```bash
( set -eu; B=~/mongo-upgrade-081; OLD=mongodb/mongodb-community-server:8.0.8-ubi9@sha256:784dd73b701c3fb846876394c8137a9b42c35791ed1c8a931d8efa2cb0c8dd81
docker run -d --name r081-restore --network none -v mc-service-store-mongo-data:/data/db "$OLD" mongod --replSet rs0 --bind_ip 127.0.0.1 >/dev/null   # [mcm-bff-store-mongo-data, no --replSet]
wait_mongo r081-restore
docker exec r081-restore mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]}).ok'   # [skip for bff]
i=0; until docker exec r081-restore mongosh --quiet --eval 'db.hello().isWritablePrimary' | grep -qx true; do i=$((i+1)); [ $i -lt 30 ] || { echo "FAIL: no PRIMARY"; docker logs --tail 40 r081-restore; exit 1; }; sleep 2; done; echo PRIMARY
docker exec -i r081-restore mongorestore --archive --gzip < "$B/mc-full.archive.gz" 2>&1 | grep -E 'restored successfully|error'   # [bff-full.archive.gz]
docker exec -i r081-restore sh -c 'mongosh --quiet --eval "$(cat)"' < "$B/counts.js" | diff "$B/mc-counts-before.txt" - && echo RESTORED-COUNTS-EQUAL || echo "^^^ DIFFERENCE (above)"
docker exec r081-restore mongosh --quiet --eval 'db.adminCommand({shutdown:1})' >/dev/null 2>&1 || true
i=0; while [ -n "$(docker ps -q --filter name='^r081-restore$')" ]; do i=$((i+1)); [ $i -lt 30 ] || { echo "FAIL: did not stop"; exit 1; }; sleep 2; done; echo STOPPED-CLEANLY )
```
Expected: `answering`, `1`, `PRIMARY`, `… restored successfully. 0 document(s) failed …`,
`RESTORED-COUNTS-EQUAL` (compare with the files of the dump you restored), `STOPPED-CLEANLY`. The
archive carries `admin.system.users`, so `mc_root`/`mc_service_app` come back with their passwords.

**RB4** — after reading RB3's output: `docker logs --tail 20 r081-restore; docker rm r081-restore`.

**RB5** — merge the revert PR. Its deploy brings back the 8.0.8 compose onto the restored volumes (or
Komodo → `prod-mc-service` → **Deploy**, then `prod-mcm-bff` → **Deploy** once the revert is on `main`).
Then run **V1** (expect the 8.0.8 image and **no** re-own line) and **V2** against the dump's counts.
Keep the `*-9.0-keep` volumes until the cause is understood.

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
