# HANDOFF (merge + deploy) — Feature 032: Security Header Hardening

**For**: a fresh session. **State as of**: 2026-07-10. **Branch**: `032-security-header-hardening` (HEAD `b80a877`, clean tree, pushed). Implementation is **DONE and CI-green**; the only remaining work is **merge → prod deploy → post-CD verify**.

## TL;DR — where things stand

- All 14 tasks (T001–T014) complete; `tasks.md` checkboxes + Completion Checklist all ticked (except `e2e:mobile`, which is CI-owned).
- **PR #52** open on the forge (`http://<forge-host>:3000/jumbleknot/mcm/pulls/52`), `state=open mergeable=true`, base `main`.
- **All required CI contexts are `success`** on `b80a877` (combined status = success): `guardrails/*`, `app-ci/changes|affected|mc-service-checks|app-e2e`, plus non-required `app-ci/dast` and `trigger-cd` green too. `app-e2e` passing means the live agent-streaming (SC-005) + mobile agent flows (SC-008) validated in CI.
- Local guardrails gates all pass (secret-scan, inline-secrets, topology-scrub, resource-naming, port-collision).

## THE ONE BLOCKED ACTION — merge PR #52

Merging was **denied by the Claude Code auto-mode classifier**: self-authored PR → `main` triggers an automatic prod deploy; a bare "yes" didn't count as explicit authorization to self-merge an unreviewed PR. **This is expected/correct.** To proceed, either:

1. **Human merges** in the Forgejo UI (gives it a human approver) — recommended.
2. User explicitly authorizes the agent to merge (and, if still classifier-blocked, adds a Bash permission rule for the Forgejo merge endpoint). Merge call that was attempted:
   ```
   POST {PROTO}://{HOST}/api/v1/repos/jumbleknot/mcm/pulls/52/merge  -H "Authorization: token $TOKEN"  -d '{"Do":"merge","delete_branch_after_merge":true}'
   ```
   where `$TOKEN` comes from Git Credential Manager (the write-capable stored forge cred — NOT the read-only `~/.mcm/forgejo-ci-token`). See CLAUDE.md §"Opening PRs" for the credential-fill snippet.

Merge to `main` → `app-ci`'s `trigger-cd` dispatches `cd-deploy(deploy=true)` → Komodo ResourceSync redeploys affected stacks.

## After merge — post-CD stack-health verify (CLAUDE.md §"Post-CD verify")

1. Both `cd-deploy` jobs green for the merged SHA — `build-deploy` **and** `prod-apk` (`prod-apk` alone failing is benign infra).
2. Komodo ResourceSync executed; affected stacks redeployed in `after` order.
3. Health-probe public surfaces: BFF (`mcm.<domain>`) + Keycloak (`auth.<domain>`) respond; agent gateway only via BFF. **Confirm the new headers landed in prod**: `curl -sI https://mcm.<domain>/` shows the CSP + `X-Frame-Options`/`nosniff`/`Referrer-Policy`, no `X-Powered-By`; `curl -sI https://mcm.<domain>/bff-api/auth/init` still shows `content-security-policy: default-src 'none'`.
4. `node scripts/check-prod-ci-port-collision.mjs` green (no change expected — no ports touched).
5. If a health probe fails → deploy self-rolls-back via git-revert; confirm the revert landed and re-probe.

CI monitor: `C:\Users\Steve\.mcm\mcm-ci.sh status <sha>` / the commit-status endpoint (authoritative merge signal). Read-only token at `C:\Users\Steve\.mcm\forgejo-ci-token`; logs only via `ssh ci@<forge-host>`. (See private memory `reference_mcm_ci_monitor_access`.)

## What shipped (for reviewer context)

App-layer, additive; no auth/session change. Files:

- **NEW** `frontend/mcm-app/web-security-headers.js` (+ `.test.js`) — pure CommonJS CSP/header builder.
- **EDIT** `frontend/mcm-app/server.js` — `app.disable('x-powered-by')` + one `app.use` stamping the baseline headers; CSP **path-scoped out of `/bff-api`**; Keycloak origin from env at boot.
- **EDIT** `frontend/mcm-app/src/app/bff-api/agent/run+api.ts` — deletes `Access-Control-Allow-Origin`/`-Credentials` from the CopilotKit runtime Response (body untouched).
- **EDIT** `frontend/mcm-app/Dockerfile` — copies `web-security-headers.js` into the runtime image (runtime stage does NOT copy full source; miss this and the container crashes at boot on `require('./web-security-headers')`).
- **EDIT** `security/zap/allowlist.yaml` — ZAP 10096 allowlisted, scoped to `/_expo/static/.*`.
- **NEW** E2E: `tests/e2e/web/security-headers.spec.ts`, `tests/e2e/web/agent-cors.spec.ts`.
- **DOCS** `security/zap/README.md` + `contracts/security-headers-contract.md` (final CSP recorded).

**Final web CSP** (Surface 1): `default-src 'self'; script-src 'self' 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' <KEYCLOAK_PUBLIC_ORIGIN>; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`.

**Two decisions locked in:**
1. **Strict `script-src` (hash only)** — user-chosen 2026-07-09. Expo's inline hydration script (`globalThis.__EXPO_ROUTER_HYDRATE__=true;`) allow-listed by stable sha256; NO `'unsafe-inline'`/`'unsafe-eval'`. **Accepted residual**: one benign `eval` CSP console line from a 3rd-party `new Function("")` capability probe that degrades gracefully — deliberately NOT silenced with `'unsafe-eval'`.
2. **`form-action 'self'`** added to clear a ZAP 10055 "no-fallback" Medium at zero functional cost.

**Accepted non-gating Mediums** (only exist because a CSP now exists; both deliberate): `img-src https:` (arbitrary TMDB poster hosts) and `style-src 'unsafe-inline'` (RN-Web/Tamagui inline styles). Gate fails only on un-allowlisted **High** → passes.

**DAST re-run result**: 10038/10020/10021/10037/10098 = NONE on the BFF surface; 10096 allowlisted (still in report).

## Env notes for re-validation (if needed)

- Dev-container path: rebuild `pnpm nx docker-build mcm-app` → recreate `docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure up -d mcm-bff-service-nonsecure`. **Rebuild before any container E2E/DAST or you validate a stale image.**
- E2E: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/security-headers.spec.ts tests/e2e/web/agent-cors.spec.ts`.
- DAST: `set -a && . ./frontend/mcm-app/.env.e2e.local && set +a && node scripts/zap-scan.mjs --target local --mode baseline` then `node scripts/check-dast-findings.mjs --report security/zap/reports/report.json`.
- The dev-container runs `NODE_ENV=development` but serves a **production** expo export bundle; the inline hydration script + the `new Function` probe are present in prod too, so the CSP validated here is prod-faithful.
