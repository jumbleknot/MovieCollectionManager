# HANDOFF — Feature 023 CI on the homelab forge: autonomous driving + the mobile-E2E debug loop

**For a fresh session.** Read this, then [HANDOFF.md](./HANDOFF.md) for the original feature context. The
feature's config-as-code is authored and merged-to-branch; what remains is getting **`app-ci`'s mobile
agent flows green on the homelab runner**, which is now an interactive fix→push→observe loop you can run
**autonomously** (git push + Forgejo API + SSH to the runner).

---

## ⭐⭐ SESSION 3 UPDATE (2026-06-27, evening) — READ THIS FIRST

**The mobile suite is GREEN-CAPABLE but FLAKY. Your task: implement "option 1 — resilient `choose()`" to make the two pick-tap navigation flows reliable, then prove stability over multiple runs.** Branch `023-forgejo-cicd`, HEAD **`5053af4`**.

### Where it stands
- `2964862` passed the **ENTIRE** app-e2e once: web E2E (124) + ALL 8 mobile flows (chrome-skip-fre, gating, enable-anthropic, agent-search, agent-card-navigate, agent-disambiguation, agent-navigate-movie, disable). So the pipeline CAN go fully green.
- `5053af4` (a logging-only diagnostics removal) then FAILED: `agent-navigate-movie` 0/3 at `movie-detail-title`. The flake is intermittent (~50%/run); 3× per-flow retries are not always enough.

### Fixes already LANDED this session (all real, keep them)
1. **banner scroll-UP** — success banner renders at top of the config form; `centerElement` scrolled it off → `scrollUntilVisible direction: UP` in gating/disable/enable-anthropic.
2. **agent `/run` relative URL on the release APK** (the big one) — `use-assistant.tsx` read `EXPO_PUBLIC_BFF_BASE_URL` directly (empty in CI) → relative URL → native fetch "status 0", never reached the gateway. Now uses the shared `BFF_BASE_URL` resolver (`config/bff-url.ts`). See `[[project-copilotkit-react-native]]`.
3. **agent flows `clearState:true`** — the 4 agent flows were `clearState:false` but run `_login-helper` (needs the login screen); inherited logged-in state in the back-to-back suite.
4. **agent-search async wait** — instant `runFlow when: pick-0` raced the TMDB search; picks render ABOVE the controls and the dock auto-scrolls to the bottom → `scrollUntilVisible pick-0 direction: UP`.
5. **agent-card-navigate** — "do I have X in my `<C>` collection" → SEARCH → selection BUTTON (not a bare card) → tap pick → detail.
6. **agent-navigate-movie** — supervisor maps ANY movie to SEARCH (never navigate); query MUST end "… `<Name>` collection" (search.py `_NAMED_RE`) or it hits scope buttons → tap pick → navigate.
7. **probe transient-5xx retry** — `agent-config-probes.ts timedFetch` retries 5xx ≤3× (a TMDB 502 had failed the web agent-config-seed). NOT retried: 401/403/network.
8. **removed native-auth-callback CI diagnostics** (`5053af4`).

### THE REMAINING FLAKE — root cause (diagnosed, NOT fixed)
The selection **pick-tap** navigation (`agent-card-navigate`, `agent-navigate-movie`) sends the pick via `selection-options.tsx` `choose()` → `useAgent({agentId})` → `agent.addMessage(...)` + `copilotkit.runAgent({ agent })`. When the CopilotKit-RN agent registry is momentarily empty, the pick-tap **silently no-ops** (NO `/run` reaches the gateway) → `movie-detail-title` times out. Client logcat on a failure shows:
```
[CopilotKit] Error (runtime_info_fetch_failed): … GET http://localhost:8082/bff-api/agent/run/info … status 200 but no response was produced
Agent movie_assistant not found   (repeated, around the pick tap)
```
`@copilotkit/react-native@1.59.5`; `use-assistant.tsx` already sets `useSingleEndpoint` (mode "single") which is SUPPOSED to suppress the `/run/info` probe, but the logcat shows it still firing. The dock's TYPED-input send (every flow's first query) is reliable — `choose()` and the dock send use IDENTICAL code (`useAgent`+`runAgent`), so the difference is registry TIMING at tap moment, not the send path. `agent-search`/`agent-disambiguation` also pick-tap but pass more often (their first turn primes the agent closer to the tap).

