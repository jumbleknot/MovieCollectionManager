# Phase 15 Work Order — Wire the CI/CD pipeline + deploy the full app stack

**Repo:** `jumbleknot/mcm` (Forgejo, org `jumbleknot`)
**Target:** stand up the **whole production app** (data + backend + BFF + agents) as Komodo
Stacks, then make a push to the deploy branch build + push images and **Komodo redeploy prod by
digest-through-git**, health-gated, with rollback-on-fail — so prod runs the full app and
updates itself instead of being hand-deployed.
**Scope note:** Phase 11 deployed only `prod-auth` (Keycloak) + `prod-app` (BFF). The BFF is just
the edge gateway — with only those two live, prod can authenticate a user but **cannot list or
add a movie**: there is no `mc-service`/`mc-db` behind the BFF and no agent stack. This work
order closes that gap *and* wires the pipeline, since they share the same digest-by-git mechanic.
**Run the repo side in:** Claude Code on the dev box (full repo access). Commit the composes,
workflow + `.env.deploy`; let Forgejo Actions build and Komodo deploy. **The SPA side (Komodo
Stacks/webhooks, Forgejo secrets) is yours** — Claude can't usefully drive those
persistent-connection UIs (see runbook operator note). Do **not** hand-run compose on prod.

---

## 0. Environment facts (confirmed)

- **Source of truth:** Forgejo at `server.tailnet.ts.net:3000` (tailnet-only). GitHub is a
  push-mirror, **not** in the CI path.
- **CI engine:** Forgejo Actions (`act_runner`) on the **ci** rootless daemon; KVM-capable label
  for the Android emulator job.
- **Registry:** Forgejo's built-in OCI registry, `server.tailnet.ts.net:3000/jumbleknot/...`.
  Both rootless daemons carry `"insecure-registries": ["server.tailnet.ts.net:3000"]` in
  `~/.config/docker/daemon.json` for plain-HTTP pulls (done on prod & ci).
  > The Forgejo Actions secret holding the push token is `REGISTRY_TOKEN`, **not**
  > `FORGEJO_REGISTRY_TOKEN` — the `FORGEJO_` prefix is reserved by the runner.
- **CD:** **Komodo** v2.x on the **prod** rootless daemon, FerretDB variant (containers
  `komodo-core/periphery/ferretdb/postgres`, compose `/home/prod/komodo/ferretdb.compose.yaml`).
  UI at `http://server.tailnet.ts.net:9120`. Git provider + `jumbleknot` PAT already
  registered under Settings → Providers → Git.
- **Webhook secret already set:** global `KOMODO_WEBHOOK_SECRET` lives in
  `/home/prod/komodo/compose.env`. That same value is the CI `KOMODO_WEBHOOK_AUTH`.
- **Digest-by-git already seeded:** `.env.deploy` is committed (commit `18faf84`) with all six
  `*_IMAGE` digests; `.env.prod` stays gitignored. The CI-built images already have digest slots
  — this work order points each stack's compose at the matching `*_IMAGE` and lets CI rewrite them.
- **Public hosts:** `mcm.${BASE_DOMAIN}` (BFF) + `auth.${BASE_DOMAIN}` (Keycloak), both live via
  Cloudflare Tunnel, direct edge-TLS. These two are the **only** public hostnames — `mc-service`,
  `mc-db`, the agent stack and its DBs stay on **internal Docker networks with no published ports**.
- **Prod volumes already provisioned on the prod daemon** (runbook Phase 5): `mc-service-store-mongo-data`,
  `movie-assistant-store-postgres-data` (agents/LangGraph checkpointer), `agent-audit-opensearch-data`
  (audit, optional). The intent to run the full stack on prod is already baked in — only the prod
  composes/Stacks are missing.

---

## 1. The core mechanic — how a deploy must travel (read first)

