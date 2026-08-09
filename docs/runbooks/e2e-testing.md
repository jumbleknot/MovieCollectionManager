# Runbook: E2E Testing (BFF-container modes, flakiness, integration harness)

> Loaded on demand — referenced from CLAUDE.md. The day-to-day Test Run Protocol and Final Validation Checklist live in CLAUDE.md; this runbook holds the container-mode procedures, the flakiness-diagnosis protocol, and the BFF integration-test harness facts. For mobile/Android specifics see [android-emulator.md](android-emulator.md).

> **Before ANY agent E2E: prove the two images match your source.** Both are **baked, not
> mounted** — the Expo web bundle lives inside `mcm-bff:latest` and the graph inside
> `agent-gateway:latest` — so a client or agent change you just made is invisible to the run until
> you rebuild, and the symptom is a feature that "doesn't work" rather than an error.
>
> ```bash
> docker run --rm --entrypoint sh agent-gateway:latest -c "grep -c <a-string-you-just-added> /app/src/runtime_nodes.py"
> docker run --rm --entrypoint sh mcm-bff:latest      -c "grep -rl <a-testid-you-just-added> /app/runtime/dist | head -1"
> # rebuild: SPECIALIST_MODEL=qwen2.5 node scripts/agent-stack.mjs   ·   pnpm nx docker-build mcm-app
> ```
>
> Measured 2026-08-05 (047 US3): both images were two days stale. The BFF one was caught before
> running; the GATEWAY one was not, and the E2E failed with "the progress line never appeared" —
> which reads exactly like the client bug the test was written to detect. Note the bundle path is
> `/app/runtime/dist`, not `/app/dist`; grepping the wrong one returns empty and looks like a
> stale image.

> **A silently-skipping spec does not just miss regressions — it lets its OWN expectations rot.**
> Measured 2026-08-05: `agent-navigate-movie` still asserted the auto-navigation that **013**
> deliberately replaced with buttons ("new bug 2"), and `agent-add-external-link` still waited for
> an approval card that **047 US4** moved behind the ownership questions. Neither went red, because
> both were skipping — so across two features the specs quietly stopped describing the product
> while still being counted as coverage. That is why a skipped test is worse than an absent one:
> an absent test does not appear in the tally.

> **`pnpm nx e2e mcm-app` alone is NOT the agent regression suite.** Every `agent-*.spec.ts` gates
> on `E2E_AGENT_PRODUCTION=1`; without it all 13 skip and the run reports green. Measured
> 2026-08-05: running them properly (with `E2E_REQUIRE_AGENT_STACK=1`, which turns a skip into a
> failure) surfaced three failures that had been invisible — one a live regression, two specs whose
> expectations had gone stale. All three are fixed. Always set BOTH flags.

> **Web and agent E2E ARE runnable in the dev container.** `pnpm nx e2e mcm-app` is not — chromium
> cannot be installed here — but that is a fact about the **nx target**, not about E2E. Run
> Playwright in the official image with `--network host` and it works:
> [devcontainer.md §3 "Web + agent E2E"](devcontainer.md). Stated here, at the top, because this is
> where someone looks before concluding they cannot verify something — and concluding that wrongly
> means shipping unverified. See the note in that section on `--user`, which is not optional.

## The integration tier gates CI (feature 041)

> **Always run the integration tiers with `MCM_REQUIRE_LIVE_STACK=1`, and bring up ALL the MCP
> servers.** A missing server does not fail the suite — it makes the tests that need it *skip*,
> and pytest reports green.
>
> Measured 2026-08-03 (047 PR A): the agent tier was run with movie-mcp and spreadsheet-mcp up but
> **web-api-mcp down** → `89 passed, 17 skipped`, reported as a pass. One of those 17 was
> `test_gateway_add_e2e.py`, which the 047 ownership chain had genuinely broken — the same
> regression feature 040 caused when it first inserted the ownership question. It reached CI and
> failed `app-ci / app-e2e` with `approved add did not create the collection`. With all servers up
> the same suite is `95 passed, 11 skipped`; the 6-test difference was the blind spot.
>
> `MCM_REQUIRE_LIVE_STACK=1` turns any non-allowlisted skip into a failure naming the missing
> dependency — verified: it converts that exact skip into
> *"this integration test SKIPPED … a silently-skipped suite reports green and gives false
> confidence."* **The skip COUNT is the signal**: if it moves, something stopped being tested.