### YOUR TASK — option 1: make `choose()` resilient (then verify, then the rest below)
Goal: a pick-tap must NOT be dropped when `agent` is transiently unavailable. Candidate approaches (pick what the installed API supports — inspect `frontend/mcm-app/node_modules/@copilotkit/react-native/dist/index.d.cts`):
- **(a)** If the CopilotKit API can run by id without the agent object, call `copilotkit.runAgent({ agentId: ASSISTANT_AGENT_ID })` (or equivalent) so a null `agent` object doesn't block the run.
- **(b)** Queue the pick and fire it when the agent appears: store the chosen value in a ref/state, and a `useEffect([agent])` flushes it once `agent` is truthy (so a tap during a transient empty-registry window self-heals on the next render instead of being lost in the sync callback).
- **(c)** First add a one-line diagnostic in `choose()` (`if (!agent) console.error('[selection-choose] no agent at tap')`) and re-run once to CONFIRM `agent` is actually null at tap time (vs runAgent failing downstream) before committing the fix — cheap certainty, remove after.
- Apply the same resilience to the dock send (`assistant-dock.tsx` ~L171-173) for consistency.
- **Alternative root fix (option 2, if option 1 underperforms):** stop the `/run/info` probe (investigate why `useSingleEndpoint` doesn't suppress it in 1.59.5 — prop name/version), OR add a GET handler to `app/bff-api/agent/run+api.ts` that returns a valid CopilotKit runtime-info/agents payload so discovery succeeds and the registry is never empty.

🚨 **Validation caveat:** the flake is ~50%/run, so ONE green run does NOT prove the fix. After pushing, get **≥3 consecutive green `app-e2e` runs** (re-trigger by re-pushing a no-op or via the Forgejo API) before declaring it stable. Confirm via logcat that `runtime_info_fetch_failed`/"Agent not found" no longer precede a dropped pick-tap.

### After the flake is fixed + stable — operator/runtime tasks (NEED THE USER)
Do NOT do these autonomously: **merging 023→main auto-fires `cd-deploy` = a PRODUCTION DEPLOY.** Remaining: T013 Komodo Stacks, T021 branch-protection repoint, T018/T019 CD validation, T020 delete `.github/workflows/*` (now unblocked — guardrails+app-ci green on forge), T026 remove `smoke.yml`, T027 quickstart, add `BASE_DOMAIN` Forgejo var, then merge. Surface to the user.

### Screenshot transfer gotcha (this session)
scp/`>`-redirect of a runner file to the Windows scratchpad often reports exit 0 but the local file is **0 bytes for several minutes**, then fills — don't trust an immediate `wc -c`; wait for the background task-notification, re-check size, THEN decode. Or rely on logcat/maestro-log/gateway-log instead (faster, deterministic).

---

## SESSION 2 UPDATE (2026-06-27, afternoon) — superseded by SESSION 3 above

The **mobile login blocker is fully SOLVED and stable.** The original "Current failure" section below
(the pipe-error theory) was a **red herring** — that error fires on the *green web logins* too. The real
chain was a stack of distinct issues, each now fixed. We are no longer debugging login; we're in
**agent-config E2E flow polish** (tap-targeting on the config form). HEAD is **`51b42c4`** (pushed,
`app-e2e` running when this was written — check its status first).

### First step in the new session
```bash
bash ~/.mcm/mcm-ci.sh status 51b42c4          # app-e2e: success | failure | running | not-started
# then SSH the runner for detail (see "Driving the loop" below). Each push re-runs app-ci.
```
A wakeup was scheduled to fire ~08:22 to check `51b42c4`; in a fresh session just check status directly.

### The deterministic chain we solved (commits on `023-forgejo-cicd`, newest last)
1. **Stale Metro transform cache** → release APK baked the `10.0.2.2` fallback URLs, not the
   `localhost` ones the job env sets (Metro's cache key ignores inlined `EXPO_PUBLIC_*` values; persistent
   runner). Fix `1244560`: `frontend/mcm-app/scripts/build-apk.mjs` wipes `/tmp/metro-cache` for release
   builds + a workflow guard greps the bundle for `localhost:8082`. See `[[project-metro-cache-stale-expo-public]]`.
2. **"Cannot pipe to a closed or destroyed stream"** (BFF) = benign @expo/server noise, **not** the cause
   (also on green web logins). Red herring.
3. **AOSP `webview_shell` dropped the `mcm-app://` OAuth redirect** (no Custom-Tabs provider → expo-web-browser
   falls back to a plain WebView that never dispatches the custom-scheme Intent). Fix `3c0e372`: emulator
   `target: google_apis_playstore` (ships Chrome, a real CCT provider).
4. **Chrome First Run Experience** covered the Custom Tab. Fix `efaf9c2`: `tests/e2e/mobile/_chrome-skip-fre.yaml`
   taps **"Use without an account"**, run once (best-effort) before the flows in `scripts/ci-mobile-agent-flows.sh`.
5. **Cleartext HTTP blocked** in the release APK (targetSdk≥28; Expo only relaxes it in the *debug* manifest)
   → the login POST to `http://localhost:8082` failed with `ERR_NETWORK`. Fix `f8c3203`: local Expo config
   plugin `frontend/mcm-app/plugins/with-dev-cleartext.js` (network-security-config permitting cleartext ONLY
   for localhost/127.0.0.1/10.0.2.2 — prod HTTPS unaffected). All of 3/4/5 are in `[[project-ci-emulator-oauth-custom-tabs]]`.
6. **Gating flow**: scrolled to the `assistant-config` *container* (also on the loading state) instead of the
   toggle; and the workflow **cleared** the web-seeded config that gating expects to start enabled. Fix `92d38b0`:
   scroll to the toggle + drop the "Clear seeded agent config" workflow step (the web E2E seeds a runnable
   config via `tests/e2e/web/setup/agent-config-seed.ts` T050).
7. **Login flake (form race)**: the CCT/Keycloak form can render >6s after the fixed wait, so the instant
   `when visible: "Username or email"` check SKIPPED credential entry. Fix `44514b6`: `extendedWaitUntil(optional)`
   for the username field in `_login-helper.yaml`.
8. **CustomTab Chrome renderer crashed mid-load** (logcat `CustomTabActivity "WIN DEATH ... app died"`) — a
   flaky login. Fix `80d48f2`: emulator `ram-size 4096M`/`heap 576M`/`cores 3`/`-memory 4096` **+ retry each
   flow up to 3× and the FRE pre-step** in `ci-mobile-agent-flows.sh`. **This worked — 0 crashes since, login
   reaches the BFF on every attempt.**

### Current open issue (what `51b42c4` is testing)
With login stable, **gating reaches the config form but the Save tap doesn't save** (no PUT, no
`audit:assistant_config_saved`, no banner). Root cause (confirmed from source + screenshots): the **Save**
button is the last control, **bottom-left** in the actions row (`movie-assistant-config.tsx` ~L291) — exactly
under the **floating assistant-dock toggle overlay** (shown because the seeded config is runnable; bottom-left,
mounted in `app/(app)/_layout.tsx` `AuthedAssistant`). `scrollUntilVisible` stops at *minimal* scroll (Save
flush at the viewport bottom) and its "100% visible" check **ignores an overlay on top**, so the tap is
swallowed by the dock toggle (which just opens the dock).
- **Why the dock can't simply be hidden on /profile:** the web spec `tests/e2e/web/assistant-config.spec.ts`
  (~L112) asserts the dock toggle becomes visible **on the profile screen** after saving (FR-031). So this is
  a TEST-side / layout fix, not "hide the dock".
