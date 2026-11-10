---
type: Runbook
title: Local dev infrastructure & environment variables
description: How the four independently operable Compose stacks (auth, mcm, audit, observability) are bootstrapped, credentialed, and brought up/down through their Nx lifecycle targets for local development — the mcm stack's unprofiled stores, their replica-set and MongoDB 9.0 data-ownership rules, and the movie store's dev-only cache/nofile pins — plus the leased test-database pool and the load-bearing ordering, credential-rotation, missing-.env.local and stale-credential gotchas that break a fresh box or a test run if skipped.
resource: docs/runbooks/local-dev.md
resource-sha256: 243ef4f3927608fb594d463dfd7b27cf9eb68b256200b3025953c003e59965be
tags: [docker-compose, local-dev, secrets, keycloak, mongodb, runbook]
generated: { by: "openwiki/0.7.1", at: "2026-11-04T13:09:42.610Z" }
timestamp: 2026-11-10T03:37:28.099Z
---

# Local dev infrastructure & environment variables

All dev/test infrastructure is split into four **independently operable named Compose stacks** —
`auth`, `mcm`, `audit`, `observability` — under `infrastructure-as-code/docker/stacks/`. Each is
its own Compose project defined by a thin `include:`-only aggregator that pulls in only that stack's
per-service files; the single root `compose.yaml` aggregator is retired to a pointer. Stacks share
pre-created `external: true` networks for cross-stack traffic. Lifecycle goes through Nx targets
(`up-auth` / `up-mcm` / `up-audit` / `up-observability` / `up-all` / `up-mcm-agents`, and the
`down-*` counterparts) rather than bare `docker compose` invocations — see
[Nx as the task runner](../invariants/nx-task-runner.md),
[Infrastructure stacks](../projects/infrastructure-stacks.md) and
[Published-port reservation](../invariants/published-port-reservation.md).

Every credential in every stack is externalized — no clear-text secret lives in a tracked Compose
file — but **not every secret is a fail-fast `${VAR:?…}` reference**. Most are; the exceptions are
the BFF (`bff/compose.yaml`), which loads `frontend/mcm-app/.env.docker` with `env_file:`;
web-api-mcp (`web-api-mcp/compose.yaml`), which loads `mcp-servers/web-api-mcp/.env.local` the same
way; and the agent gateway, which keeps `AGENT_GATEWAY_CLIENT_SECRET` as an optional `${…:-}` so it
can come up without token exchange — a name `scripts/check-no-inline-secrets.mjs` allowlists by
name. Two one-time generator scripts mint the
per-machine stack credentials and project the dev realm's client secrets into the local env files
before any stack is first brought up. The full stack/profile tables, the env-var reference and the
realm-reseed recovery procedure live in [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md);
this page is the distilled summary. Provision the host toolchain first ([dev environment setup](./dev-environment-setup.md)),
or use the pre-provisioned [containerized dev environment](./devcontainer.md).

## Profiles gate services, not stacks

No stack is profile-gated as a whole. `auth` and `mcm` each start services with no profile at all,
and the profile assignments live in the component compose files rather than in the stack files:

| Stack | Starts with no profile | Needs a profile |
|---|---|---|
| `auth` | `keycloak-service`, `keycloak-store-postgres`, `keycloak-mailpit` | Vault (`vault`) |
| `mcm` | the test infra: `mc-service-store-mongo` + its rs-init, `mcm-bff-cache-redis`, `mcm-bff-store-mongo` | mc-service (`app`), the BFF (`bff-secure` / `bff-nonsecure`), the agent layer (`agents`), and the separate Metro-dev gateway `movie-assistant-gateway-metro` (`agents-metro` only) |
| `audit` | nothing | every service (`audit`) |
| `observability` | nothing | every service (`observability`) |

So `pnpm nx up-auth infrastructure-as-code` really does start Keycloak with no profile, while the
`mcm` stack's *unprofiled* bring-up is its stores only — the `up-mcm` target adds `--profile app`
for you, and `bff-*` and `agents` stay opt-in.

## The `mcm` stack's three stores, and two different Mongo shapes

The unprofiled `mcm` bring-up is three stores, and the two Mongo ones are deliberately **not** the
same shape — the difference is the reason each exists:

- **`mc-service-store-mongo` is a single-member replica set**, started with `--replSet rs0`, plus a
  one-shot `mc-service-store-mongo-rs-init` sidecar that mc-service waits on
  (`service_completed_successfully`). The replica set exists because mc-service's cascade delete runs
  inside one multi-document transaction, which a standalone `mongod` cannot serve. The sidecar
  initiates `rs0` with `host: 'localhost:27017'` — a name that resolves both from the host (through
  the published `27017`) and from mc-service in Docker, which connects with `directConnection=true`
  and so never chases the member announcement. **Never bring it up with a bare `docker run`:** that
  can initialise the set with the Docker-internal name instead, after which host-side `cargo test`
  fails with "No such host is known" while the container itself looks healthy; the repair is an
  `rs.reconfig(…, { force: true })` naming `localhost:27017`.
- **The movie store is also the one container whose resources are pinned to the dev box.** Its
  `command` carries `--wiredTigerCacheSizeGB 1` plus `--setParameter
  wiredTigerFileHandleCloseIdleTime=30 --setParameter wiredTigerFileHandleCloseMinimum=250`, and the
  service declares `ulimits.nofile.soft`/`hard` at `64000`. Both halves are load-bearing and both are
  **dev-only** (`mc-service/compose.prod.yaml` carries its own `command`). The `nofile` pin exists
  because MongoDB needs `>= 64000` while the devcontainer's Docker-in-Docker daemon hands containers a
  soft limit of 1024 — mongod survives that while idle and then exhausts it under a real run, the
  replica set can no longer reach itself on `localhost:27017`, and the container crash-loops. The
  cache and sweeper pins answer a different failure with an *identical* symptom: WiredTiger's default
  cache is `max(0.5 * (RAM - 1 GB), 256 MB)` (~7.9 GB on a 16 GB box, with no swap) and MongoDB raises
  the sweeper thresholds to `closeIdleTime=600 s` / `closeMinimum=2000`, which is wrong for a workload
  that churns thousands of namespaces a minute. `--setParameter` is **startup-only** — it cannot be
  changed at runtime — so a mongod that died of either resource must be recreated, not reconfigured.
- **`mcm-bff-store-mongo` is a plain standalone `mongod`** — no `--replSet`, no `directConnection`,
  no rs-init sidecar. The BFF store does single-document upserts only, so it needs no transactions.
  It publishes on `27018` so it cannot collide with the movie store's `27017`, and it is the store the
  BFF's own boundary owns: the BFF must not reach across a service boundary into mc-service's
  database.
- **`mcm-bff-cache-redis` is the third**, and the BFF's login path reads it with no typed wrapper
  around the first call — with Redis down, `/login` returns a bare 500 "Authentication failed" rather
  than an infrastructure error, so check Redis first when login breaks.

## The integration harness leases test databases, it does not mint them

`common::test_db()` used to mint a fresh `mc_test_<uuid>` database per call and drop it on release.
That made the namespace count scale with **test** count (~180 databases, ~3 400 WiredTiger idents per
run) and leaked on every panic, because a panicking test never reached `cleanup_db`. It now leases a
bounded pool slot instead:

- The database is named `mc_test_s<slot>` and the slot space is capped at `MAX_SLOTS = 64`, with
  bookkeeping in the `mc_test_pool.leases` collection of the `mc_test_pool` database (which never
  carries test data).
- **Cleaning happens on ACQUIRE, not on release.** `reset()` deletes the documents in `movies` and
  `movie_collections` and re-runs the idempotent `create_indexes` — deleting documents rather than
  dropping the database, because a drop unlinks the idents the next acquire would recreate. That
  inversion is what makes a panicking test cost nothing, and it is why `cleanup_db` is now a
  deliberate no-op: the guarantee genuinely moved, so its ~148 call sites still read correctly.
- A slot is held for the **duration of a test** and handed back by a thread-local destructor, not
  owned by a thread identity — libtest spawns a new thread per test, so keying slots by `ThreadId`
  would have reproduced one-slot-per-test churn (measured: 41 tests produced 39 slots).
- A lease whose holder pid has exited is reclaimable **immediately**; the 600 s staleness window is the
  backstop for a holder that cannot be judged (another host, unreadable pid). Without the liveness
  path the slot space would be exhausted within a single run, since the integration binaries run one
  after another.