`app-ci`'s `app-e2e` job runs `test:integration` for **all three** projects — agent
(`movie-assistant`), `mc-service`, `mcm-app` — before the web/APK/emulator legs, so a failure costs
~5 min instead of burning 25+ min of emulator time first. Every step sets
**`MCM_REQUIRE_LIVE_STACK=1`, which escalates a SKIP to a FAILURE**: in CI a down dependency is a
broken harness, not a pass.

Before 041 **no** project's integration tier ran anywhere in CI (only the keyless `-m golden`
subset). It had rotted silently for a month — the first green run surfaced a month-old contract
regression and a credential leak.

What this changes for you:

- **Run the touched suite before pushing** — a red integration test blocks the merge.
- **Skips are failures in CI.** Legitimately-optional skips are allowlisted per suite: agent
  `_LEGITIMATE_SKIPS` (`agents/movie-assistant/tests/integration/conftest.py`, e.g. `--profile
  observability`, `opensearch`, `ollama not reachable`); mcm-app via the jest `globalSetup` preflight
  (`frontend/mcm-app/tests/integration/setup/preflight.global.js`), which probes BFF/Keycloak/Redis/
  Mongo and throws. Add to those **deliberately** — never to turn a red run green.
- **mc-service** additionally runs `scripts/mc-service-integration-guard.mjs`, which fails an
  all-`#[ignore]` / zero-executed run and forbids a bare `#[ignore]`.
- **Agent/MCP images rebuild every run** (`scripts/agent-stack.mjs` builds by default; `--no-build`
  is refused under CI), so `agents/**` and `mcp-servers/**` changes are genuinely under test. CI
  previously reused whatever image sat on the persistent runner.
- Proof each gate bites (SC-003 3/3, SC-004 3/3):
  [specs/041-integration-test-ci-enforcement/SC-003-SC-004-EVIDENCE.md](../../specs/041-integration-test-ci-enforcement/SC-003-SC-004-EVIDENCE.md).

⚠️ **A Mongo-down mc-service run takes ~690 s instead of ~5 s** (the driver's default
server-selection timeout, applied per test). It fails correctly, but if a partial-down run seems
hung, that is why.

## Final local E2E runs against the BFF container (feature 007)

**Testing procedure (3 phases):**

