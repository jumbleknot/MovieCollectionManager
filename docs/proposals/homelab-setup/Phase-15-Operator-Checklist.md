# Phase 15 — Operator Checklist (bring the full app live + finish 022/023)

Companion to [Phase-15-Work-Order.md](./Phase-15-Work-Order.md). All repo-side authoring is DONE
(branch `022-prod-public-hostname-auth`, commits `f193c7f` Milestone A + `6fe4e4a` Milestone B). This
is the operator/runtime work that only you can do (Komodo / Keycloak-admin / prod shell — Claude can't
drive those SPAs). Work top-to-bottom; each `[ ]` is one action.

Two paths are offered. **Path 1 (recommended)** brings the full app live with the LEAST blast radius —
it adds the two new stacks as manual Komodo Stacks (mirroring the live prod-mcm-bff) and never touches
the live auth/BFF. **Path 2** migrates everything to the config-as-code ResourceSync (the eventual clean
state). Do Path 1 first to prove the app, then Path 2 to consolidate.

Real values you'll need (keep them out of git — they go in Komodo/Keycloak only):
- `REGISTRY_HOST` = `<tailnet-host>:3000`
- `BASE_DOMAIN` = `${BASE_DOMAIN}`
- `agent_gateway_client_secret` — Keycloak admin → realm `grumpyrobot` → Clients → **agent-gateway** → Credentials
- `mcm_agent_subject_token_client_secret` — Keycloak admin → Clients → **agent-subject-token** → Credentials
- `agent_db_password` — you choose (fresh volume); reuse if the volume was already initialised

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

- [x] Komodo → Stack **prod-mcm-bff** (still named `prod-app` if you deferred the rename) → Environment →
      add: `AGENT_SUBJECT_TOKEN_CLIENT_SECRET=<agent-subject-token client secret>`
- [x] Redeploy prod-mcm-bff. Confirm `https://mcm.${BASE_DOMAIN}/bff-api/auth/init` → `{"ok":true}`.

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
- [ ] Deploy. Verify: `docker ps` shows `movie-assistant-gateway`, `movie-assistant-store-postgres`
      (healthy), `movie-assistant-mcp-{movie,webapi,spreadsheet}`. Gateway logs show the graph built
      with tools (not "tool-free").

### B4. Full-app smoke (the gap this closes — T039 part 1)

- [ ] Off-network on the prod APK (cellular): log in, **create a movie, list it back** (proves
      `mcm-app → BFF → mc-service → mc-db`).
- [ ] Configure your per-user Anthropic key in the app, run **one agent flow** that adds/searches a movie
      (proves subject-token → token-exchange → `movie-mcp` → `mc-service`).

> If the agent flow fails with a tool/auth error: check the gateway log for token-exchange — usually a
> missing `AGENT_GATEWAY_CLIENT_SECRET` (gateway) or `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` (BFF, B1).

---

## Step C — validate the CD `deploy=true` leg (T018/T019)

The only unexercised CD path: signed webhook → Komodo redeploy → health probe → rollback.

- [ ] Komodo → prod-mcm-bff Stack → enable its **redeploy webhook**; copy the URL.
- [ ] Forgejo → repo → Settings → Actions → Variables/Secrets:
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
is required** to reach the target state (config-as-code + consistent naming), and **the `prod-app →
prod-mcm-bff` rename happens here** — it is mandatory, and only a Komodo Stack-name change effects it
(the compose `name:` is overridden by Komodo, confirmed live 2026-06-30). This is a maintenance window:
the first sync redeploys ALL 4 stacks in `after` order (brief downtime across auth/BFF too).

- [ ] Komodo → Settings → Variables — seed each (mark **secret**). Names are case-sensitive and must
      match the `[[token]]`s in stacks.toml:
      - `BASE_DOMAIN` = `${BASE_DOMAIN}`
      - `TAILNET_HOST` = `<tailnet-host>`  (REGISTRY_HOST is derived as `[[TAILNET_HOST]]:3000`)
      - `TS_ADMIN_IP` = prod host Tailscale IPv4 (`tailscale ip -4` on prod)
      - `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD` (same values prod-auth already uses)
      - `mcm_keycloak_client_secret`, `mcm_keycloak_service_client_secret`, `mcm_cookie_secret`,
        `mcm_agent_config_enc_key`, `mcm_agent_subject_token_client_secret`
      - `agent_db_password`, `agent_gateway_client_secret`
      - (NOT `mc_db_password`, NOT `anthropic_api_key` — unused.)
- [ ] Komodo → Settings → Providers → Git: confirm the Forgejo provider + `jumbleknot` PAT (Phase 11).
      Create a **Repo** resource named **`mcm-repo`** (git provider/account/repo + branch) — this holds
      the tailnet host so the TOML stays host-free.
- [ ] Komodo → create a **ResourceSync**: `linked_repo = mcm-repo`,
      `resource_path = infrastructure-as-code/komodo`. **Preview the diff before applying.**
- [ ] **Rename cutover** (Komodo overrides compose `name:` with the Stack name): the sync ADOPTS
      `prod-auth` in place, but `prod-mcm-bff` has no same-named stack to adopt. Before applying:
      `docker rm -f mcm-bff-service mcm-bff-cache-redis mcm-bff-store-mongo` (external vols/nets survive),
      then let the sync create+deploy `prod-mcm-bff`. (Delete the old manual `prod-app` Komodo Stack
      record afterward.)
- [ ] Apply the sync → it deploys `prod-auth → prod-mc-service → prod-mcm-bff → prod-movie-assistant` in
      order. Re-run the Step B4 smoke.
- [ ] Enable the **ResourceSync** git webhook (one URL); repoint Forgejo `KOMODO_WEBHOOK_URL` to it
      (push → reconcile + deploy all affected stacks).

---

## Step E — finish 022/023

- [ ] **T021** Forgejo → `main` branch protection → required status checks = `guardrails` + `app-ci`.
- [ ] **T037** Merge `022-prod-public-hostname-auth` → `main` (auto-fires `cd-deploy` deploy path).
      Confirm **T022**: the GitHub mirror runs **no** Actions; `.github/workflows` is empty.
- [ ] **T039** final: re-run the create-a-movie + agent-flow smoke against the merged `main` deploy +
      one rollback drill. Mark Phase 15 complete in the runbook + memory.

---

### Quick reference — deploy order & dependencies

```
prod-auth (Keycloak healthy — JWKS)
  └─► prod-mc-service (mongo rs0 → rs-init → mc-service; needs Keycloak)
        └─► prod-mcm-bff (BFF; needs mc-service + Keycloak; public mcm.)
              └─► prod-movie-assistant (gateway+MCPs; needs mc-service via movie-mcp,
                                        Keycloak token-exchange, AND prod-mcm-bff's
                                        mcm-bff-network/Redis for spreadsheet-mcp)
```

Secrets map (where each lives):
- prod-auth: `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD`
- prod-mcm-bff: `mcm_keycloak_client_secret`, `mcm_keycloak_service_client_secret`, `mcm_cookie_secret`,
  `mcm_agent_config_enc_key`, `mcm_agent_subject_token_client_secret`
- prod-movie-assistant: `agent_db_password`, `agent_gateway_client_secret`
- prod-mc-service: none (unauthenticated internal Mongo)
- every stack: `REGISTRY_HOST` (for the host-free image digest)
