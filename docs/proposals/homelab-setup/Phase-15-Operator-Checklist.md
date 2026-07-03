# Phase 15 — Operator Checklist (bring the full app live + finish 022/023)

Companion to [Phase-15-Work-Order.md](./Phase-15-Work-Order.md). All repo-side authoring is DONE
(branch `022-prod-public-hostname-auth`, commits `f193c7f` Milestone A + `6fe4e4a` Milestone B). This
is the operator/runtime work that only you can do (Komodo / Keycloak-admin / prod shell — Claude can't
drive those SPAs). Work top-to-bottom; each `[ ]` is one action.

Two paths are offered. **Path 1 (recommended)** brings the full app live with the LEAST blast radius —
it adds the two new stacks as manual Komodo Stacks (mirroring the live prod-mcm-bff) and never touches
the live auth/BFF. **Path 2** migrates everything to the config-as-code ResourceSync (the eventual clean
state). Do Path 1 first to prove the app, then Path 2 to consolidate.

> **Status 2026-07-02 — full app LIVE, agent works end-to-end.** Off-network login (web + mobile) works
> and the movie assistant searches the user's collection + adds movies (subject-token → token-exchange →
> `movie-mcp` → `mc-service` proven). Naming converged with `stacks.toml`: the `prod-app → prod-mcm-bff`
> rename cutover is **DONE** (manual, external vols/nets preserved), all 4 stacks match the TOML, and the
> topology/domain literals are now Komodo Variables. **Remaining: Step C (validate CD `deploy=true`) +
> Step E (T021/T037/T039).** Fresh-session handoff at the bottom of this file.

Real values you'll need (keep them out of git — Komodo/Keycloak only). Komodo Variable names
(case-sensitive) **as they now exist** — the agent secrets use UPPER_SNAKE (matching the env var they
fill); the BFF Keycloak/cookie/enc secrets keep their lowercase `mcm_*` names:

- `REGISTRY_HOST` = `<tailnet-host>:3000` — its own Variable (full host:port), used by every stack
- `TAILNET_HOST` = `<tailnet-host>` — bare host; only prod-auth's `KC_HOSTNAME_ADMIN=http://[[TAILNET_HOST]]:8099`
- `BASE_DOMAIN` = `${BASE_DOMAIN}` · `TS_ADMIN_IP` = prod Tailscale IPv4 (`tailscale ip -4`)
- `AGENT_GATEWAY_CLIENT_SECRET` — Keycloak admin → realm `grumpyrobot` → Clients → **agent-gateway** → Credentials
- `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` — Keycloak admin → Clients → **agent-subject-token** → Credentials
- `AGENT_DB_PASSWORD` — you choose (fresh volume); reuse if the volume was already initialised
- `mcm_keycloak_client_secret`, `mcm_keycloak_service_client_secret`, `mcm_cookie_secret`, `mcm_agent_config_enc_key`

---

## Step A — prod daemon prep (T038)

On the **prod** rootless daemon shell (`ssh prod@homelab`, `DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock`):

- [x] Create the new internal networks (idempotent — ignore "already exists"):
      `docker network create movie-assistant-mcp-network`
      `docker network create mc-service-network`  ← private DB link: isolates mc-service-store-mongo so
      only mc-service reaches it (defense-in-depth, matches the prod-mcm-bff Mongo pattern)
- [x] Confirm the shared nets exist (prod-mcm-bff already uses them):
      `docker network ls | grep -E 'backend-network|mcm-bff-network|edge-network|keycloak-network'`
- [x] Confirm the data volumes exist (runbook Phase 5 pre-provisioned them):
      `docker volume ls | grep -E 'mc-service-store-mongo-data|movie-assistant-store-postgres-data'`
      — if missing: `docker volume create mc-service-store-mongo-data` /
      `docker volume create movie-assistant-store-postgres-data`
- [x] (No `mc_db` credential — prod-mc-service Mongo is unauthenticated, internal-only, like the live BFF Mongo.)

---