- **Fix in `51b42c4` (the combo — neither half works alone):** `profile-screen.tsx` `content.paddingBottom: 180`
  (scroll room below the actions row) **+** `centerElement: true` on the toggle/save `scrollUntilVisible` in
  `gating`/`disable`/`enable-anthropic`. Padding gives the room; centerElement lifts Save toward mid-screen,
  clear of the bottom-left dock overlay, so the tap lands on Save.
### ✅ `51b42c4` RESULT (app-e2e FAILED, but the Save fix WORKED) — DO THIS NEXT
The paddingBottom+centerElement combo **fixed the Save tap**: gating now produces **mobile**
`audit:assistant_config_saved` (seen at 12:04/12:05/12:07, one per retry). Gating fails on the **very next
step**: `assertVisible assistant-config-banner` times out. Why: the success banner renders at the **TOP** of
the config form (`movie-assistant-config.tsx` ~L168, above the toggle), but `centerElement` scrolled the form
**down** to the Save button, pushing the banner **off-screen above** — and `extendedWaitUntil` does **not**
scroll. So the save succeeded server-side; only the UI confirmation is out of view.

**Fix to apply (gating + disable + enable-anthropic):** after `tapOn assistant-config-save`, replace the
`extendedWaitUntil { visible: id: assistant-config-banner }` with a scroll that brings the banner into view,
e.g.:
```yaml
- scrollUntilVisible:
    element:
      id: "assistant-config-banner"
    direction: UP
    timeout: 20000
```
(scrollUntilVisible waits AND scrolls, covering the async save + the off-screen position). Then push and
re-check; gating should finally go green and the suite advances to `enable-anthropic` and the 4 agent flows.