1. **Iterative development is Metro-only.** All coding plus unit / integration / iterative E2E run against Metro (`pnpm nx e2e mcm-app`, `pnpm nx test`, `pnpm nx test:integration`, type-check). Metro is the fast inner loop and the **default state** of the repo.
2. **Final E2E validation runs against the containerized BFF — the dev container (non-Secure HTTP, `:8082`)** — only *after* the Metro suites are green. This exercises the real `@expo/server` production server (not Metro's dev server) and proves the request path is the container, not Metro, via the `X-BFF-Source` header (asserted in `global-setup.ts`, fail-fast on a Metro false-green).
3. **After all green, reset the environment to Metro-only** (tear down the container + revert `.env.local` — see "Switch back to Metro" below).

**The prod container (HTTPS, Secure cookies) is reserved for a future CI/CD pipeline — it is NOT a routine local step.** There is no CI E2E job today; feature 007 proved the prod-HTTPS path works locally (US3, kept for reference in the quickstart), but going forward that hardened run belongs in CI/CD, not the local loop. Full runbook for all modes: [specs/007-e2e-bff-container/quickstart.md](../../specs/007-e2e-bff-container/quickstart.md).

The same app + BFF **code** runs in every mode; only the *server fronting it* (Metro vs `@expo/server`-in-a-container) and the *cookie/TLS posture* change:

| Mode | BFF served by | Port | Cookies | When to use | Web command | Mobile deltas (`frontend/mcm-app/.env.local` + `adb reverse`) |
|---|---|---|---|---|---|---|
| **Local dev** *(default)* | Metro (`@expo/server` dev) | `:8081` HTTP | non-Secure | **iterative development** + unit/integration/iterative E2E | `cd frontend/mcm-app && pnpm start` (press `w` for web) | `EXPO_PUBLIC_BFF_NATIVE_URL=http://10.0.2.2:8081`, `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://10.0.2.2:8099`; `adb reverse tcp:8081 tcp:8081` |
| **Dev container** | Docker `mcm-bff-service-nonsecure` (`NODE_ENV=development`) | `:8082` HTTP | non-Secure | **local final E2E** (after dev is green) | `docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure up -d` then `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` | `EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8082`, `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://localhost:8099`; `adb reverse tcp:8081`+`tcp:8082`+`tcp:8099`; restart Metro `--reset-cache` |
| **Prod container** | Docker `mcm-bff-service-secure` + `mcm-bff-tls-proxy` (`NODE_ENV=production`) | `:8443` **HTTPS** | **Secure** | **future CI/CD only** | `docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-secure up -d` then `E2E_BFF_TARGET=prod-container pnpm nx e2e mcm-app` | mobile is **CA-trust-limited** (needs a debug `network_security_config` + APK rebuild — see quickstart §2 / research R3) |

**Switch back to Metro (the reset after a container run):**

```bash
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml rm -sf mcm-bff-service-secure mcm-bff-service-nonsecure mcm-bff-tls-proxy   # remove ONLY the BFF/proxy containers (NOT `down`, which stops the whole mcm stack)
# revert the two frontend/mcm-app/.env.local native URLs to their 10.0.2.2 defaults
cd frontend/mcm-app && pnpm start                 # Metro is the default state again
```

The shared backend (Keycloak/Redis/Mongo/mc-service) and the `KC_HOSTNAME` issuer pin stay up — both are harmless for (and required by) Metro dev.

**Prerequisite (one-time):** Keycloak must expose a **stable issuer** or the container BFF's token refresh fails (`invalid_grant: Invalid token issuer`) — the browser mints `iss=localhost:8099` but the container refreshes over `keycloak-service:8080`. `infrastructure-as-code/docker/keycloak/compose.yaml` pins `KC_HOSTNAME=http://localhost:8099` + `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`; if Keycloak predates this change, recreate it once (`pnpm nx up-auth infrastructure-as-code`). The client's container redirect URIs are added via `infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs`.

**Dev container (HTTP, non-Secure cookies) — the standard final run:**

```bash
pnpm nx docker-build mcm-app                              # build mcm-bff:latest (once per code change)
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure up -d   # dev BFF on 127.0.0.1:8082 (NODE_ENV=development)

# Web — container serves client + BFF; stop Metro first so it can't serve a false-green:
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app          # 92/92 green, ~50s (prebuilt bundle, no JIT)

# Mobile — Metro serves JS on :8081, container serves /bff-api on :8082 (dual-port):
#   adb reverse tcp:8081 + tcp:8082 + tcp:8099 (8099 = Keycloak; issuer must match localhost:8099)
#   In frontend/mcm-app/.env.local set EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8082 and
#   EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://localhost:8099 (NOT inline — inline env does not reach the
#   bundle), restart Metro --reset-cache, then: pnpm nx e2e:mobile mcm-app  (revert .env.local after).
```

**Prod container (HTTPS, Secure cookies) — future CI/CD, NOT a routine local run.** Same pattern with `E2E_BFF_TARGET=prod-container` (`bff-secure` profile, `mcm-bff-tls-proxy` Caddy TLS on `https://localhost:8443`); kept in [quickstart §2](../../specs/007-e2e-bff-container/quickstart.md) for reference. Defer this hardened run to the CI/CD pipeline — locally, stop at the dev-container final E2E above and reset to Metro.

## Running the AGENT specs (they do not run by default)

`pnpm nx e2e mcm-app` runs the general web suite and **skips every `agent-*.spec.ts`** — all ten
gate on `E2E_AGENT_PRODUCTION=1`, because they need the containerized production-node gateway and
MCP servers. The run still reports green, which is the trap: nothing in the output says the agent
flows were not exercised.

```bash
node scripts/agent-stack.mjs              # deploy gateway + MCP servers (builds images by default)
node scripts/agent-e2e.mjs                # every agent spec, isolated per file
node scripts/agent-e2e.mjs agent-search   # one spec by basename
```

`agent-e2e.mjs` sets `E2E_AGENT_PRODUCTION=1` and `E2E_BFF_TARGET=dev-container`, and recreates the
dev BFF with the agent-e2e rate-limit override first — repeated runs otherwise trip the per-user
limit and the dock silently renders no messages.

> **`agent-e2e.mjs` does NOT work inside the dev container** (measured 2026-08-03). It shells out
> to `nx e2e`, which launches Playwright on the host — and chromium cannot be installed in here, so
> `globalSetup` dies on `browserType.launch: Executable doesn't exist`. In the dev container run the
> specs through the Playwright image instead (recipe in the
> [devcontainer runbook](./devcontainer.md)); `agent-stack.mjs` itself works fine and is still how
> you bring the stack up. Note `agent-stack.mjs` needs `KEYCLOAK_SERVICE_CLIENT_SECRET` exported
> from `stacks/auth.env` first, or it fails with `service-account admin token failed (401)`.

> **"Sorry — I couldn't complete that just now." usually means a MISSING OLLAMA MODEL, not a code
> bug.** The gateway makes two model calls per add turn — `SUPERVISOR_MODEL` to classify, then
> `SPECIALIST_MODEL` for the curator. Ollama answers an uninstalled model with **404**, the
> specialist node degrades, and the member sees that generic sentence with nothing naming the
> cause. Confirm from the gateway log: `POST /api/chat 200` immediately followed by
> `POST /api/chat 404` is the signature.
>
> In the **dev container** the gateway resolves `host.docker.internal:11434` to the nested
> `dev-ollama` container, which carries `qwen2.5` but **not** the default
> `SPECIALIST_MODEL=qwen2.5:32b`. So run:
>
> ```bash
> SPECIALIST_MODEL=qwen2.5 node scripts/agent-stack.mjs
> ```
>
> `agent-stack.mjs` now verifies BOTH models against the same endpoint the gateway uses and exits
> non-zero naming the missing one. It previously checked only that "qwen2.5" appeared in the tag
> list, and — worse — probed WITHOUT `--add-host host.docker.internal:host-gateway`, so it saw the
> Windows host's Ollama (which had 32b) rather than the nested one the gateway actually calls. It
> printed "stack up" while every agent turn 404'd. Measured 2026-08-03: an hour lost to this.

> **Rebuild the BFF image when you change CLIENT code.** The Expo web bundle is baked into the BFF
> image, so a change to anything under `frontend/mcm-app/src/` is invisible to a containerized E2E
> run until `pnpm nx run mcm-app:build` + a container recreate. Measured 2026-08-03: a new Cancel
> button on the search card was fully unit-tested and present in the gateway's payload, but the E2E
> failed `element(s) not found` because the container was still serving the previous bundle. This
> is the same stale-image rule the validation checklist states for services — it applies to the
> CLIENT too, which is easy to miss because "the client" does not feel like a deployed container.

**Make a missed stack loud.** Set `E2E_REQUIRE_AGENT_STACK=1` on any pre-PR or CI run: the shared
gate in `tests/e2e/web/setup/agent-stack-gate.ts` then fails with bring-up instructions instead of
skipping. Mirrors `MCM_REQUIRE_LIVE_STACK` in the Python integration tiers.

In the **dev container** Playwright cannot install chromium and must run in the official image —
with `--user "$(id -u):$(id -g)"`, or its artifacts land root-owned in your working tree and block
the next run. Full recipe: [devcontainer runbook](./devcontainer.md).

## Diagnosing E2E flakiness — rule out a real regression BEFORE blaming the environment (feature 009 lesson)

> "Metro degrades over long sessions" / "emulator GPU contention" / "machine overload" are *real* but they are the **last** explanation to reach for, not the first. They are seductive because they require no code investigation — and that is exactly the trap: in feature 009 a genuine code regression (a strict `validateObjectId` 400'ing the Expo-Router-shadowed `…/movies/filter-options` sub-path, invisible because `handleMcApiError` doesn't log 4xx) was repeatedly misattributed to machine/Metro degradation, wasting hours. **The goal is clean runs faster — so diagnose deterministically:**
> 1. **Use the dev-container path, not Metro, to decide flaky-vs-broken.** `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` runs against a prebuilt bundle on `:8082` — **deterministic, ~54s for 93 tests**. It has none of Metro's JIT/long-session variance. If the container run is far slower than ~54s or fails, that is a **real regression**, full stop — do not say "flaky."
> 2. **Compare against a known-green baseline on the SAME (clean) machine.** Before concluding "environment," `git stash`/checkout the last known-green ref (e.g. the prior merge commit), rebuild the container, and run it ×3. If the baseline is green ×3 and your branch isn't, the fault is your code — bisect the diff, don't tune the emulator. (Reboot first only to remove that as a variable, not as the fix.)
> 3. **A clean container run is fast.** Treat "a green run shouldn't take this long" as a real signal, not background noise — the user was right about exactly this.
> 4. **Check whether the error is even surfaced.** A swallowed/unlogged 4xx (see `handleMcApiError`, which only audit-logs 401/403) makes a hard failure *look* like flakiness. Instrument the boundary before guessing.
> 5. **A client→BFF response can be silently LOST through `@expo/server` (feature 023 lesson).** `Error: Cannot pipe to a closed or destroyed stream` (vendored express respond pipeline) intermittently drops a response that the BFF *did* produce — worst over the emulator's `adb reverse` tunnel. It is **benign for login** (the session usually still lands → a documented red herring), but for any request where a dropped response flips the outcome it is a **real bug masquerading as flakiness**: the agent UI-action `authorize()` saw a non-204 and discarded an **already-authorized** navigate (`ui-action-tools.tsx`; BFF `audit:ui_action … allowed=true`, client showed "I can't open that for you.", `agent-navigate-movie` timed out at `movie-detail-title`). **Diagnose server-authorized-but-client-denied by comparing the BFF audit line (`allowed=true`) against the client outcome + the maestro `screenshot-❌`** — if the server allowed it but the screen never changed, the response was lost, not denied. **Fix:** retry idempotent client→BFF requests on transient failure (network error / 5xx), never on a genuine 4xx (default-deny stays intentional) — the agent-config-probe and ui-action `authorize()` both do this. (CopilotKit-RN's `runtime_info_fetch_failed` "status 200 but no response" is the same delivery layer dropping the agent-discovery handshake → an empty registry → "Agent movie_assistant not found"; `useAssistantRun()` resolves the agent from the live registry + queues the send to survive that window.)
> 6. **A CI `app-ci / app-e2e` agent-flow failure → download the `agent-e2e-container-logs` artifact (feature added 2026-07-09).** On failure the job now writes FULL, `-t` timestamped logs for every service on the `/run` path — `movie-assistant-gateway`, the 3 MCP servers, `mcm-bff-service-nonsecure`, `mc-service`, `keycloak-service` — to files and uploads them as the **`agent-e2e-container-logs`** artifact (plus compose-level captures), BEFORE the `always()` teardown removes the containers. **(feature 036)** the capture now ALSO covers the **data-tier** containers (`mc-service-store-mongo`, `mcm-bff-store-mongo`, `mcm-bff-cache-redis`, the postgres stores), records **each container's `docker inspect .State.Health` (`*.health.json`)** — the literal reason a bring-up `unhealthy` fails — plus a `docker ps -a` table, and copies all of it to a **stable runner path `~/mcm-ci-last-failure/`** that survives teardown AND workspace reuse. So a `dependency failed to start: container mc-service-store-mongo is unhealthy` bring-up failure is now diagnosable out-of-band, not just agent-flow failures. This is the authoritative server-side evidence and the required first step — the Forgejo API does not expose job step-stdout, and the container is gone after teardown, so do NOT try to `docker logs` it post-hoc. **Empty dock conversation panel at failure** (no echoed user message, no assistant response, no `disambiguation-options`) is the dropped-`/run`-response signature from step 5, NOT "the model was slow" (slowness shows a partial response) — confirm from the artifact: did `POST /agent/movie-assistant` reach the gateway, return `200` with a completed AG-UI event stream, and did movie-mcp/mc-service resolve the title? If the server completed the turn but the panel stayed empty, the response was lost (retry-idempotent fix), not a model miss. Read `~/mcm-ci-last-failure/` on the runner via SSH (CI-monitor access lives in private memory) — for a **bring-up** failure start with the `*.health.json` + `_mcm-stack.log` (mongo/postgres reason); or download the artifact from the Forgejo web UI (the read-only CI-monitor token 404s on `/artifacts`). **Do NOT attribute a stray `~/.maestro/tests/<ts>/` dir to the current run without SHA/timestamp correlation** (that mistake once turned a mongo bring-up crash into a phantom "mobile flake"), and for an *"is this image broken / unhealthy / missing a dep"* question **reproduce with `docker run` (or Trivy-in-Docker) locally FIRST** — a rootless-runner quirk can make an image unhealthy in CI yet healthy on Docker Desktop. Recent app-e2e is genuinely green, so a single failure is a **real anomaly to diagnose**, not noise to re-run away.
>
> Only after the container baseline confirms the failure is non-deterministic AND machine-local should you reach for the readiness ritual below.

> **Bounded E2E retry (feature 006, FR-006).** Environmental flakiness on the loaded emulator/Metro is absorbed by **at most one** explicit, visible retry per test — never more (more would risk masking a real defect). Mobile: `scripts/maestro-e2e.mjs` re-prepares and re-runs a failed flow once, logging `⟳ RETRY 1/1`; a genuine regression fails both attempts and still fails the suite. Web: Playwright `retries: 1` in `playwright.config.ts`, plus `global-setup.ts` warms `/home`, the collection screen, and a movie-detail screen so the first test doesn't eat the Metro cold-compile. **Readiness ritual for a reproducible green run (apply only after step-1/step-2 above have ruled out a code regression):** start Metro fresh from `frontend/mcm-app` (it degrades over long sessions); for web E2E stop the emulator first (GPU/SSO contention); for mobile E2E run the emulator startup ritual (`-no-snapshot-load`, `adb reverse tcp:8081 tcp:8081`, `-gpu swiftshader_indirect`).

## An agent E2E must assert what the ASSISTANT SAID, not client-local state (050 / item #149)

An agent spec that clicks a control and then asserts only on the client's own reaction proves
nothing about the agent. It passes whether the assistant answered correctly, answered wrongly, or
answered with the opposite of what was asked.

Measured 2026-08-09. 047's `agent-search` cancel test clicked Cancel on the web card and asserted:
the Add button is disabled, no `approval-request` appeared, the card is still visible, and a later
message still works. It was green for two days while the feature was broken — a member pressing
Cancel got *"I couldn't find "exit search" in your "Wish List" collection. Want to look
elsewhere?"* and was pushed back into the search. Every assertion survives that, because:

- **`render-movie-card-add` disabling is `setActioned(true)` — client-local state set in the tap
  handler, BEFORE the agent has replied at all.** It cannot distinguish any two agent responses.
- **"No approval request" is also true of a FAILED SEARCH.** The absence of a write proves nothing
  when the wrong behaviour writes nothing either.
- **"The card is still visible" is asserted by the spec as intended behaviour**, so it is true in
  both worlds.

The unit tier had the same shape of hole: the paired test called `_exit()` directly, asserting the
destination and never the route. `_exit()` was always correct; nothing tested that pressing Cancel
reached it.

**The rule**: after driving an agent control, assert on what the assistant *said*. Prefer the
*properties* the spec fixes over exact copy, so a wording change does not break the test.

**Scope the assertion to the ONE new reply — `assistant-dock-panel` is the whole transcript.**
Getting this wrong is easy and was measured on the first attempt at the fix above: a panel-wide
`await expect(panel).not.toContainText(/couldn't find/i)` fails *forever*, because by that point
the transcript legitimately contains "I couldn't find Inception…" from the earlier owned-search
step, an "Exit search" control label, and the member's own echoed `exit search` message. It looks
like a RED; it is a test that can never go green. Count the replies, wait for one more, and read it:

```ts
const replies = page.locator('[data-testid="assistant-msg-assistant"]');
const before = await replies.count();
await control.click();
await expect(replies).toHaveCount(before + 1, { timeout: ACTION_TIMEOUT });
const reply = (await replies.last().innerText()).trim();

expect(reply.length).toBeGreaterThan(0);                     // it answered at all
expect(reply).not.toMatch(/couldn't find/i);                 // the failure signature
expect(reply).not.toMatch(new RegExp(COLLECTION_NAME, "i"));
expect(reply).not.toMatch(/only help with your movie collections/i);  // the decline
```

**Maestro cannot scope like that** — it sees the whole screen — so a mobile flow must match only
signatures the bug alone produces. `'.*couldn.t find "exit search".*'` (the *quoted* control) is
safe; a bare `.*couldn't find.*` or `.*exit search.*` matches legitimate transcript text and fails
in both worlds.

**Killing the shell does NOT kill the containerized run.** `docker run` detaches its container from
the CLI process, so cancelling the command leaves Playwright still going — invisibly, and competing
for the SAME shared test user and gateway as whatever you start next. Measured 2026-08-09: an
abandoned full-suite run was still at test 24/174 fifteen minutes after being "stopped", slowing an
isolated re-run and making its timings meaningless. Always confirm and clean up:

```bash
docker ps --filter ancestor=mcr.microsoft.com/playwright:v1.60.0-noble \
  --format '{{.ID}}\t{{.Command}}'      # then: docker kill <id>
```

**Include the decline copy in the negatives.** Measured 2026-08-09 on the broken build: the same
defect surfaced as *"I can only help with your movie collections."* rather than the mis-search,
because the classifier read the control as `out_of_domain` on that model. A test that only knows
one symptom of a routing bug will miss the same bug on a different provider.

Same test to apply anywhere: **would this assertion still pass if the assistant said the opposite
of what I want?** If yes, it is not coverage — and it is worse than absent coverage, because it is
counted in the tally. Then ask the mirror question: **could this assertion ever pass at all?**

## Agent E2E must not assert on LIVE-TMDB-ranked titles (drift lesson, 2026-07-20)

An agent flow that picks a disambiguation candidate **by name** from live TMDB results is inherently
flaky — TMDB popularity rankings drift, so a specific title falls in the list, then out of it. This
bit `agent-disambiguation` twice in two days: #539 patched it once (adding scroll + "show more" when
"Avatar: The Way of Water" slipped to 4th), then the post-merge `main` run failed 3/3 because the
title had left the offered set **entirely** — "Avatar: Fire and Ash" (2025) now outranks it. No
amount of scrolling fixes a target that isn't in the list.

