# Quickstart: verifying the settings split

**Feature**: `062-settings-split` | **Date**: 2026-08-23

How to prove this feature works. Every command below is the real invocation for this repository —
not a sketch. Read §0 first: most wrong answers in this repo come from the instrument, not the code.

---

## 0. Instrument checks — before believing any result

- **A skipped test reads as a pass.** Watch the SKIP COUNT, not just the pass count. If it moves,
  something stopped being tested.
- **`pnpm nx e2e mcm-app` does not exist as a web target**, and its absence is a fact about the Nx
  target, not about whether web E2E can run here. Chromium cannot be installed in this dev
  container; the official Playwright image has it baked in. Use the recipe in §3.
- **The BFF image is baked, not mounted.** A `testID` you just renamed is invisible to any
  container-mode E2E until `mcm-app` is rebuilt. Prove it before running:
  ```bash
  docker run --rm --entrypoint sh mcm-bff:latest -c "grep -rl settings-nav-admin /app/runtime/dist | head -1"
  ```
  Empty output means the image is stale — rebuild with `pnpm nx docker-build mcm-app`. Note the
  path is `/app/runtime/dist`, not `/app/dist`; the wrong path returns empty and looks identical
  to a stale image.
- **Put node's flags before the script path.** `node --test <file> --test-name-pattern "x"`
  silently runs *everything*, because everything after the path becomes the script's own `argv`.
  This will turn a Verify RED into "all green" while filtering nothing.

---

## 1. Static tiers — run these first, they are fast and cheap

```bash
pnpm nx typecheck mcm-app
pnpm nx lint mcm-app
pnpm nx lint design-system
```

`typecheck` is the cheapest detector of a missed route rename: a deleted route referenced by
`router.push` fails to compile.

---

## 2. Unit tiers

```bash
pnpm nx test mcm-app          # sub-navigation, three new screens, nav bar, sanitizer allowlist
pnpm nx test design-system    # Tabs testID reaches a host node
pnpm nx test movie-assistant  # evidence for "the gateway needs no change" — not a formality
```

**Expected, and the point of running it**: `movie-assistant` is fully green with **zero** source
changes under `agents/`. `test_current_screen_contract.py` and `test_context_resolution.py` pass
untouched. If either goes red, the claim in [research.md](./research.md) §R2 is wrong and the
gateway does need updating — find out here, not in CI.

---

## 3. Web E2E

Chromium is not installable in this dev container. Use the official image with `--network host`,
matching the Playwright version in `frontend/mcm-app/package.json`:

```bash
docker run --rm --network host -v "$PWD":/work -w /work/frontend/mcm-app \
  -e E2E_BFF_TARGET=dev-container -e E2E_AGENT_PROVIDER=anthropic \
  -e E2E_TEST_USER -e E2E_TEST_PASSWORD -e ANTHROPIC_API_KEY -e TMDB_API_KEY -e CI=1 \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  sh -c "corepack enable && pnpm exec playwright test"
```

Narrow to the touched specs while iterating (Test Run Protocol: isolated first, story suite second,
full suite only at final validation):

```bash
… sh -c "corepack enable && pnpm exec playwright test admin-card auth assistant-config"
```

Tier selection is `E2E_TIER` in `playwright.config.ts` — **never** `--grep-invert`, which
Playwright 1.60+ accepts here and silently does nothing:

```bash
E2E_TIER=gate    # blocking merge gate
E2E_TIER=model   # @model-decision only, non-blocking
# unset → everything, the local default
```

---

## 4. Mobile E2E

```bash
pnpm nx e2e:mobile mcm-app
```

Needs the Android emulator, which requires `/dev/kvm` — available on the Docker Desktop / DinD
path, **not** on the Docker Sandbox microVM. If you are on the microVM, this tier runs in CI; say
so explicitly rather than reporting the suite as passing.

---

## 5. Scenario walkthrough — what "working" looks like

Each row maps to an acceptance scenario in [spec.md](./spec.md).

