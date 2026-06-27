# HANDOFF — Feature 023 CI on the homelab forge: autonomous driving + the mobile-E2E debug loop

**For a fresh session.** Read this, then [HANDOFF.md](./HANDOFF.md) for the original feature context. The
feature's config-as-code is authored and merged-to-branch; what remains is getting **`app-ci`'s mobile
agent flows green on the homelab runner**, which is now an interactive fix→push→observe loop you can run
**autonomously** (git push + Forgejo API + SSH to the runner).

## Branch / repo state (2026-06-27)

- Branch **`023-forgejo-cicd`**, HEAD **`580bac1`**, working tree clean. `origin` = the homelab forge
  `http://homelab.tailcd5c62.ts.net:3000/jumbleknot/mcm.git` (Tailscale); `github` = mirror. Not merged.
- **GREEN on the forge** for the latest commit: `guardrails` (secret-scan/naming/agent-gates), `affected`
  (nx affected lint+test, excludes mc-service), `mc-service-checks` (clippy + `cargo test --lib`), and the
  **web E2E (124 tests)** inside `app-ci`'s `app-e2e` job — incl. the assistant dock via an anthropic config.
- **RED**: only the **mobile agent flows** (the emulator step of `app-e2e`). See "Current failure".

## You can drive this loop autonomously

1. **Push**: `git push origin 023-forgejo-cicd` (Git Credential Manager has forge creds — works).
2. **Status** (token-based): `bash ~/.mcm/mcm-ci.sh status <sha-prefix>` → `app-e2e` status, or
   `~/.mcm/mcm-ci.sh runs 8` for raw JSON. Token at `C:\Users\Steve\.mcm\forgejo-ci-token` (outside git).
   Only `/api/v1/repos/jumbleknot/mcm/actions/tasks` works for status; **logs/artifacts are NOT exposed by
   this Forgejo's API** (all 404).
3. **Logs/screenshots** (SSH — now works non-interactively; the Tailscale ACL was flipped `check`→`accept`,
   and key `~/.ssh/homelab_ci_ed25519` is installed on `ci@`):
   ```bash
   ssh ci@homelab.tailcd5c62.ts.net 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; \
     d=$(ls -dt ~/.maestro/tests/*/ | head -1); tail -40 "$d/maestro.log"; \
     docker logs mcm-bff-service-nonsecure --tail=60 2>&1 | grep -iE "login|pipe|error"'
   ```
   The run's containers stay up until the NEXT run's reset step, so post-mortem logs are available.
   Permission rule `Bash(ssh ci@homelab.tailcd5c62.ts.net:*)` lives in the user-global `~/.claude/settings.json`
   (NOT in the repo — never add the homelab host to a tracked file; `.claude/settings.local.json` is git-tracked).
4. Reference memory: `reference-mcm-ci-monitor-access`, `project-mcm-023-forgejo-cicd`.

The runner is **persistent** (not ephemeral) — `app-ci` resets stateful Docker volumes + the realm each run.

## Current failure (run #66, `123899f`) — mobile login response not delivered

`assistant-config-gating` (first mobile flow) fails in `_login-helper`: after entering creds + Enter,
`nav-home` never appears (40s timeout). BFF log shows the **real cause**:

```
audit:login  userId=…  roles:["mc-user"]          ← login SUCCEEDS server-side (session + role)
Error: Cannot pipe to a closed or destroyed stream  (@expo/server express.ts respond pipeline)
```

So auth works, but the BFF's **login response stream is cut off** — the app closed the connection before
receiving the session, so it never navigates home. This is an **app↔BFF response-delivery** problem over the
emulator + `adb reverse tcp:8082`, NOT the earlier URL-bake issue (the gradle-daemon fix `123899f` should have
baked `localhost:8082/8099` — verify via the screenshot URL or by unzipping the APK bundle on the runner).

**Next-session first steps:**
1. Confirm the APK now bakes `localhost` (not `10.0.2.2`): pull the latest `screenshot-❌-*.png` from
   `~/.maestro/tests/<latest>/` on the runner, or `unzip -p` the APK's `index.android.bundle` and grep for the URL.
2. Investigate the "Cannot pipe to a closed or destroyed stream": likely an **app-side login fetch timeout**
   (the BFF login does a Keycloak code exchange + session create, which can take >1–2 s; if the RN fetch / the
   `adb reverse` tunnel drops first, the response can't be delivered) OR an `@expo/server` streamed-response vs
   RN-fetch interaction. Check `frontend/mcm-app` login flow (`use-login.ts`, `bff-server/api-client.ts`,
   `app/(auth)/native-auth-callback`) for a short timeout/abort, and whether the login response is streamed.
   Memory notes on related RN streaming/timeout: `project_agent_run_token_refresh`, `project_copilotkit_react_native`,
   `project_expo_server_import_meta_polyfill`, `project_maestro_sso_timing`.
3. Fix → push → `mcm-ci.sh status` → SSH-pull the new maestro log → repeat.

## How we got here (don't re-tread — all already applied + pushed)

Guardrails made action-light (instance lacked `dorny/paths-filter`; later set `DEFAULT_ACTIONS_URL=github`
on the forge so app-ci's github actions resolve). app-e2e moved to a **host runner** (`runs-on: kvm`) because
a rootless container can't do localhost/KVM/docker-net. Operator set up: KVM (`/dev/kvm` 0666 + `--device` in
runner config), `DEFAULT_ACTIONS_URL=github`, Forgejo secrets/vars, **`ci-realm.json`** generated via
`scripts/export-ci-realm.mjs` (runtime-managed realm; throwaway secrets + service-account roles + test user
mc-user as a **client** role of `movie-collection-manager`). Fixes landed: container Docker CLI install,
`gen-ci-env.mjs` (writes `.env.local`/`keycloak_db_password.txt`/`.env.docker` + `web-api-mcp/.env.local`),
pre-create all external volumes, build `mc-service`+`mcm-bff` before mcm up, `up-agents-prod` uses a
lightweight `uv` env for the gateway-secret fetch (`agent-stack.mjs`), `KEYCLOAK_SERVICE_CLIENT_SECRET` passed,
**anthropic** agent config (web seed via `E2E_AGENT_PROVIDER=anthropic`; mobile via
`assistant-config-enable-anthropic.yaml`) so no local Ollama, web E2E in the Playwright **container**
(`--network host`; host Ubuntu 26.04 unsupported by Playwright), absolute `APK_PATH`, per-file Maestro loop in
`scripts/ci-mobile-agent-flows.sh` (emulator-runner runs the `script:` line-by-line), `upload-artifact@v3`
(Forgejo), clear seeded agent config before mobile gating, localhost URLs + `adb reverse`, gradle-daemon off.

## Remaining 023 tasks (after mobile flows are green)

Operator/runtime still open (see `tasks.md`): **T013** Komodo Stacks, **T021** branch-protection repoint,
**T018/T019** CD validation, **T020** delete `.github/workflows/*` (DEFERRED until US1/US2 trusted on forge),
**T026** remove `smoke.yml`, **T027** quickstart, plus add a **`BASE_DOMAIN`** Forgejo variable (cd-deploy
probe + prod APK). Then finish/merge.