- If every slot is held by a live process the pool degrades to the old unique `mc_test_<uuid>` name
  rather than sharing a database with a running test — so only that fallback path (and runs predating
  the pool) leaves the debris the runbook's cleanup command clears, whose regex is anchored on the
  32-hex suffix so the real `mc_db` can never match.

The properties a passing suite cannot show — same database returned twice on one thread, a pool-slot
name rather than a unique one, rows left by a deliberate panic gone for the next acquisition, product
indexes present on acquire, and stale-versus-live lease reclaimability — are pinned by
`backend/mc-service/tests/integration/pool_test.rs`. If `cleanup_db` is ever made to drop or wipe
again, expect the namespace churn to come straight back.

```mermaid
stateDiagram-v2
  [*] --> Free
  Free --> Leased: try_claim_slot
  Leased --> Leased: reset on acquire and refresh lease
  Leased --> Free: thread-local destructor at test end
  Leased --> Free: holder pid exited or lease older than 600 s
```

How a pool slot moves between free and leased: in-process release via the thread-local destructor,
cross-process reclaim via holder liveness or the staleness window.

## One-time bootstrap (per machine)

1. Pre-create the external networks and persistent volumes (`docker network create …`, `docker
   volume create …` for the mc-service Mongo store, the Keycloak Postgres store, the two BFF stores,
   the agent Postgres store and the audit OpenSearch volumes). On a fresh engine, also build the
   local-only `mc-service:latest` with `pnpm nx build mc-service` before the `mcm` bring-up:
   `up-mcm` and `up-all` do not build it, so Compose stops at the pull stage with
   `pull access denied for mc-service` and no `mcm` container is created — a missing build, not a
   registry-login problem, so do not `docker login`. Compose does not rebuild an image that already
   exists either, so re-run the build to pick up mc-service code changes.