Komodo's webhook is a **git-style redeploy, not a digest body.** It validates the branch in a
GitHub-shaped payload + `X-Hub-Signature-256` (HMAC of the body with the global
`KOMODO_WEBHOOK_SECRET`) and then **redeploys the branch's committed compose** — it will *not*
consume an image digest you POST to it. (Known bug #1209: Stack env vars set in the Komodo *UI*
aren't reliably injected on webhook deploys — a second reason to carry the digest in git.)

So promotion is **by digest, through git**:

```
push to deploy branch
  └─► Forgejo Actions (ci daemon)
        1–8  CI: lint/build/test → stack up → web E2E → prod APK → Android Maestro
        9    docker build per service  →  Trivy scan (fail on criticals)
        10   push images → Forgejo registry, capture immutable …@sha256: digests
        11   write all changed *_IMAGE digests into tracked .env.deploy, commit + push
        12   POST signed webhook(s) → Komodo redeploys the affected app stack(s) from the branch
        13   health-gate (public mcm./auth. + internal mc-service/agent health) → pass=done; fail=rollback
```

**Rollback = redeploy the prior digest.** There is no rollback endpoint. Capture the currently
deployed digests *before* promoting, and on a failed health probe re-commit the prior `*_IMAGE`
values and re-fire the webhook (or `git revert` the promotion commit and re-fire).

---

## 2. The full deployable surface — Stacks, services & ordering

The repo-root `compose.yaml` uses `include:` + **profiles** in dev; in prod each layer becomes a
**Komodo Stack** from a per-service `compose.prod.yaml` (the pattern Phase 11 set with keycloak/bff).
Exact compose paths to be confirmed in-repo by Claude Code; proposed layout below.

| Stack | Services | CI-built images | Net(s) | Public? | Status |
|-------|----------|-----------------|--------|---------|--------|
| **`prod-auth`** | `keycloak-service` + `keycloak-store-postgres` | none (upstream `keycloak:26.5.5`) | `edge-network`, `backend-network` | `auth.` | **live (Phase 11)** |
| **`prod-data`** | `mc-db` (Mongo replica set) + `rs-init` + `mc-service` (+ `mcm-redis`) | `mc-service` | internal app net + `backend-network` | no | **AUTHOR** |
| **`prod-app`** | `mcm-bff-service` | `mcm-bff` | `edge-network` + internal app net | `mcm.` | **live (BFF only) — extend** |
| **`prod-agents`** | `agent-gateway` + `movie-mcp` + `web-api-mcp` + `agent-db` (postgres) | `agent-gateway`, `movie-mcp`, `web-api-mcp` | internal agent net + app net | no | **AUTHOR** |

That's the BFF + four backend/agent CI-built images = five; the sixth `*_IMAGE` in `.env.deploy`
is most likely the **prod APK / mcm-app web build** — Claude Code maps each `*_IMAGE` var to its
stack in-repo.

### Deploy ordering (hard dependencies)
Everything `depends_on: keycloak-service: condition: service_healthy` (services fetch JWKS on
startup to validate JWTs), and `mc-db`'s atomic cascade-delete needs the **replica set initialised
by `rs-init` first**. So first-time bring-up is **ordered**:

```
prod-auth (Keycloak healthy)
  └─► prod-data   (mc-db → rs-init → mc-service)
        ├─► prod-app     (BFF → needs mc-service)
        └─► prod-agents  (agent-gateway/movie-mcp/web-api-mcp → need mc-service + Keycloak)
```

Komodo sequences Stacks declared in a Resource Sync via the **`after`** field (+ `deploy = true`):
`prod-data` carries `after = ["prod-auth"]`, and `prod-app`/`prod-agents` carry `after = ["prod-data"]`,
so a sync deploys them in dependency order automatically (no manual ordered click-through). Starting
`prod-data` before `prod-auth` is healthy will **hang** on the JWKS wait — hence the ordering.

### Networks & volumes (the Phase 11 gotcha applies)
Pre-created networks/volumes **must be `external: true`** in every prod compose, or Komodo's deploy
errors (`network ... found but has incorrect label`). The BFF↔mc-service↔mc-db path needs a shared
internal app network; agents need their own internal net + the app net to reach `mc-service`. Create
any new external networks/volumes on the **prod** daemon before first deploy (mirror runbook Phase 5).

---

## 3. Deliverables — code vs. manual

| # | Item | Owner | In repo? | Status |
|---|------|-------|----------|--------|
| **R1** | `prod-data` `compose.prod.yaml` — `mc-db`+`rs-init`+`mc-service`(+`mcm-redis`), external nets/vols, `MC_SERVICE_IMAGE` digest ref | Claude Code | yes | **author** |
| **R2** | `prod-agents` `compose.prod.yaml` — gateway+2 MCP servers+`agent-db`, internal nets, `*_IMAGE` refs, token-exchange env | Claude Code | yes | **author** |
| R3 | Confirm/extend `prod-app` BFF compose to point at `mc-service` over the internal net | Claude Code | yes | extend |
| R4 | Port `android-e2e.yml` → `.forgejo/workflows/` (CI stages 1–8) | Claude Code | yes | if not already ported |
| **R5** | `cd-deploy.yml` — build+scan+push, **all** changed digests→`.env.deploy`, signed webhook(s), health-gate, rollback | Claude Code | yes | **main pipeline deliverable** |
| R6 | Trivy scan gating publish on no-criticals | Claude Code | yes | part of R5 |
| R7 | Flip every prod `*_IMAGE` from hand-set → CI-written `.env.deploy` | Claude Code | yes | unblocks once R5 green |
| R8 | Port `naming-gate.yml` + `secret-scan.yml` gates to Forgejo | Claude Code | yes | confirm present |
| **R9** | Author `infrastructure-as-code/komodo/*.toml` — all 4 Stacks as **config-as-code** (sanitized: `[[var]]` + `linked_repo`, `after` ordering, `deploy=true`). See §6 | Claude Code | yes | **new** |
| R10 | Make `.env.deploy` **host-free**: store bare `*_DIGEST=sha256:…`; compose builds `${REGISTRY_HOST}/…@${…_DIGEST}` | Claude Code | yes | new |
| **B1** | One-time bootstrap: register the Forgejo git provider + a `mcm-repo` **Repo** resource (holds the tailnet host); create the **`ResourceSync`** pointing at `komodo/` | you (Komodo, once) | — | new |
| B2 | One-time: seed Komodo **Variables** (masked) — `BASE_DOMAIN`,`TAILNET_HOST`,`TS_ADMIN_IP`,`REGISTRY_HOST` + per-stack secrets | you (Komodo, once) | — | new |
| M1 | Pre-create external networks/volumes on the prod daemon for the new stacks | you (prod shell) | — | new |
| M2 | Run the sync → deploys auth→data→app→agents via `after`; verify app serves data | you (Komodo) | — | new |
| M3 | Point one git webhook at the **ResourceSync** (push → reconcile + deploy); add `KOMODO_WEBHOOK_URL`+`KOMODO_WEBHOOK_AUTH` to Forgejo | you | — | unset |
| M4 | Confirm the rest of the Actions secrets (see §6) | you (Forgejo UI) | — | verify |
| V | First green run + full end-to-end app verify (create a movie, run an agent flow) | both | — | after R+M |

---

## 4. CI half — stages 1–8 (port `android-e2e.yml`)

> If `android-e2e.yml` is already ported and green on Forgejo, skip to §5. The PRD treats the
> existing GitHub-Actions YAML as a **portable asset**; the platform changed, the file mostly
> survives.

Copy `.github/workflows/android-e2e.yml` → `.forgejo/workflows/android-e2e.yml`, edits:

- **`runs-on:`** → the runner's labels (`ubuntu-latest`; add the **`kvm`** label on the emulator
  job). The Android emulator needs `--device /dev/kvm`; the runner user must be in the `kvm`
  group (runbook §2.4 / Phase 16 checklist).