**Diagnosis tell:** `disambig-more` **absent** + the target not found = the list was NOT truncated
(the "more" button only renders past `DISAMBIG_VISIBLE_LIMIT`), so every candidate is on screen and
the target genuinely isn't offered — a *data* problem, not a scroll/timeout one.

**Fix pattern — pick by POSITION, never by name.** US4-AC2 only asserts "tapping a non-first
candidate resolves to *that* candidate," which is independent of which films TMDB returns today:
- **Web** (`agent-disambiguation.spec.ts`): read slot 1's label (`disambig-option-1`), parse
  `${title} (${year})`, tap it, and assert the rendered card matches **what you read**. Full semantic
  check, zero hardcoded film.
- **Mobile** (`agent-disambiguation.yaml`): tap by testID and assert **structurally** (a titled card
  rendered, options collapsed). Maestro can't do the read-and-assert safely — its `text:` selector is
  a **regex**, so interpolating a captured label containing `(YYYY)` reintroduces the capture-group
  trap that #539 fixed.

**Do NOT make every hardcoded title dynamic.** `assistant-disambiguate.{spec.ts,yaml}` hardcodes the
same film on purpose: there the user *types* the full title (drift-irrelevant), and its bug-1
regression needs a pair where one title is a substring of the other (`Avatar` ⊂ `Avatar: The Way of
Water`). That hardcoding is load-bearing — making it dynamic destroys what it guards.

