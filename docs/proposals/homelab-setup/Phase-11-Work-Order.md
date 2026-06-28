# Phase 11 Work Order — Keycloak & BFF production config for the public hostname

**Repo:** `jumbleknot/mcm` (Forgejo, org `jumbleknot`)
**Target:** make external mobile login work over `mcm.${BASE_DOMAIN}` / `auth.${BASE_DOMAIN}`
**Run this in:** Claude Code on the dev box (full repo access). Commit config as code; let
Forgejo Actions build and Komodo deploy. Do **not** hand-run compose on the prod host.

---

## 0. Environment facts (confirmed this session)

- **Domain:** `${BASE_DOMAIN}`. Public hosts: `mcm.` (BFF), `auth.` (Keycloak).
- **Ingress:** Cloudflare Tunnel, **direct edge-TLS** (Cloudflare terminates TLS; `cloudflared`
  dials the container over plain HTTP on the shared external Docker network **`edge-network`**).
  `cloudflared` runs at `/home/prod/cloudflared/compose.yaml`, remotely-managed token tunnel
  `homelab-prod`; routes are added in the Cloudflare Zero Trust dashboard (tunnel → Routes →
  Published application).
- **Tailnet:** `server.tailnet.ts.net`. Admin UIs are tailnet-only.
- **Keycloak:** `quay.io/keycloak/keycloak:26.5.5` (v2 hostname semantics).
  Dev compose: `infrastructure-as-code/docker/keycloak/compose.yaml`, now **included by the
  `auth` named stack** (feature 020) at `infrastructure-as-code/docker/stacks/auth.compose.yaml`,
  brought up via `pnpm nx up-auth infrastructure-as-code` (its own Compose project, the retired
  root aggregator is gone). Services `keycloak-store-postgres`, `keycloak-service`,
  `keycloak-mailpit`; networks `keycloak-network` + `backend-network`, both external. DB password
  via the Docker secret `./secrets/keycloak_db_password.txt` + `.env.local`; the admin password is
  externalized (feature 021) to `${KC_BOOTSTRAP_ADMIN_PASSWORD:?…}` sourced from gitignored
  `stacks/auth.env` (minted by `node scripts/gen-dev-secrets.mjs`), admin user via
  `KC_BOOTSTRAP_ADMIN_*`.
- **Realm:** `grumpyrobot`, client `movie-collection-manager`, client roles `mc-admin` /
  `mc-user`, self-registration defaults to `mc-user`. **There is no realm JSON in the repo** —
  it lives only in the dev Keycloak DB. Helper scripts exist:
  `infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs` and
  `configure-token-exchange.mjs`.
- **BFF:** custom image `mcm-bff` (port 8082), needs Redis for its session store.

---

## 1. ORDER — build the pipeline first, then deploy 022 through it

The CI/CD pipeline is **implemented (feature 023)**: Forgejo Actions builds + pushes images
(`app-ci.yml`, `cd-deploy.yml`) and Komodo redeploys prod on the run's digest. The old "Phase 15
not done" blocker is gone — the order is **inverted**: the pipeline exists first, and feature 022
deploys *through* it rather than hand-deploying ahead of it.

- **CI/CD pipeline (feature 023)** — already wired: `cd-deploy.yml` builds + pushes the
  `mcm-bff` (and other app) images to the Forgejo registry and triggers the Komodo redeploy.
- **Keycloak is an upstream image** → its prod stack is a Komodo Stack deployed at its pinned
  upstream digest (Work items A1–A4 below).
- **`mcm-bff` is a CI-built image** → `cd-deploy.yml` produces it; the BFF prod stack and APK
  (Part B) deploy from the registry once a green run publishes the image.

**Order:** the CI/CD pipeline (feature 023) is in place → then deploy 022's prod config through
it: finish Part A (Keycloak path), then Part B (BFF + prod APK, built by Forgejo Actions), then
C + D.

---

## 2. Deliverables — code vs. manual

| # | Item | Code in repo? | Built/deployed by the pipeline (023)? |
|---|------|---------------|----------------------|
| A1 | Keycloak `compose.prod.yaml` | yes | deployed by Komodo (upstream image, pinned digest) |
| A2 | `.env.prod` template + secret handling | yes (template only) | — (secrets via Komodo/Vault) |
| A3 | Prod realm export → committed `prod-realm.json` + `--import-realm` | yes (one-time export from dev) | — |
| A4 | Prod redirect-URI script (web + mobile) | yes | — |
| B1 | BFF `compose.prod.yaml` (issuer, cookie domain, CORS, Redis) | yes | image built + deployed by `cd-deploy.yml` → Komodo |
| B2 | Prod APK build job baking `https://mcm.${BASE_DOMAIN}` | yes | **built by Forgejo Actions** — `cd-deploy.yml` `prod-apk` job |
| C1 | Komodo Stack(s) + webhook | manual (Komodo UI) | — |
| C2 | Cloudflare published applications (`auth.`, `mcm.`) | manual (or config-file tunnel) | — |
| C3 | Secrets into Komodo/Vault | manual | — |
| D | Off-network device login test | manual | yes |