- **Marketplace `uses:`** → swap any GitHub-only actions for `act_runner`-compatible equivalents
  (`actions/checkout`, `actions/cache`, `setup-*` generally work; verify niche ones).
- **Registry login/push** → `server.tailnet.ts.net:3000/jumbleknot/...` with `REGISTRY_TOKEN`.
- **Provision-env step** — materialize the throwaway CI realm + secrets from committed templates:
  `ci-realm.json` + `--import-realm`, `node scripts/gen-dev-secrets.mjs` (writes gitignored
  `stacks/*.env`), `node scripts/gen-ci-env.mjs` (writes `frontend/mcm-app/.env.docker` from
  Forgejo Actions secrets). **Do not** commit any generated file. Keep `ci-realm.json` strictly
  separate from the prod `prod-realm.json`.
- **Trigger** on `push` to the working/deploy branch first; flip to `pull_request` only after
  the first green run.

Expect the known first-run failure points, each a few minutes apart: `assembleRelease`
signing/bundle, fixture-seeding via web `global-setup` at `:8082`, then the first Maestro agent
flow on the KVM emulator. Stages 1–8 must be green before CD (9+) is allowed to run.

---

## 5. CD half — `cd-deploy.yml`

Runs **only** after CI is green on the deploy branch.

### 5.1 Build + scan (stage 9)
- `docker build` each affected service image (`mc-service`, `mcm-bff`, `agent-gateway`,
  `movie-mcp`, `web-api-mcp`, + APK build as applicable). Resolve the **immutable digest** per
  image (`docker buildx ... --metadata-file`, or `docker inspect --format '{{index .RepoDigests 0}}'`
  after push). Use `nx affected` so an unchanged service isn't rebuilt/republished.