**Separate class — live-model non-determinism.** The other failure mode ("the assistant didn't
disambiguate at all", `disambiguation-options` never appears) is the model answering directly, not
drift. Mitigated only by the bounded retry; if it recurs, treat it as its own issue, not a selector
fix.

## BFF Integration Test Harness (mcm-app)

BFF integration tests (`frontend/mcm-app/tests/integration/*.integration.test.ts`) run against **real** Keycloak + Redis + mc-service (constitution v1.3.0 — no mocking) via a dedicated `frontend/mcm-app/jest.integration.config.js` (**not** the package.json `jest` block). Run: `pnpm nx test:integration mcm-app`. The unit target (`pnpm nx test mcm-app`) excludes `tests/integration/`. Key facts (so they aren't rediscovered):

- **Node env + serial:** `testEnvironment: 'node'`, `maxWorkers: 1` (tests share Redis db 1 and the live BFF — parallel `flushdb`/teardown would wipe another file's data mid-test), `forceExit: true` (cache-service leaves an `ioredis` handle open with no public close).
- **Module-resolution stubs:** `babel-preset-expo` (reused for the TS transform) injects `import { env } from 'expo/virtual/env'`, and BFF source transitively imports `react-native` (`Platform.OS` in `@/config/keycloak`). Both are stubbed via `moduleNameMapper` → `tests/integration/setup/{expo-env-stub,react-native-stub}.js` so Node can import server source; `@/` maps to `src/`. (The unit suite avoids this only because `jest-expo` transforms expo/RN.)
- **Env + Redis isolation:** `tests/integration/setup/env.ts` loads `.env.e2e.local` (ROPC creds) then `.env.local` (service-account secret), then **pins `REDIS_URL` to db 1**. The running BFF uses **db 0** — HTTP-level session tests (logout, refresh) seed/inspect db 0 via `helpers/bff-redis-client.ts`; in-process module tests use db 1 via `helpers/redis-test-client.ts`.
- **Real tokens:** `helpers/keycloak-test-client.ts` acquires tokens via the **test-only `mcm-bff-test` ROPC client** and manages users through the Admin API (raw `fetch`, no admin-client lib). Call **`ensureRopcAudienceMapper()` in `beforeAll`** for any test that hits `validateJwt` or mc-service — without the audience mapper, ROPC tokens (`azp=mcm-bff-test`) are rejected as "Invalid token audience". The ROPC grant must never be enabled on the production `movie-collection-manager` client.
- **Headless-untestable happy paths (justified E2E exclusions, enforced by the gate):** login PKCE code exchange, `/auth/refresh` token rotation (production-client refresh token is browser-PKCE-only), and `/auth/verify-email` (Keycloak email action-token). `tests/integration/route-coverage.integration.test.ts` + `route-coverage-map.ts` fail if any `+api.ts` route lacks a test or a justified exclusion — login is the only map-level exclusion.

## The integration tier runs in CI — all three projects (feature 041)

The `test:integration` tier is enforced in CI via the **`app-e2e`** job (`.forgejo/workflows/app-ci.yml`), reusing
the stack that job already stands up (no separate integration stack, no new host ports, no new secrets). Three
steps run **after** bring-up and **before** the web/APK/emulator legs (fast-fail):

1. **Agent** (`movie-assistant`) — `-m "not golden and not ci_quarantine"`. Un-quarantine is in progress; see
   `specs/041-integration-test-ci-enforcement/IMPLEMENTATION-STATUS.md` + memory `project_mcm_agent_integration_ci`.
2. **mc-service** — vs the live replica-set Mongo (`27017`, `directConnection=true`) + Keycloak JWKS. The ~24
   full-stack HTTP tests marked `#[ignore = "requires Keycloak JWKS timing; verified in E2E"]` stay ignored (they
   need in-process JWKS timing that's flaky under `build_test_app`) — running them is a tracked follow-up.
3. **mcm-app BFF** — vs the live dev BFF (`:8082`) + Keycloak + Redis db1 + BFF Mongo (`:27018`).

**No-false-green convention** (`specs/041-…/contracts/skip-escalation-convention.md`): one env flag
`MCM_REQUIRE_LIVE_STACK=1`, three language-appropriate guards — pytest `conftest` escalates non-allowlisted skips
to failures; jest `globalSetup` (`setup/preflight.global.js`) throws if a required dep is down; the cargo runner
(`scripts/mc-service-integration-guard.mjs`) fails a zero-executed run and bans bare `#[ignore]`.

**Run each locally against the app-e2e stack** (`MCM_REQUIRE_LIVE_STACK=1` + the host-loopback URLs): e.g.
`MC_DB_URL='mongodb://localhost:27017/mc_db?replicaSet=rs0&directConnection=true' KEYCLOAK_URL=http://localhost:8099 pnpm nx test:integration mc-service`;
`BFF_BASE_URL=http://localhost:8082 pnpm nx test:integration mcm-app`.

## Web

Use Playwright CLI for all web UI testing. (requires Expo running on :8081)

- Tests live in `tests/e2e/web/` as `.spec.ts` files
- Run tests: `pnpm exec playwright test`
- Run headed: `pnpm exec playwright test --headed`
- Debug mode: `pnpm exec playwright test --debug`
- Start Expo web first: `CI=1 pnpm exec expo start --web`