## Step B — bring the full app live (Path 1: manual stacks)

### B1. Set the BFF subject-token secret (enables the agent chain)

The live **prod-mcm-bff** Stack left `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` empty (agents weren't deployed).
Now it must mint the run-scoped subject token the gateway re-exchanges.

- [x] Komodo → Stack **prod-mcm-bff** → Environment → `AGENT_SUBJECT_TOKEN_CLIENT_SECRET=[[AGENT_SUBJECT_TOKEN_CLIENT_SECRET]]`
- [x] Redeploy prod-mcm-bff. Confirm `https://mcm.${BASE_DOMAIN}/bff-api/auth/init` → `{"ok":true}`.

> **Root cause found 2026-07-02 (agent was TMDB-only).** The value must not merely be *present* — it must
> **equal the `agent-subject-token` client secret in the DEPLOYED realm**. The realm import ships no
> `"secret"`, so Keycloak GENERATES a random one; a wrong/placeholder value makes the RFC 8693 mint fail
> with **HTTP 401 invalid_client** (BFF logs `Agent subject-token exchange failed status:401` +
> `Proceeding without agent subject token`). With no subject token, `invoke_tool` short-circuits every
> `needs_token` tool ("No caller identity") → **zero `movie-mcp` calls** → `list_collections()` empty →
> the agent falls back to TMDB and can't resolve the current collection. The gateway's re-exchange has the
> SAME requirement: `AGENT_GATEWAY_CLIENT_SECRET` (prod-movie-assistant) must equal the **agent-gateway**
> client's generated secret or the next hop (aud=`mc-service`) 401s identically. **Fix both** by copying
> each client's *Credentials* secret from the Keycloak console into the matching Komodo Variable, then
> redeploy. (These are supplied via Komodo Variables → the Stack Environment; Komodo writes the interpolated
> `.env.prod` itself — you never hand-edit that file.)

### B2. New Stack: prod-mc-service (deploy BEFORE the BFF needs data; needs Keycloak up)

- [x] Komodo → Create Stack:
      - Name: `prod-mc-service`
      - Git repo: the `mcm` repo (same provider as prod-mcm-bff) · Branch: `022-prod-public-hostname-auth`
      - **Run Directory:** `infrastructure-as-code/docker/mc-service`
      - **File Paths:** `compose.prod.yaml`
      - **Env File Path:** `.env.prod`
      - **Additional Env Files:** `.env.deploy`
      - **Environment:** `REGISTRY_HOST=<tailnet-host>:3000`
- [x] Deploy. Verify on the prod shell:
      `docker ps` → `mc-service` + `mc-service-store-mongo` both **healthy** (the Mongo self-initialises
      rs0 via its healthcheck — NO separate rs-init container, so the stack shows healthy in Komodo).
      `docker exec mc-service wget -qO- http://127.0.0.1:3001/health` → `{"status":"ok"}`.
      NOTE: if you already deployed the old version, redeploy prod-mc-service to pick up the self-init change.

### B3. New Stack: prod-movie-assistant (deploy LAST — needs mc-service + BFF Redis)

- [x] Komodo → Create Stack:
      - Name: `prod-movie-assistant`
      - Branch: `022-prod-public-hostname-auth`
      - **Run Directory:** `infrastructure-as-code/docker/agents`
      - **File Paths:** `compose.prod.yaml`
      - **Env File Path:** `.env.prod`
      - **Additional Env Files:** `.env.deploy`
      - **Environment:**
        ```
        REGISTRY_HOST=<tailnet-host>:3000
        AGENT_DB_PASSWORD=<agent db password>
        AGENT_GATEWAY_CLIENT_SECRET=<agent-gateway client secret>
        ```
        (Leave `ANTHROPIC_API_KEY` unset — feature 018 per-user BYO keys are the model.)
- [x] Deploy. Verify: `docker ps` shows `movie-assistant-gateway`, `movie-assistant-store-postgres`
      (healthy), `movie-assistant-mcp-{movie,webapi,spreadsheet}`. Gateway logs show the graph built
      with tools (not "tool-free").

### B4. Full-app smoke (the gap this closes — T039 part 1)

- [x] Off-network on the prod APK (cellular): log in, **create a movie, list it back** (proves
      `mcm-app → BFF → mc-service → mc-db`).
- [x] Configure your per-user Anthropic key in the app, run **one agent flow** that adds/searches a movie
      (proves subject-token → token-exchange → `movie-mcp` → `mc-service`).

> If the agent flow fails with a tool/auth error: check the gateway log for token-exchange — usually a
> missing `AGENT_GATEWAY_CLIENT_SECRET` (gateway) or `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` (BFF, B1).

### B5. Web login fix (discovered 2026-06-30 — mobile worked, web didn't)

Symptom: on web, "Login with Keycloak" popped `http://localhost:8099/...` and Keycloak returned
**"Invalid parameter: redirect_uri"**. Two independent bugs:

- **Authorize host (code+build — FIXED IN REPO):** the web bundle read a non-`EXPO_PUBLIC` `KEYCLOAK_URL`,
  which Metro can't inline into the browser → it always defaulted to `localhost:8099`. Now the web client
  uses `EXPO_PUBLIC_KEYCLOAK_URL`, baked at the mcm-bff web build from `https://auth.${BASE_DOMAIN}` (the
  Forgejo `BASE_DOMAIN` var, via `docker-build --build-arg`). **Action: rebuild + redeploy the mcm-bff
  image** so the web bundle carries the public host — dispatch `cd-deploy` on the latest commit (mints a
  new `mcm-bff` digest → promote → redeploy prod-mcm-bff), or rebuild manually with the build-arg set.
- **Realm redirect URI (operator):** even at the right host, Keycloak rejects the callback unless the
  client registers it. `prod-realm.json` has `https://mcm.${BASE_DOMAIN}/*`, so the deployed realm likely
  imported the **UN-rendered `${BASE_DOMAIN}` placeholder** (mobile works because `mcm-app://…` has no
  placeholder). **Action:** Keycloak admin → Clients → **movie-collection-manager** → Valid redirect URIs
  must read `https://mcm.<your-domain>/*` and Web origins `https://mcm.<your-domain>`. If it shows the
  literal `${BASE_DOMAIN}` (or is missing), either re-render `prod-realm.json` (`sed 's|${BASE_DOMAIN}|<your-domain>|g'`)
  + re-import, or add the concrete URIs directly in the admin console. Then web login works at
  `https://mcm.<your-domain>`.

---

## Step C — validate the CD `deploy=true` leg (T018/T019)

The only unexercised CD path: signed webhook → Komodo redeploy → health probe → rollback.

> **Webhook scope (which stacks need one).** A `cd-deploy` run rebuilds all 6 CI-built images and promotes
> their digests to ALL THREE stack dirs' `.env.deploy` (bff, mc-service, agents). A Komodo redeploy webhook
> only fires the stack it's attached to, so a webhook on **only prod-mcm-bff** means only the BFF picks up
> its new digest — **prod-mc-service and prod-movie-assistant keep running their old images** (their
> `.env.deploy` says one digest, the container runs another = silent drift). Mapping: prod-auth = Keycloak
> (upstream image, **never CI-built → no webhook**); prod-mc-service (`mc-service`), prod-mcm-bff
> (`mcm-bff`), prod-movie-assistant (`agent-gateway` + 3 MCPs) = all CI-built → all need to redeploy.
>
> - **For THIS validation:** prod-mcm-bff's webhook alone is sufficient — the probe checks the BFF
>   (`issuer` + `mcm.` 200), so it proves the webhook → probe → git-revert-rollback mechanism end-to-end.
> - **For steady-state full-app deploys, choose ONE:** (a) **interim** — enable the redeploy webhook on
>   prod-mc-service + prod-mcm-bff + prod-movie-assistant and list ALL three URLs in the Forgejo
>   `KOMODO_WEBHOOK_URL` var (cd-deploy loops over whitespace/newline-separated URLs); **no deploy-order
>   guarantee** across them (`after:` only applies to ResourceSync), tolerable for digest bumps since
>   containers retry. (b) **target (recommended)** — adopt **Step D ResourceSync** and point
>   `KOMODO_WEBHOOK_URL` at the single ResourceSync webhook: one push reconciles + redeploys all affected
>   stacks IN `after` ORDER, no drift, no multi-URL upkeep. Given Step D is the required follow-on, prefer
>   (b) over maintaining three webhook URLs.

- [x] Komodo → prod-mcm-bff Stack → enable its **redeploy webhook**; copy the URL. (Sufficient for THIS
      validation; see the webhook-scope note above for the full-app case.)
- [x] Forgejo → repo → Settings → Actions → Variables/Secrets:
      `KOMODO_WEBHOOK_URL` (var) = that webhook URL · `KOMODO_WEBHOOK_AUTH` (secret) = the global
      `KOMODO_WEBHOOK_SECRET` value from `/home/prod/komodo/compose.env`. (`BASE_DOMAIN` var already set.)
- [ ] Dispatch CD with deploy=true (API — the UI won't list `cd-deploy` until it's on `main`):
      `POST /api/v1/repos/jumbleknot/mcm/actions/workflows/cd-deploy.yml/dispatches`
      body `{"ref":"022-prod-public-hostname-auth","inputs":{"deploy":"true"}}` with a **`write:repository`** token.
- [ ] Confirm: digest promoted to `.env.deploy` `[skip ci]` → webhook fires → Komodo redeploys →
      probe (issuer + `mcm.` 200) passes.
- [ ] Rollback drill: induce a probe failure (e.g. temporarily point `BASE_DOMAIN` wrong, or push a bad
      digest) → confirm cd-deploy git-reverts the promotion and re-fires → app recovers.
- [ ] 🚨 **Revoke the `write:repository` token** when done.

---

## Step D — config-as-code consolidation (Path 2: ResourceSync, T036) — REQUIRED follow-on

Path 1 and Path 2 are sequential phases, not either/or. Path 1 proves the app with least risk; **Path 2
is required** to reach the target state (config-as-code + consistent naming). **Update 2026-07-02:** the
`prod-app → prod-mcm-bff` rename and the variable-name convergence were already done MANUALLY (below), so
the pending ResourceSync now **adopts all 4 same-named stacks in place** — no create-from-scratch, smaller
blast radius. Applying the first sync still redeploys all 4 in `after` order (brief downtime across
auth/BFF), so treat it as a maintenance window.

- [x] Komodo → Settings → Variables — seeded (mark **secret**). Names are case-sensitive and match the
      `[[token]]`s in stacks.toml **as converged 2026-07-02**:
      - `BASE_DOMAIN` = `${BASE_DOMAIN}`
      - `REGISTRY_HOST` = `<tailnet-host>:3000`  (its OWN Variable — no longer derived from TAILNET_HOST)
      - `TAILNET_HOST` = `<tailnet-host>`  (bare host — only prod-auth's `KC_HOSTNAME_ADMIN`)
      - `TS_ADMIN_IP` = prod host Tailscale IPv4 (`tailscale ip -4` on prod)
      - `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD` (same values prod-auth already uses)
      - `mcm_keycloak_client_secret`, `mcm_keycloak_service_client_secret`, `mcm_cookie_secret`,
        `mcm_agent_config_enc_key`
      - `AGENT_SUBJECT_TOKEN_CLIENT_SECRET`, `AGENT_GATEWAY_CLIENT_SECRET`, `AGENT_DB_PASSWORD`
        (UPPER_SNAKE — renamed from the earlier lowercase `agent_*` to mirror the env var they fill)
      - (NOT `mc_db_password`, NOT `anthropic_api_key` — unused.)
- [ ] Komodo → Settings → Providers → Git: confirm the Forgejo provider + `jumbleknot` PAT (Phase 11).
      Create a **Repo** resource named **`mcm-repo`** (git provider/account/repo + branch) — this holds
      the tailnet host so the TOML stays host-free.
      > Token hygiene: the git-provider PAT is `komodo-git-read` (`read:repository`) and the image pull
      > uses `komodo-registry-read` (`read:package`) — see Server-Setup-Runbook **§6.5** (token inventory).
      > Komodo never needs write.
- [ ] Komodo → create a **ResourceSync**: `linked_repo = mcm-repo`,
      `resource_path = infrastructure-as-code/komodo`. **Preview the diff before applying.**
- [x] **Rename cutover — DONE MANUALLY 2026-07-02** (Komodo overrides compose `name:` with the Stack
      name). Created a new `prod-mcm-bff` Stack, downed `prod-app`, `docker rm -f mcm-bff-service
      mcm-bff-cache-redis mcm-bff-store-mongo` (containers only — the `external: true` vols
      `mcm-bff-store-mongo-data`/`mcm-bff-cache-redis-data` and nets survived, so the saved per-user agent
      keys were preserved), deployed `prod-mcm-bff`, verified login + agent, deleted the old `prod-app`
      record. All 4 stacks now match `stacks.toml` names → the ResourceSync will adopt them in place.
- [ ] Apply the sync → it deploys `prod-auth → prod-mc-service → prod-mcm-bff → prod-movie-assistant` in
      order. Re-run the Step B4 smoke.
- [ ] Enable the **ResourceSync** git webhook (one URL); repoint Forgejo `KOMODO_WEBHOOK_URL` to it
      (push → reconcile + deploy all affected stacks). **This replaces the per-stack redeploy webhooks**
      from Step C and closes the multi-stack drift gap (see Step C's webhook-scope note): one URL redeploys
      every affected stack in `after` order, so a CD run that bumps the mc-service or agent digests no
      longer leaves those stacks on stale images. After repointing, disable the individual stack webhooks.

---

## Step E — finish 022/023

- [x] **Token least-privilege** (Forgejo tokens): registry split **DONE 2026-07-01** — `actions-ci-push`
      (`write:package`, CI push only) + `komodo-registry-read` (`read:package`, prod pull only); all tokens
      rotated. **Remaining:** revoke `claude-cicd-debug` (`write:repository`) once the current CI-push
      verification finishes. Inventory in **Server-Setup-Runbook §6.5**; rotation procedure in §6.6.
- [ ] **T021** Forgejo → `main` branch protection → required status checks = `guardrails` + `app-ci`.
- [ ] **T037** Merge `022-prod-public-hostname-auth` → `main` (auto-fires `cd-deploy` deploy path).
      Confirm **T022**: the GitHub mirror runs **no** Actions; `.github/workflows` is empty.
- [ ] **T039** final: re-run the create-a-movie + agent-flow smoke against the merged `main` deploy +
      one rollback drill. Mark Phase 15 complete in the runbook + memory.

---

### Quick reference — deploy order & dependencies

```
prod-auth (Keycloak healthy — JWKS)
  └─► prod-mc-service (mongo self-inits rs0 via healthcheck → mc-service; needs Keycloak)
        └─► prod-mcm-bff (BFF; needs mc-service + Keycloak; public mcm.)
              └─► prod-movie-assistant (gateway+MCPs; needs mc-service via movie-mcp,
                                        Keycloak token-exchange, AND prod-mcm-bff's
                                        mcm-bff-network/Redis for spreadsheet-mcp)
```

Secrets map (Komodo Variable names as of 2026-07-02):

- prod-auth: `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD` · `BASE_DOMAIN`, `TS_ADMIN_IP`, `TAILNET_HOST`
- prod-mcm-bff: `mcm_keycloak_client_secret`, `mcm_keycloak_service_client_secret`, `mcm_cookie_secret`,
  `mcm_agent_config_enc_key`, `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` · `BASE_DOMAIN`
- prod-movie-assistant: `AGENT_DB_PASSWORD`, `AGENT_GATEWAY_CLIENT_SECRET`
- prod-mc-service: none (unauthenticated internal Mongo)
- every stack: `REGISTRY_HOST` (its own Variable = `<host>:3000`, for the host-free image digest)

---

## Fresh-session handoff (2026-07-02) — close out 022/023

**Where we are:** the full app is LIVE in prod and the **movie assistant works end-to-end** (searches the
user's collection + adds movies). The last blocker — the agent being TMDB-only — was an RFC 8693 mint
**401 invalid_client** because the `agent-subject-token` / `agent-gateway` Komodo Variables didn't match
the realm-generated client secrets (see Step B1 note). Naming has converged with `stacks.toml`, the
`prod-app → prod-mcm-bff` rename cutover is done, and prod-auth's UI env now uses `[[BASE_DOMAIN]]` /
`[[TS_ADMIN_IP]]` / `[[TAILNET_HOST]]`.

**Uncommitted (on branch `022-prod-public-hostname-auth`, saved to disk — commit these first):**

- `infrastructure-as-code/komodo/stacks.toml` — `[[REGISTRY_HOST]]` + UPPER_SNAKE agent-secret vars
- `infrastructure-as-code/docker/bff/.env.prod.example` — 401 root-cause note on `AGENT_SUBJECT_TOKEN_CLIENT_SECRET`
- `docs/proposals/homelab-setup/Phase-15-Operator-Checklist.md` — this update
- (verify with `git status`; commit on the 022 branch, do NOT merge yet — see order below)

**Remaining work, in order:**

1. **Commit** the above on `022-prod-public-hostname-auth`.
2. **Step C — validate CD `deploy=true`** (the one unexercised CD leg: signed webhook → Komodo redeploy →
   health probe → rollback). Dispatch via API (UI won't list `cd-deploy` until it's on `main`):
   `POST /api/v1/repos/jumbleknot/mcm/actions/workflows/cd-deploy.yml/dispatches`
   body `{"ref":"022-prod-public-hostname-auth","inputs":{"deploy":"true"}}` with a `write:repository`
   token. Confirm promote → webhook → probe passes; run the rollback drill; **revoke the write token after.**
3. **Step E — T021** `main` branch protection (required checks `guardrails` + `app-ci`).
4. **Step E — T037** merge `022-prod-public-hostname-auth` → `main` (auto-fires `cd-deploy`); confirm
   **T022** the GitHub mirror runs no Actions (`.github/workflows` empty).
5. **Step E — T039** final smoke against the merged `main` deploy (create-a-movie + one agent flow) + one
   rollback drill. Mark Phase 15 complete in the runbook + memory.
6. **Step D (optional/target-state) — ResourceSync consolidation** (config-as-code): create the `mcm-repo`
   Repo resource + the ResourceSync (`resource_path = infrastructure-as-code/komodo`), preview the diff,
   apply (adopts all 4 same-named stacks in place), then repoint `KOMODO_WEBHOOK_URL` to the sync webhook.
   Can be done after the merge.

**Load-bearing gotchas for the next session:**

- **Never commit** the real base domain (`<domain>`) or tailnet host (`<tailnet-host>`) — the
  topology-scrub + secret-scan gates block them. Real host/domain/IP live only in Komodo Variables /
  Keycloak, referenced as `[[VAR]]` in `stacks.toml`. Run `node scripts/check-topology-scrub.mjs`
  before committing infra files.
- **Komodo writes `.env.prod`** from each Stack's Environment block — never hand-edit that file on the host.
- CD is **dispatched by API** (write token `~/.mcm/forgejo-write-token`); status via `~/.mcm/mcm-ci.sh` /
  `/actions/tasks` (read token `~/.mcm/forgejo-ci-token`); container logs only via `ssh ci@homelab` /
  `ssh prod@homelab` with `DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock`.
- Any confidential Keycloak client whose secret isn't pinned in the realm JSON gets a **fresh random secret
  on import** — always copy the post-import Credentials secret into the consuming Komodo Variable.