- **Trivy** scan each image; **fail on CRITICAL** (optionally HIGH). No push if dirty.

### 5.2 Push + capture digests (stage 10)
- `docker login server.tailnet.ts.net:3000` with `REGISTRY_TOKEN`; push.
- Capture each `…@sha256:` — the **digest is the promotion artifact**, never a rebuild for prod.

### 5.3 Promote by git (stage 11)
- **Capture prior digests first** (read current `*_DIGEST` from `.env.deploy`) and stash as the
  rollback target (job output / artifact).
- Write the new bare digests — `MC_SERVICE_DIGEST=sha256:…`, `MCM_BFF_DIGEST`, `AGENT_GATEWAY_DIGEST`,
  `MOVIE_MCP_DIGEST`, `WEB_API_MCP_DIGEST` (those that changed) — into the tracked **`.env.deploy`**,
  commit with the CI identity, push to the deploy branch.
  > `.env.deploy` is tracked and carries **bare digests only — no registry host, no secrets** (R10).
  > The compose builds the full ref as `${REGISTRY_HOST}/jumbleknot/<svc>@${<SVC>_DIGEST}`, with
  > `REGISTRY_HOST` injected from `.env.prod` (Komodo, `[[TAILNET_HOST]]:3000`). So neither the host
  > nor secrets ever enter git. `.env.prod` stays gitignored / Komodo-managed.

### 5.4 Fire the signed sync webhook (stage 11→12)
- POST one GitHub-shaped JSON body naming the **branch** to the **ResourceSync's** webhook
  (`KOMODO_WEBHOOK_URL`), with `X-Hub-Signature-256 = sha256=HMAC(body, KOMODO_WEBHOOK_AUTH)`.
  Komodo re-reads the synced TOML + re-clones the branch (now carrying the new host-free
  `.env.deploy`) and **redeploys the affected stacks in `after` order** — one call covers all of them.
  > The webhook redeploys from git; it does not read a digest from the POST body — 5.3 must land in
  > git *before* 5.4 fires. The `after` ordering in the TOML (§6) handles data-before-app sequencing,
  > so the workflow doesn't need to orchestrate per-stack calls.

### 5.5 Health-gate (stage 12)
- Public: `https://mcm.${BASE_DOMAIN}` BFF health (`/bff-api/auth/init` → `{"ok":true}`) and
  `https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration`
  (issuer = `https://auth.${BASE_DOMAIN}/realms/grumpyrobot`).
- Internal (via Komodo periphery / a probe job on the prod daemon): `mc-service` `/health` (`:3001`)
  and `/metrics`, agent-gateway health. The BFF being up no longer proves the app works — gate on
  the data layer too.

### 5.6 Rollback-on-fail (stage 12 failure path)
- On health-gate timeout: re-commit the **prior** `*_DIGEST` captured in 5.3 (or `git revert` the
  promotion commit) and re-fire the sync webhook; re-probe. Fail the job loudly so you see it.

### 5.7 Flip the hand-set digests (R7)
- Once 5.1–5.6 run green end to end, remove any hand-set image/digest overrides from the Stacks'
  Komodo environment so the values come from the CI-written `.env.deploy` only.

> **Two-step promotion (PRD §2.6, optional):** deploy `prod-data`/`prod-app` to a staging stack on
> the prod daemon, smoke-test, then promote — so a bad build never touches real prod data. If
> skipped now, the health-gate + rollback is the v1 safety net; leave a note.

---

## 6. Komodo as config-as-code — Resource Sync (replaces the click-ops)

Instead of hand-creating Stacks/webhooks in the UI, declare them as **TOML in the repo** and let a
Komodo **Resource Sync** diff-and-apply (`deploy = true` + `after` → it also deploys, in order).
Click-ops collapses to a **one-time bootstrap**; everything after is `git push` → reconcile, same
git-style model as the rest of the buildout.

### 6.1 Where the TOML lives + naming
Directory: **`infrastructure-as-code/komodo/`**. Komodo's sync `resource_path` can point at a whole
directory and merges every `*.toml` it finds, so file names are for *humans*, not Komodo — group by
resource type. Suggested:

```
infrastructure-as-code/komodo/
  stacks.toml        # the 4 [[stack]] blocks (prod-auth, prod-data, prod-app, prod-agents)
  repo.toml          # OPTIONAL: the [[repo]] resource, if you sync it instead of UI-creating it
```

(A single `komodo.toml` works too; splitting by type just reads better in diffs.) Do **not** commit a
`variables.toml` carrying secret values — variables are seeded once in Komodo (§6.3).

### 6.2 The sanitization strategy (keep host / domain / IP out of git)
The raw export leaks four things you don't want committed: the tailnet host
(`…ts.net:3000` in `git_provider` **and** inside every image ref), the base domain, the Tailscale
admin IP, and the real secrets. Strategy — three layers, all of which keep the committed TOML clean:

1. **Git host → a `Repo` resource, not inline.** Register the Forgejo git provider once (Settings →
   Providers → Git) and create one **`Repo`** resource named `mcm-repo` holding
   `git_provider`/`git_account`/`repo` (i.e. the tailnet host lives **there**, created at bootstrap,
   **not** in synced TOML). Each `[[stack]]` then uses `linked_repo = "mcm-repo"` + a `branch` — a
   name and a branch, no host string. (Komodo's TOML export already replaces linked-repo IDs with
   this name.)
2. **Domain / admin IP / registry host → Komodo Variables, interpolated.** `[[VARIABLE]]` resolves
   at deploy time, so the committed TOML carries only the token. Seed `BASE_DOMAIN`, `TAILNET_HOST`,
   `TS_ADMIN_IP`, `REGISTRY_HOST` (= `[[TAILNET_HOST]]:3000`) once in Komodo (mark **secret** so they
   never surface in logs / to non-admins). Use them in stack `environment` and in `KC_HOSTNAME_ADMIN`.
3. **Image refs → host-free `.env.deploy` (R10).** Don't put `…_IMAGE=<host>/…@sha256` anywhere in the
   synced TOML. The committed `.env.deploy` carries **bare** `*_DIGEST=sha256:…`; the compose assembles
   `image: ${REGISTRY_HOST}/jumbleknot/<svc>@${<SVC>_DIGEST}`. Host out of git, digests in git, CI
   rewrites the digests. Secrets stay `[[name]]` Komodo variables as today.

> **One thing to verify before relying on it:** that `[[VARIABLE]]` interpolation resolves inside the
> field you use it in. It's documented to work in stack `environment` (certain); the `linked_repo`
> route deliberately avoids needing it in the structured `git_provider` field, which is the one place
> interpolation support is unconfirmed. If you'd rather inline git config, test `[[TAILNET_HOST]]` in
> `git_provider` against one stack first.