| # | Do this | Expect |
| --- | --- | --- |
| 1 | Log in, look at the top app bar | `nav-settings`, labelled **Settings**. No `nav-profile` anywhere. |
| 2 | Select Settings | Lands on `/(app)/settings`; `settings-profile-screen` visible; `settings-nav` above it with Profile active |
| 3 | Select Movie Assistant | URL is `/(app)/settings/assistant`; `assistant-config` visible; `settings-nav` still shown; Movie Assistant active |
| 4 | Reload the browser on `/(app)/settings/backups` | `settings-backups-screen` renders directly — no flash of the profile area first |
| 5 | Edit and save the assistant config, then close and reopen the dock | Availability updates in-session — no reload, no re-login |
| 6 | As `mc-admin`, open Settings | `settings-nav-admin` present; selecting it renders `admin-settings-screen` |
| 7 | As `mc-admin`, toggle self-registration | Behaves as before, including hiding the Create Account link |
| 8 | As `mc-user`, open Settings | `settings-nav-admin` has count **0** — absent from the DOM, not merely invisible |
| 9 | As `mc-user`, go straight to `/(app)/settings/admin` | Refused by `ProtectedRoute`. `admin-settings-screen` count **0**. This is the assertion that matters. |
| 10 | Go to `/(app)/profile` | Unmatched route. `settings-profile-screen` count 0 — the removal is real, not a silent alias |
| 11 | Go to `/(app)/admin/settings` | Unmatched route. `admin-settings-screen` count 0 |
| 12 | Ask the assistant "add Heat to this" while on a settings area | It clarifies — no settings label resolves a collection target |

---

## 6. Platform Parity Table — pre-drafted

`tasks.md` must carry this table; the justifications are settled here so the task author does not
have to re-derive them.

| Scenario | Web (Playwright) | Mobile (Maestro) | Note |
| --- | --- | --- | --- |
| Nav bar reads Settings | ✅ | ✅ | |
| Sub-navigation renders, switches area | ✅ | ✅ | |
| Profile area content + logout | ✅ | ✅ | |
| Assistant config reachable and saves | ✅ | ✅ | Existing `assistant-config-*` flows, renavigated |
| Backups placeholder renders | ✅ | ✅ | |
| Admin entry visible to admin, absent for user | ✅ | ✅ | Reworked from the deleted card's specs |
| Admin route refuses a non-admin **by direct URL** | ✅ | **N/A** | Maestro drives the app UI and has no address-bar equivalent; there is no in-app affordance to a route the user cannot see, so the case is unreachable from a Maestro flow. Web covers it, and the guard is platform-agnostic React (`ProtectedRoute` → `AuthGuard`). |
| Cold deep-link to each area | ✅ | **N/A** | Same reason. Native deep-linking is verifiable by `adb shell am start -a android.intent.action.VIEW -d …`, which is outside the Maestro flow model. |
| Old addresses are unmatched | ✅ | **N/A** | Same reason — the routes are deleted, so no in-app affordance can reach them. |

---

## 7. Final validation

Before opening the pull request, in this order:

1. `pnpm nx affected -t typecheck,lint,test` — catches a tier you did not think of. This is how
   eight ruff findings surfaced in a previous session where only `test` had been run.
2. The three unit tiers in §2 explicitly — `affected` will not select `movie-assistant`, because no
   Python file changed, and that run is evidence for a claim.
3. Web E2E gate tier (§3).
4. Mobile E2E (§4), or an explicit statement that it ran in CI and why not locally.
5. Grep for leftovers and require **zero** hits:
   ```bash
   grep -rn "nav-profile\|profile-screen\|(app)/profile\|profile-admin-settings-card" \
     frontend/mcm-app/src frontend/mcm-app/tests | grep -v node_modules
   ```
6. Confirm no test was skipped, disabled, or weakened to accommodate the change. If a guard broke
   because the premise it protected genuinely changed, update it at the cause — never delete it.