- If a later flow regresses Save again: same banner/centerElement interaction may apply; reuse the scroll-UP.
- Fallback if the dock dance keeps biting: an **app fix** (stop the dock toggle overlapping the actions row —
  raise the dock's bottom offset, or render it only on non-profile routes while keeping it visible on /profile
  enough to satisfy the web assertion) **or the strategic option: pre-seed the BFF session on the emulator app
  to skip the per-flow Keycloak SSO entirely** (big change, but kills both the CCT flakiness and the dock dance).

### Driving the loop (unchanged, all working)
- **Push** `git push origin 023-forgejo-cicd` (GCM has forge creds) → triggers `app-ci` (paths `frontend/**`,
  `.forgejo/workflows/app-ci.yml`, etc. — note `scripts/**` alone does NOT trigger; piggyback on a frontend change).
- **Status**: `bash ~/.mcm/mcm-ci.sh status <sha>` (only `/actions/tasks` works; **logs/artifacts 404 via API**).
- **Logs/screenshots via SSH** (`ssh ci@homelab.tailcd5c62.ts.net`, key installed, perm rule in user-global
  `~/.claude/settings.json` — NEVER add the host to a tracked file):
  - Latest maestro run: `d=$(ls -dt ~/.maestro/tests/*/ | head -1); tail -40 "$d/maestro.log"`. Each flow = one
    dir; `_chrome-skip-fre` then `assistant-config-gating` etc. The runner is persistent so old dirs accumulate.
  - **Client logcat** (our `console.error` diagnostics + redirect trace): `~/ci-mobile-logcat.txt` (filtered)
    and `~/ci-mobile-logcat-full.txt` (full), written by `ci-mobile-agent-flows.sh`'s EXIT trap.
  - BFF: `export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker logs mcm-bff-service-nonsecure --since 20m | grep -E "audit:login|assistant_config_saved|ERR"`.
    The **web-seed** login+save fires early (web E2E phase); the **mobile** login/save fire after the emulator
    starts — distinguish by timestamp vs the maestro dir time.
  - Gateway (agent flows): `docker logs movie-assistant-gateway --tail=150`.
  - **Screenshot fetch GOTCHA** (piped ssh redirects to a Windows path often truncate to 0B): stage on the
    runner `ssh … 'cp "$d"/screenshot-*❌*.png /tmp/x.png && base64 -w0 /tmp/x.png > /tmp/x.b64'` (use the `❌`
    glob — there can be a `⚠️` one too), then `scp` the `.b64` with **run_in_background:true**, WAIT for the
    task-notification, then `base64 -d x.b64 > x.png` and Read it. console.error DOES reach logcat in release
    here (proven by the CopilotKit warn), so absence of a `[native-auth-callback]` log is real signal.

### Temporary diagnostics to REMOVE once `app-e2e` is green (and KEEPERS)
- **Remove**: the `console.error('[native-auth-callback] ...')` lines in
  `frontend/mcm-app/src/app/(auth)/native-auth-callback.tsx` (mount log + the catch log) — pure diagnostics.
- **KEEP everything else**: `_chrome-skip-fre.yaml`, `with-dev-cleartext.js`, the playstore image + RAM, the
  Metro-cache clear + bundle guard, the gating/login/dock flow fixes, the profile `paddingBottom`, the
  `ci-mobile-agent-flows.sh` logcat dump + retries. (The logcat dump is cheap and useful to leave in.)

### After mobile flows are green
Run the Final Validation web E2E regression if any app code changed; then the **operator/runtime tasks** in the
section below (T013 Komodo, T021 branch-protection, T018/T019 CD validation, T020 delete `.github/workflows/*`,
T026 remove `smoke.yml`, T027 quickstart, add a `BASE_DOMAIN` Forgejo var) and merge. Memories to update on
green: `[[project-mcm-023-forgejo-cicd]]` and `[[project-ci-emulator-oauth-custom-tabs]]`.

---

## Branch / repo state (2026-06-27) — ORIGINAL (stale; see Session 2 above)

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