### 6.3 Sanitized `stacks.toml` (drop-in template from your export)
```toml
# infrastructure-as-code/komodo/stacks.toml
# Real host/domain/IP/secrets live in Komodo Variables ([[...]]) or the mcm-repo Repo — never here.

[[stack]]
name = "prod-auth"
deploy = true
after = []                                   # root of the order
[stack.config]
server = "Local"
linked_repo = "mcm-repo"                     # holds git host/account/repo (bootstrap, not synced)
branch = "022-prod-public-hostname-auth"
run_directory = "infrastructure-as-code/docker/keycloak"
file_paths = ["compose.prod.yaml"]
env_file_path = ".env.prod"
environment = """
BASE_DOMAIN=[[BASE_DOMAIN]]
KC_ADMIN_BIND_IP=[[TS_ADMIN_IP]]
KC_HOSTNAME_ADMIN=http://[[TAILNET_HOST]]:8099
KC_BOOTSTRAP_ADMIN_PASSWORD=[[KC_BOOTSTRAP_ADMIN_PASSWORD]]
KC_DB_PASSWORD=[[KC_DB_PASSWORD]]
PROD_REALM_FILE=/home/prod/keycloak/prod-realm.rendered.json
"""

[[stack]]
name = "prod-data"
deploy = true
after = ["prod-auth"]                        # waits for Keycloak (JWKS) to be up
[stack.config]
server = "Local"
linked_repo = "mcm-repo"
branch = "022-prod-public-hostname-auth"
run_directory = "infrastructure-as-code/docker/mc-service"
file_paths = ["compose.prod.yaml"]
env_file_path = ".env.prod"
environment = """
BASE_DOMAIN=[[BASE_DOMAIN]]
REGISTRY_HOST=[[TAILNET_HOST]]:3000
MC_DB_PASSWORD=[[mc_db_password]]
"""

[[stack]]
name = "prod-app"
deploy = true
after = ["prod-data"]
[stack.config]
server = "Local"
linked_repo = "mcm-repo"
branch = "022-prod-public-hostname-auth"
run_directory = "infrastructure-as-code/docker/bff"
file_paths = ["compose.prod.yaml"]
env_file_path = ".env.prod"
environment = """
BASE_DOMAIN=[[BASE_DOMAIN]]
REGISTRY_HOST=[[TAILNET_HOST]]:3000
KEYCLOAK_CLIENT_SECRET=[[mcm_keycloak_client_secret]]
KEYCLOAK_SERVICE_CLIENT_SECRET=[[mcm_keycloak_service_client_secret]]
COOKIE_SECRET=[[mcm_cookie_secret]]
AGENT_CONFIG_ENC_KEY=[[mcm_agent_config_enc_key]]
AGENT_SUBJECT_TOKEN_CLIENT_SECRET=[[mcm_agent_subject_token_client_secret]]
"""
# NOTE: no MCM_BFF_IMAGE here — digest comes from committed host-free .env.deploy (R10).

[[stack]]
name = "prod-agents"
deploy = true
after = ["prod-data"]
[stack.config]
server = "Local"
linked_repo = "mcm-repo"
branch = "022-prod-public-hostname-auth"
run_directory = "infrastructure-as-code/docker/agents"
file_paths = ["compose.prod.yaml"]
env_file_path = ".env.prod"
environment = """
BASE_DOMAIN=[[BASE_DOMAIN]]
REGISTRY_HOST=[[TAILNET_HOST]]:3000
AGENT_DB_PASSWORD=[[agent_db_password]]
ANTHROPIC_API_KEY=[[anthropic_api_key]]
"""
```

### 6.4 One-time bootstrap (B1/B2 — the only click-ops left)
1. **Register the git provider** (Settings → Providers → Git): the Forgejo host + `jumbleknot` PAT
   (already done in Phase 11) and create the **`mcm-repo`** Repo resource.
2. **Seed Variables** (Settings → Variables), all **masked**: `BASE_DOMAIN`, `TAILNET_HOST`,
   `TS_ADMIN_IP`, plus every per-stack secret (`mc_db_password`, `mcm_keycloak_client_secret`,
   `mcm_keycloak_service_client_secret`, `mcm_cookie_secret`, `mcm_agent_config_enc_key`,
   `mcm_agent_subject_token_client_secret`, `agent_db_password`, `anthropic_api_key`,
   `KC_BOOTSTRAP_ADMIN_PASSWORD`, `KC_DB_PASSWORD`).
3. **Create the `ResourceSync`** pointing at `mcm-repo` + `resource_path = infrastructure-as-code/komodo`.
   Enable its **git webhook** (one URL → push reconciles + deploys). The signature secret is the
   global `KOMODO_WEBHOOK_SECRET` already in `compose.env`.

### 6.5 Pre-create external networks/volumes (prod shell)
Create the shared internal app network + agent network and any missing volumes on the **prod**
daemon, then mark them `external: true` in the composes (R1/R2). Mongo/Postgres data volumes are
external/pre-existing → the DB password must match what they were first initialised with.

### 6.6 Forgejo Actions vars/secrets (Forgejo UI)
- `KOMODO_WEBHOOK_URL` = the **ResourceSync** webhook URL (one, not per-stack) — variable.
- `KOMODO_WEBHOOK_AUTH` = the global `KOMODO_WEBHOOK_SECRET` value — **secret**.
- Confirm present (runbook §10.3): `REGISTRY_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TEST_USER`,
  `E2E_TEST_PASSWORD`, `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`, `KEYCLOAK_*`, `COOKIE_SECRET`.

> Operator note: Komodo/Keycloak-admin/Cloudflare are persistent-connection SPAs — Claude-in-Chrome
> times out on them, so the bootstrap above is yours. But it's **once**; after it, deploys are pushes.

---

## 7. Verification (stage 12 + Phase 16)

1. Push to the deploy branch → Forgejo Actions runs **1–8 green** (Maestro agent flows pass on KVM).
2. CD: images build, **Trivy** clean, push succeeds; `.env.deploy` gets a new digest commit from
   the CI identity for each changed service.