---

## 3. Part A — Keycloak prod (deploy through the 023 pipeline)

### A1. `compose.prod.yaml`
Add `infrastructure-as-code/docker/keycloak/compose.prod.yaml` based on the dev compose with
these production deltas (a ready draft is in `keycloak-prod.compose.yaml` alongside this file):

- `command: start` (not `start-dev`).
- `KC_HOSTNAME: https://auth.${BASE_DOMAIN}`; keep `KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "true"`
  so the BFF refresh-token grant still validates while it calls `keycloak-service:8080`.
- `KC_HTTP_ENABLED: "true"` + `KC_PROXY_HEADERS: xforwarded` (edge terminates TLS).
- `KC_HOSTNAME_ADMIN: http://server.tailnet.ts.net:8099` and bind the host port to the
  **tailscale IP only** (`<tailscale-ip>:8099:8080`, from `tailscale ip -4`) — admin console
  stays off the public hostname.
- Add the external **`edge-network`** network to `keycloak-service` (cloudflared reaches it by name).
  Name ends in `-network` per the feature-019/020 convention; add it to `APPROVED_NETWORKS` in
  `scripts/check-resource-naming.mjs` + `contracts/naming-convention.md` when the compose moves into
  the tracked tree, so the naming gate passes.
- Remove `keycloak-mailpit` (SMTP stubbed — see A3); drop the published Postgres port.
- Secrets via `.env.prod` (gitignored), not `.env.local`.

### A2. `.env.prod` template
Follow the dev secrets model (features 021/022/023): commit `.env.prod.example` with
**placeholders only** (real `.env.prod` gitignored, `chmod 600`). Keys: `KC_DB_PASSWORD`,
`KC_BOOTSTRAP_ADMIN_PASSWORD`. In the prod compose every credential must be a fail-fast
`${VAR:?set in .env.prod}` reference — **no inline literal, no `${VAR:-literal}` default** (the
ready draft `keycloak-prod.compose.yaml` already does this). The matching
`secrets/keycloak_db_password.txt` must equal `KC_DB_PASSWORD`. Real values live in **Komodo/Vault**,
injected at deploy — never commit them. The two CI gates (`naming-gate.yml` →
`check-no-inline-secrets.mjs`, and `secret-scan.yml` → `secret-scan.mjs`, whole-tree) run on every
push/PR and will fail the build if a literal slips into the compose file or anywhere else, so keep
them green. Use the bootstrap admin once to create a named admin with **2FA**, then remove the
bootstrap creds.

### A3. Realm (the one true gap)
1. **Export from the working dev stack** (one-time, on the dev box):
   ```bash
   docker exec keycloak-service /opt/keycloak/bin/kc.sh \
     export --realm grumpyrobot --users realm_file --file /tmp/prod-realm.json
   docker cp keycloak-service:/tmp/prod-realm.json ./prod-realm.json
   ```
2. **Sanitize:** strip dev-only redirect URIs (`localhost:*`, `10.0.2.2`, the old `app.` host),
   strip real client secrets, dev SMTP creds, **all users**, and the embedded signing keys
   (`components."org.keycloak.keys.KeyProvider"` — so prod generates fresh keys on import). Turn
   **brute-force detection ON** (`bruteForceProtected: true`) and `registrationAllowed: false`.
3. **Stub SMTP:** leave the realm `smtpServer` empty (`{}`). Registration/verify/reset mail won't
   send until a real provider is wired — do that **before opening registration**.
4. **Parameterize the host (R11), don't bake the domain.** On client `movie-collection-manager`
   set the redirect URIs with the literal `${BASE_DOMAIN}` placeholder (NOT a concrete domain —
   history-scrub rule). Commit as `infrastructure-as-code/docker/keycloak/prod-realm.json`
   (no prod secrets). At deploy, render it to a **gitignored** concrete file with `envsubst`
   **restricted to that one var** (the realm JSON is full of Keycloak `${role_*}`/`${client_*}`
   i18n placeholders that must be left intact):

   ```bash
   envsubst '${BASE_DOMAIN}' < prod-realm.json > prod-realm.rendered.json
   ```

   Point `PROD_REALM_FILE` (in `keycloak/.env.prod`) at the absolute path of the rendered file;
   `compose.prod.yaml` mounts it read-only at `/opt/keycloak/data/import/grumpyrobot-realm.json`
   (target MUST be `<realm>-realm.json` or `--import-realm` aborts) and runs `start --import-realm`.
   Keep this **separate** from the throwaway `ci-realm.json` (feature 023 step) — confirmed: the
   CI compose imports `ci-realm.json`, never `prod-realm.json` (FR-009).

### A4. Prod redirect URIs — DONE (baked into `prod-realm.json`)

On client `movie-collection-manager` the committed realm sets:

- **Valid redirect URIs:** `https://mcm.${BASE_DOMAIN}/*` **and** `mcm-app://native-auth-callback`
  (the mobile custom-scheme callback — `NATIVE_REDIRECT_URI` in `frontend/mcm-app/src/config/keycloak.ts`).
- **Web origins:** `https://mcm.${BASE_DOMAIN}` (no wildcard).
- **Post-logout:** `+` (reuse the registered redirect URIs) — no dev `exp://localhost` survives.

> Without the mobile redirect entry, on-device login fails after the browser redirect.

---

## 4. Part B — BFF prod (deploy through the 023 pipeline)

### B1. BFF `compose.prod.yaml`
Locate the BFF compose/env in the repo and produce a prod variant that sets:
- Issuer / `ROOT_URL` → `https://auth.${BASE_DOMAIN}` (find the exact env var name in the BFF).
- Session cookie **domain** `mcm.${BASE_DOMAIN}`, flags `Secure` + `HttpOnly`.
- **CORS** allows the app origin **only** (`https://mcm.${BASE_DOMAIN}`).
- Redis session store wired (prod Redis service or existing one).
- Attach to the **`edge-network`** network so cloudflared reaches the BFF by name; no public
  port mapping. **Note:** `mcm-bff` is shorthand here — the real Compose service key follows the
  feature-019/020 convention (dev uses `mcm-bff-service-nonsecure` / `mcm-bff-service-secure`). Use
  whatever the prod BFF compose actually names the service as the cloudflared/Caddy upstream, and
  keep it consistent in the Cloudflare route (C2) and any Caddyfile.

### B2. Prod APK build
The production `build-apk.mjs` run bakes **`https://mcm.${BASE_DOMAIN}`** as the BFF URL
(HTTPS, not an IP, not `:8082`). This is built by **Forgejo Actions** — `cd-deploy.yml`'s
`prod-apk` job (feature 023) — which sources the public host from a **Forgejo variable**, not a
hard-coded literal and **not** GitHub Actions.

---

## 5. Part C — Deploy & wiring (manual, after the code lands)

- **C1 Komodo:** define a Stack for the Keycloak prod compose (pull + redeploy on webhook);
  later a Stack for the BFF/app compose. Note each Stack's webhook URL for the CI job.
- **C2 Cloudflare:** add two published applications on the `homelab-prod` tunnel —
  `auth.${BASE_DOMAIN}` → `http://keycloak-service:8080`,
  `mcm.${BASE_DOMAIN}` → `http://mcm-bff-service:3000` (the prod-app service name + port — NOT
  the dev `:8082`/`mcm-bff`). Expose **only** these two; everything else stays tailnet /
  Cloudflare Access. (Optional: switch to a config-file-managed tunnel to bring these routes
  into the repo too.)
- **C3 Secrets:** Keycloak admin + DB passwords, BFF cookie/session secrets, client secrets →
  **Komodo** (or Vault). Never git.

---

## 6. Part D — Verification

1. `https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration` returns
   `issuer: https://auth.${BASE_DOMAIN}` (not an internal host).
2. Keycloak admin console reachable **only** over the tailnet, not on the public `auth.` host.
3. BFF health reachable via `https://mcm.${BASE_DOMAIN}`; only `mcm.` + `auth.` are public.
4. **Off-network device login:** install prod APK, drop to cellular, complete the full OAuth
   round-trip (redirect to `auth.`, credentials, callback to `mcm.`, session established).
5. Re-export the final prod realm and store its secrets in Komodo/Vault.

---

## 7. Open items — RESOLVED in feature 022 implementation

- ~~Exact BFF env var names~~ → **`KEYCLOAK_PUBLIC_URL`** is the browser-issuer var
  (`env.ts: keycloakPublicUrl = KEYCLOAK_PUBLIC_URL || keycloakUrl`); internal back-channel is
  **`KEYCLOAK_URL=http://keycloak-service:8080`**. No code change. Secure cookies are driven by
  **`NODE_ENV=production`**. No cookie-domain var is needed (same-origin). **No CORS** is configured
  (app + bff-api share `mcm.${BASE_DOMAIN}`) — none added. Redis = `mcm-bff-cache-redis:6379`. All
  wired in `infrastructure-as-code/docker/bff/compose.prod.yaml` (`name: prod-app`).
- ~~Mobile OAuth callback value~~ → **`mcm-app://native-auth-callback`** (in `prod-realm.json`, A4).
- ~~`build-apk.mjs` flag for the baked BFF URL~~ → built by **feature 023 `cd-deploy.yml` `prod-apk`**
  (`APK_VARIANT=release`, `EXPO_PUBLIC_BFF_NATIVE_URL=https://mcm.${BASE_DOMAIN}` from a Forgejo var).
- Still open (operator, out of repo): manage Cloudflare routes via dashboard vs committed tunnel
  config; remove the diagnostic `/home/prod/mcm` clone once the Komodo Stack is defined.