2. `node scripts/gen-dev-secrets.mjs` — mints one gitignored `infrastructure-as-code/docker/stacks/<stack>.env`
   per stack from the committed `<stack>.env.example` templates. Idempotent; `--force` rotates and
   `--stack=<name>` scopes. An existing `<stack>.env` is **completed, never skipped**: keys the template
   has gained since are seeded **into** it, so one new variable never forces a rotation of every other
   value. A `<generate:KIND>` key that exists but is **empty** (`KEY=`) is likewise minted in place — it
   holds no value, so filling it rotates nothing, whereas counting it as "present" was the silent skip of
   item #552 (the run says up to date, the suite that needs the value skips to green, and nothing names
   why). A blank *fixture* key is left alone — the generator has no value to give a key that is not a
   `<generate:KIND>` placeholder. No live dev-stack template carries such a blank key any more: the
   `REGISTRY_HOST=` that used to sit in `mcm.env.example` and `observability.env.example` left with
   feature 080, when the object-store image became a public digest pull, so the rule survives only as a
   synthetic template in the guard test. Each run
   names the keys it added or filled — **key names only, never values** — and warns that containers
   started before the run do not hold the new values, so they must be recreated and `gen-dev-env.mjs`
   re-run. Deterministic fixtures (`LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `..._SECRET_KEY`, the
   `BACKUP_TEST_*` public halves) are copied verbatim even under `--force`. Exit codes: `0` success · `1`
   missing/malformed template, unknown generation kind, or unwritable output · `2` bad args.
3. `node scripts/gen-dev-env.mjs` — projects the realm's client secrets out of `stacks/auth.env`
   into the BFF env files, so **realm-secret == BFF-secret by construction** and a login works on
   first boot with no manual import. It **does not import the realm**; `up-auth` does that (step 4).
   The projection is verified against the running realm before anything is written (below), so the
   first run on a fresh box legitimately ends `NOT verified` and is followed by a re-run once `auth`
   is up.
4. `pnpm nx up-auth infrastructure-as-code` (Keycloak — the only command that seeds the realm), then
   `pnpm nx up-mcm infrastructure-as-code`, then re-run `node scripts/gen-dev-env.mjs` to turn the
   projection's ending into `VERIFIED against the realm`.

`<stack>.env` is gitignored; `<stack>.env.example` is tracked — `.gitignore` ignores `*.env` and
`*.env.*` and then carves out `!infrastructure-as-code/docker/stacks/*.env.example`, scoped to that
directory so other deliberately ignored templates stay ignored. A CI gate
(`scripts/check-no-inline-secrets.mjs`, run in the `naming` job of the guardrails workflow, once with
`--selftest` and once as the real scan) fails the build if a literal credential is re-inlined into a
tracked Compose file; the selftest proves the detector flags a planted literal, and a
`${VAR:-default}` inline default fails just like a raw literal. Non-credentials that match the
detector's secret-shaped key pattern are allowlisted by name rather than by value — `*_FILE` (a path
to a Docker secret, not the secret), `*_USER`, `*ACCESS_KEY_ID` (the public half of an S3 pair),
`*_CLIENT_ID`, `*_AUDIENCE` and `AGENT_GATEWAY_CLIENT_SECRET`. Run it locally with
`node scripts/check-no-inline-secrets.mjs` (`--selftest` optional).

## What each generator writes, and how it fails

`gen-dev-env.mjs` writes five gitignored env files on every run: `frontend/mcm-app/.env.docker`
(fully regenerated), `frontend/mcm-app/.env.local` (**surgically** synced — only the client-secret
lines are rewritten, every other developer key survives), `frontend/mcm-app/.env.e2e.local`, the
web-api-mcp `TMDB_API_KEY` file, and `backend/mc-service/.env.local`. Two of them are **created**
when absent (the frontend `.env.local` and the mc-service one); `.env.e2e.local` is deliberately
**not** created, and `agents/movie-assistant/.env.local` is deliberately never written. Both
omissions are named in the run's output.

Two classes of line are handled differently, and the difference is the whole point of the
generator:

- **Synced** — realm-derived credentials that must match the seeded realm on every run
  (`KEYCLOAK_*`, the `E2E_*` quartet, the backup test credentials projected from `stacks/mcm.env`).
  A re-run rewrites them, so a hand-edited value is corrected rather than preserved. The
  `BACKUP_TEST_*` projection is loud when it has nothing to project (item #552): the four key names
  that are absent or empty in `stacks/mcm.env` are printed, along with the command that back-fills
  them without rotating anything (`node scripts/gen-dev-secrets.mjs --stack=mcm`), because the old
  silent filter projected nothing, said nothing, and nine backup-destination suites skipped to green.
- **Seeded once** — developer knobs and host-reachable URLs (`MC_DB_URL`, `MC_SERVICE_PORT`,
  `RUST_LOG`, `MONGO_URL`, `BFF_BASE_URL`, the backup encryption/tick keys, the destination
  allow-list). Absent keys are appended; keys already present are left exactly as the developer set
  them, so a tuned `RUST_LOG` or a redirected Mongo survives a re-run. The one exception is a value
  byte-equal to a *retired generated default* (feature 080's backup S3 host rename), which is upgraded
  in place — see the gotcha below. Measured 2026-09-20: with
  `.env.local` silent on the host-reachable service URLs, the integration suites fell back to
  `.env.docker`'s Docker-internal names and died on DNS resolution — a name no process outside the
  compose network can resolve.

Exit codes: `0` success · `1` `stacks/auth.env` missing or a required key absent (run
`gen-dev-secrets` first) · `2` the running realm refuses a projected credential — nothing written.
The success line never contains the equality claim unless the realm check actually passed, and it
carries no secret values on any path.

## Gotchas

- **A credential-driven skip is a missing *or stale* file, not an unrunnable box.** Before
  concluding an environment cannot run the integration suite, name the missing input and run
  `node scripts/gen-dev-env.mjs`. The two failure modes — absent vs. stale — are diagnosed
  separately below; the right first move for either is the generator, and never copying a value out
  of a source file to "unblock" a run.
- **`mc-service:test` going red on a byte-identical Rust tree means `backend/mc-service/.env.local`
  is absent or short a variable (item #227).** `gen-dev-env.mjs` writes that file on every run: the
  `KEYCLOAK_*` / `E2E_*` lines are re-synced from `stacks/auth.env`, while `MC_DB_URL`,
  `MC_SERVICE_PORT` and `RUST_LOG` are seeded once and left alone. Without it the Rust integration
  tier panics with `Missing("MC_DB_URL")` — **16 of 41 cases fail on configuration, not code**, and
  nothing distinguished that from a real failure. Four `E2E_*` variables (for the authenticated
  `http_authz_test::*` cases that mint a real ROPC token) were the second half of the same defect
  and had been wrongly attributed to "needing a replica-set MongoDB". After the fix: **41 passed /
  0 failed**. A file that exists but lacks `MC_DB_URL` fails exactly like no file at all, which is
  why the generator keys on the variable, not the path. The integration harness's own panic message
  now names the generator command and the runbook section as well as the variable, so the two causes
  — this file, versus the replica-set MongoDB the `http_authz_test::*` cases genuinely need — stay
  apart at the moment of failure instead of three weeks later.
- **The generator names the one `.env.local` it deliberately does NOT create
  (`agents/movie-assistant/`),** which carries the operator's own Anthropic credential — a generator
  step that quietly does nothing reads identically to one nobody thought of.
- **An absent `frontend/mcm-app/.env.e2e.local` is not auto-created, and the generator says so
  loudly.** Its sync set is only the credential half, so a created file would be half-written; the
  web E2E also needs the hand-maintained fixture keys. Absence means the web E2E logs in as nobody.
- **Bring `auth` up before the `mcm` `app` profile — but the failure is 401s, not a hang.** There is
  no cross-project `depends_on` (Compose has none), so the ordering is manual. mc-service does *not*
  wait for Keycloak: OIDC discovery and the JWKS fetch run in a background task, and the service
  binds and serves immediately. If discovery fails, `/health` still answers and **every protected
  request is rejected with 401**, so the symptom is a working-looking backend that refuses every
  login. The asymmetry is worth holding on to: an unreachable **`MC_DB_URL` is a hard startup
  failure** — mc-service connects and creates its indexes before it serves — while an unreachable
  Keycloak is not.
- **A password-on-first-init credential (Postgres / OpenSearch) is baked into its data volume on
  first boot and ignores later env changes.** Rotating one for real requires regenerating the `.env`
  (`--force`) *and* recreating the service against a fresh volume — otherwise the container keeps the
  volume's original password and auth fails, with nothing pointing at the cause. Redis / Unleash-token
  / app-secret values have no such persistence and rotate on a plain restart, and **RustFS is in that
  second group rather than the first** (feature 080): it does not bake its key pair into the drive, so
  rotating `LANGFUSE_RUSTFS_SECRET_KEY` or `BACKUP_TEST_S3_SECRET_KEY` is an `.env` change plus
  recreating every consumer of that key — no volume is touched. That is a measured property, not an
  assumption: starting RustFS on a migrated drive with a different pair was readable by the new pair
  and not the old. The measurement is recorded as research R6 step 5 in
  `specs/080-minio-to-rustfs/research.md`; the migration rehearsal harness that produced it was
  deleted at the feature-080 cleanup (T048), so the spec, not a test in the tree, is the surviving
  record — a change that made the key drive-persistent would not turn any current suite red.
  **Recreate the consumers together, because the key reaches more than the server.**
  On the backup side that is the `mcm-bff-backup-rustfs` service **and its bucket-init one-shot**
  (which passes the same pair to `curl`) — plus the host-side backup suites, which read the value out
  of `frontend/mcm-app/.env.local`, the file `gen-dev-env.mjs` re-projects from `stacks/mcm.env` on
  every run, so re-run the generator after a rotation or those suites keep authenticating with the
  retired pair. On the Langfuse side the one `observability.env` key is interpolated by four services
  in the same file — `langfuse-web` and `langfuse-worker` (each holding two S3 upload keys, through a
  shared environment anchor), the `langfuse-rustfs` server, and `langfuse-rustfs-init`. Recreate only
  the store and the uploaders keep the old key, so uploads fail against a store that is healthy.
- **MongoDB 9.0 runs `mongod` as uid 1000, where 8.0.8 ran it as 998 — so an older data volume is
  foreign-owned and 9.0 refuses to start on it.** The symptom is `Unable to read the storage engine
  metadata file ... storage.bson` (`FileNotOpen`, measured 2026-10-20), and nothing in the image
  fixes it: its own entrypoint, started as root, does not drop privileges. Both Mongo services
  therefore start as root **only** to re-own `/data/db` once — logging
  `mongo-data-owner: re-owning /data/db to mongod (uid …)` — and then `setpriv` down to the image's
  `mongod` user before `mongod` runs, so `mongod` itself never runs as root. The check skips
  `.mongodb`, which is mongosh's own client-log directory (its `HOME` is `/data/db`), so an exec'd
  `mongosh` does not trigger a re-own on every start. A bare `docker run` gets none of this and needs
  the `chown` done by hand against the volume. Both halves of the wrapper are pinned by
  `scripts/__tests__/mongo-data-owner.guard.test.mjs`, which runs it against stubs and asserts the
  script text is identical across all four Mongo-bearing compose files. Going **back** to 8.0.8 on a
  volume 9.0 has already run on is not supported — restore a dump onto a fresh volume instead.
- **A seeded-once default can name a host that no longer exists, so the generator upgrades it in
  place (feature 080).** `gen-dev-env.mjs`'s seed-once rule protects what a developer *chose*, not
  what the generator itself wrote before a rename: a `.env.local` value byte-equal to a retired
  generated default — the pre-080 backup S3 endpoint and the destination allow-list entry naming that
  retired container — is rewritten to the RustFS host, in place and exactly once. Any other value,
  including a developer's own endpoint, is left exactly as it is. Without this an existing box keeps
  sending the BFF a host that no longer resolves while `.env.docker` (fully generated) admits only the
  new one, and the suites fail on "destination not allowed" — which reads as a guard bug.
- **`docker compose down --volumes` only wipes transient volumes.** Every persistent data volume is
  declared `external: true` with an explicit name in its own service compose file (so the stack's
  `include:` merge does not prefix it with the project name) and therefore survives. Wiping real data
  means removing the external volumes by hand after `down`.
- **Each stack is its own Compose project, so `down` on one no longer tears down the others.** The
  old single-project footgun is gone; treat each stack's lifecycle target as independent.
- **`--profile` flags must precede `up`/`down`** with Docker Compose v2 — a flag placed after the
  subcommand is silently ignored.
- **A profile is not isolation from interpolation.** Compose interpolates every service in an
  included file at *parse* time, regardless of which profiles are selected, so a `${REGISTRY_HOST:?}`
  inside a profile-gated service aborted `up` for the **whole** mcm stack. That is why the backup
  destinations live in a separate `infrastructure-as-code/docker/backups/compose.yaml` brought up
  explicitly, and it is why the stack file carries the incident in a comment rather than re-declaring
  a profile. `REGISTRY_HOST` no longer appears in any dev-stack template — feature 080 replaced the
  from-source object-store image with upstream `rustfs/rustfs` pulled by digest, so neither the
  observability object store nor the backup S3 destination interpolates a host at all; in production
  the same name is a per-stack Komodo variable, and `check-topology-scrub.mjs` forbids a real forge or
  tailnet host in a committed file. The *rule* that a deliberately blank fixture key is not a gap the
  generator can fill is still pinned, but only against a synthetic template.
- **The two BFF processes share one Mongo, so their keys must agree.** `BACKUP_CREDENTIAL_ENC_KEY`
  and `BACKUP_TICK_SECRET` are reused from `.env.docker` first and `.env.local` second, because the
  containerized BFF and the Metro dev loop write to the same BFF Mongo — a destination or credential
  sealed under one file's key is undecryptable under the other, surfacing much later as an
  authentication failure on a secret that was stored correctly. The two AES-256-GCM keys
  (`AGENT_CONFIG_ENC_KEY`, reused from `.env.docker` alone, and `BACKUP_CREDENTIAL_ENC_KEY`) are
  reused only when the prior value base64-decodes to exactly **32 bytes**; a legacy hex key — 64
  chars that decode to 48 bytes — is re-minted rather than reused, since the reuse path would
  silently preserve the bug it represents.
- **The `--profile agents` gateway (heavy, Postgres-checkpointer variant) needs its Keycloak client
  secret fetched live from a running Keycloak** — there is no committed source for it. Without it the
  gateway starts but every tool call fails closed (chat works; add/query/organize don't).
  `pnpm nx up-mcm-agents infrastructure-as-code` wraps this fetch-and-inject step; it is distinct from
  `scripts/agent-stack.mjs`, the light E2E variant that runs the agent stack with an in-memory
  checkpointer. The dev compose gateway is **Ollama-only** (`MODEL_PROVIDER=ollama`, supervisor and
  specialist defaults `qwen2.5` / `qwen2.5:32b`), so host Ollama has to be serving those models; the
  graph also takes ~20–40 s to build before the gateway's health endpoint answers.

## The realm check: a missing file is not the only way a credential goes wrong

`gen-dev-env.mjs` asks the realm for a token with each projected credential —
`client_credentials` for `mcm-bff-service`, ROPC for `mcm-bff-test` — **before it writes anything**,
and reports one of four outcomes. Read the outcome, not the fact that it ran:

```mermaid
flowchart TD
  A["read stacks/auth.env"] --> B{"MCM_SKIP_REALM_VERIFY set?"}
  B -- yes --> S["skipped: files written, equality NOT claimed"]
  B -- no --> C["POST token request to the realm"]
  C -- "unreachable, or HTTP 404 or 5xx" --> U["unverified: files written, equality NOT claimed"]
  C -- "400 401 403 on any credential" --> R["stale: exit 2, REFUSING TO WRITE, files untouched"]
  C -- "both grants return a token" --> V["verified: files written, equality claimed as CHECKED"]
```

How `gen-dev-env.mjs` decides to write, refuse, or decline to claim the realm equality.

| Ending | Meaning | Files | Exit |
|---|---|---|---|
| `VERIFIED against the realm at …` | both grants returned a token; the equality is **checked**, not asserted | written | 0 |
| `NOT verified: … ECONNREFUSED` (or HTTP 404/5xx) | the realm is not up or not seeded — nothing is claimed either way | written | 0 |
| `NOT verified (MCM_SKIP_REALM_VERIFY is set)` | you turned the check off; unset it | written | 0 |
| `REFUSING TO WRITE: the realm … rejects credential(s)` | the refused credential is named, and so are the ones that passed | **untouched** | **2** |

**The ordering is the fix, not a detail.** Measured on the operator's box 2026-09-09: `auth.env`'s
`E2E_ROPC_CLIENT_SECRET` was the **stale** side, while a hand-corrected `.env.e2e.local` held the
value the realm actually accepts (`mcm-bff-service` passed in the same run — the drift was one
client, not all of them). A generator that wrote first and checked afterwards would have destroyed
the only working credential on the machine before announcing the problem. Nothing is written unless
every checkable credential authenticates.

**Resolve — measure the drift before choosing the remedy.** `stacks/auth.env` is the source of truth
(it is what seeds the realm), so the fix belongs at the **realm**, never by copying the realm's
secret back into an env file: that repairs the suite in front of you and leaves `realm-secret ==
BFF-secret` broken for every other client. But *how much* of the realm to fix depends on how much
actually drifted, and that is easy to over-read. **Measured 2026-09-09 on this repository: five of
six client secrets matched `auth.env` and only `mcm-bff-test` had been regenerated** — "the realm was
seeded from a different `auth.env`" was the wrong reading, and a full re-seed would have destroyed the
whole Keycloak database to correct one field.

[docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md) holds the copy-paste client-audit
snippet (one ✓/✗ per client, printing no secret values) and the per-case procedure:

- **A few clients drifted** → PUT those clients' `secret` to `auth.env`'s value through the admin API,
  re-run the audit (expect all ✓), then immediately re-run `node scripts/gen-dev-env.mjs` — the moment
  the realm secret changes, a hand-patched `.env.e2e.local` becomes the stale side.
- **Most or all drifted** → the realm really was seeded from a different `auth.env`; re-seed it by
  force-removing the Keycloak containers, recreating `keycloak-store-postgres-data`, re-running both
  generators, `pnpm nx up-auth infrastructure-as-code`, and re-running `gen-dev-env.mjs` until it ends
  `VERIFIED against the realm`.

`MCM_SKIP_REALM_VERIFY=1` bypasses the check and projects anyway, knowing the files will carry
credentials the realm refuses. It is the escape hatch for an unusual realm, **not a fix** — and the
run says so in its own output rather than quietly reverting to the old unconditional claim.

**The whole fresh-box path has its own end-to-end assertion.** `node verify/verify-fresh-realm-seed.mjs`
provisions from scratch (wipe the volume → both generators → `pnpm nx up-auth infrastructure-as-code`)
and then proves the seed with a real ROPC token grant: `e2e-test-user` authenticating against
`mcm-bff-test` with the minted password and client secret, which only succeeds if the realm, its
clients and `stacks/auth.env` are all coherent. `--assert-only` skips provisioning and asserts against
an already-running auth stack. Its wipe encodes the ordering trap that makes the whole recovery work:
the containers mounting the external volume must be **force-removed first**, because `down -v` does not
remove an `external: true` volume and `docker volume rm` fails silently while a container still
references it — leaving Postgres's original password in place, after which Keycloak dies with
`password authentication failed for user "keycloak"` and the realm never imports.

## The missing-file case (feature 048)

**Symptom.** An integration suite reports skips — or, under `MCM_REQUIRE_LIVE_STACK=1`, a wall of
errors — whose reason mentions credentials: `missing credential(s): KEYCLOAK_SERVICE_CLIENT_SECRET`,
or the older wording `ROPC / service-account creds not set — needs the live stack`. When the file
that carries the credential is simply absent, the run of `gen-dev-env.mjs` **creates** it and reports
`CREATED .env.local (was absent)`; if it instead errors with exit 1, `stacks/auth.env` was never
minted, so run `gen-dev-secrets.mjs` first. On 2026-08-07 this cost a session: 38 errors on a healthy
stack, the conclusion *"this leg cannot be run in this dev container; CI is where it gets proven"*,
and one `node scripts/gen-dev-env.mjs` later **51 passed, 0 failed** for the agent suite.

**The general rule this is an instance of.** Before concluding *"this cannot run in this
environment"*, identify the specific missing input and check whether a generator, a `.env` file or a
documented command supplies it — and if a credential skip does not name the variable, the file it is
read from, and the command that fixes it, that message is itself the bug. Never print a secret's
value to check it; compare **key names** only.

**Which absences are still legitimate.** `--profile observability` (LangFuse, otel-lgtm, Unleash and
OPA), `--profile audit` (OpenSearch) and `--profile vault` (the dev-mode Vault, which lives in the
`auth` stack rather than here — it was relocated out of observability in feature 020) are not brought
up by `app-e2e` either; those skips are expected and allow-listed. A healthy local run of the agent
integration suite is **51 passed, 11 skipped, 0 failed**. Confirm the stale-credential case separately with
`MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration movie-mcp` — a credential skip still reads as a
pass without that flag, which is how it stayed invisible for as long as it did.

The generator's coverage is pinned by `scripts/__tests__/gen-dev-env.guard.test.mjs`: it derives the
set of documented `.env.local` files from the runbooks and fails if one is neither generated nor a
declared exception, so a documented file that nothing writes shows up here rather than three weeks
later in someone's `nx affected`. The same guard pins the two loudness rules — a deliberately skipped
file must be named in the generator's output, and an `mcm.env` missing `BACKUP_TEST_*` keys must be
reported with the back-fill command while printing no value — and the feature-080 seed-once
exception, in both directions: a `.env.local` holding the pre-080 backup endpoint and allow-list
defaults is migrated to the RustFS host in place (one occurrence, no duplicate line, the retired host
gone), while a developer's own endpoint is left untouched. It also pins the item #227 file's
behaviour from the other side: an absent `backend/mc-service/.env.local` is created with the
documented local values, an existing one keeps `RUST_LOG`, `MC_DB_URL` and unrelated keys, and a file
that exists but lacks `MC_DB_URL` has it appended.
`scripts/__tests__/gen-dev-secrets.guard.test.mjs`
pins the item #552 completion rule from the other side: an existing `mcm.env` missing the four
`BACKUP_TEST_*` keys gets all four seeded while prior values stay byte-for-byte, an empty
`<generate:KIND>` key is filled **in place** (one occurrence, not a duplicate), a template-blank
fixture key (its synthetic `REGISTRY_HOST=`, standing in for a per-machine value) is not treated as
missing, and no fixture or minted value is ever printed.
Both guards run the real script inside a throwaway mini-repo, so they are offline and keyless. The
realm check is switched off for the file-behaviour cases for exactly that reason, and item #395's own
cases turn it back on against a **stub Keycloak on loopback** — which is how the refusal path can be
asserted without a live realm: a 401 from the stub must leave a working `.env.e2e.local` byte-for-byte
intact, write nothing, exit non-zero, name the stale credential and quote the realm's own
`unauthorized_client`, print no secret value, and never emit the equality claim.

See [testing tiers](../invariants/testing-tiers.md) for how these local suites relate to the gating
tiers, [Keycloak](../projects/keycloak.md) for the realm and its clients, and
[mc-service](../projects/mc-service.md) for what the Rust integration tier needs. Full stack/profile
tables, the env-var reference, the generator scripts' exact behaviour and the realm-reseed recovery
procedure: [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md).