3. The sync webhook fires; Komodo reconciles + redeploys the affected stack(s) in `after` order;
   `docker ps` on prod shows each service on its new digest.
4. **Stack health:** `prod-data` `mc-service` `/health` green; BFF + auth public health green; agent
   gateway health green — all over the right (internal vs. tunnel) path.
5. **Real app data (the actual gap this closes):** off-network on the prod APK, **create a movie**
   and **list it back** (proves `mcm-app → BFF → mc-service → mc-db`), then run one **agent flow**
   (proves token-exchange → `movie-mcp` → `mc-service`).
6. **Rollback drill:** force one failed deploy and confirm the job re-deploys the prior digest and
   the app recovers.
7. Flip the `pull_request` trigger on only after the first green push run.

---

## 8. Open items / risks to resolve in-repo

- **Verify `[[var]]` interpolation scope** — confirmed for stack `environment`; test once that it
  resolves where you use it. The `linked_repo` design avoids needing it in `git_provider`; if you
  inline git config instead, prove `[[TAILNET_HOST]]` works there first (§6.2 caveat).
- **Map each `*_DIGEST` to its stack** — confirm the six images in `.env.deploy` (which is the
  APK/web build) and that each prod compose builds `${REGISTRY_HOST}/…@${…_DIGEST}` from it.
- **Exact prod compose layout** — confirm dir/file names under `infrastructure-as-code/docker/`
  for the data + agents stacks, and which shared internal networks already exist vs. need creating.
- **`migrate the existing two stacks` to the sync** — `prod-auth`/`prod-app` already exist in
  Komodo's DB; the first sync should **adopt** them (same names) rather than create duplicates.
  Export them to TOML (you've confirmed copy-paste works), sanitize per §6.2, and diff before apply.
- **Token-exchange config in prod** — the agent chain needs Keycloak RFC 8693 token exchange
  (`aud=mc-service`, short TTL) + OPA authorization wired for the **prod** realm/clients, not just
  dev. Confirm the prod realm carries the exchange policy (it was sanitized on export).
- **Exact webhook body shape Komodo expects** — confirm the minimal GitHub-shaped JSON
  (`ref: refs/heads/<branch>`) the ResourceSync webhook accepts and that the HMAC is over the raw
  body bytes. Probe once against the real sync before trusting the workflow.
- **CI git push identity** — `cd-deploy.yml` commits to the deploy branch; give it a scoped Forgejo
  token + bot identity and guard with `[skip ci]`/path/author filter so the digest-only commit
  doesn't retrigger the full E2E loop.
- **Secret-scan/naming gates** — ensure `secret-scan.yml` + `naming-gate.yml` run in the Forgejo
  pipeline so a real credential can never reach the registry/commit (Phase 12). Extend the scan to
  the `komodo/*.toml` so a real host/domain/IP can't slip in past the `[[var]]` discipline.
- Remove the stray manual `git clone` at `/home/prod/mcm` (Komodo manages its own checkout).

---

## 9. Recommended order of work

1. **Claude Code:** author `prod-data` + `prod-agents` composes (R1/R2), extend BFF compose (R3),
   host-free `.env.deploy` (R10), and the `komodo/*.toml` sync files (R9, §6.3 template); confirm/
   port CI (R4, R8) → green on push.
2. **You (one-time bootstrap):** register the git provider + `mcm-repo` Repo and seed the masked
   Variables (B1/B2); pre-create external nets/vols (M1).
3. **You:** create the `ResourceSync` → run it. It adopts `prod-auth`/`prod-app` and deploys
   `prod-data`/`prod-agents` in `after` order (M2). **Verify the app actually serves data** (movie
   create/list) *before* automating anything.
4. **Claude Code:** write `cd-deploy.yml` (R5/R6) — all-digest promotion, single sync webhook,
   health-gate + rollback; leave the webhook URL as a placeholder.
5. **You:** enable the ResourceSync webhook, add `KOMODO_WEBHOOK_URL` + `KOMODO_WEBHOOK_AUTH`,
   confirm the other Actions secrets (M3/M4).
6. **Claude Code:** flip every digest to CI-written `.env.deploy` (R7); first full green run.
7. **Both:** verification §7 — including a real create-a-movie + agent flow and a rollback drill.
8. Mark **Phase 15 complete** in the runbook + memory; flip the PR-gate trigger on.
