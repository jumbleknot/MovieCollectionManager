# ZAP scan contexts (feature 031, T009)

Both Automation Framework plans (`../zap-baseline.yaml`, `../zap-full.yaml`) embed the SAME `environment`
+ `script` blocks defined here — the AF YAML has no native `include`, so the shared definition is
documented here and inlined verbatim in each plan. Keeping them identical is a plan invariant
(contract: `specs/031-dast-zap-scanning/contracts/zap-scan-contract.md`).

## Contexts

| Context | Target (Compose DNS) | Auth style | Active scan | Include paths |
|---|---|---|---|---|
| `bff` | `http://mcm-bff-service-nonsecure:3000` | session cookie (`bff-session-refresh.js`) | baseline: no · full: **yes** | `http://mcm-bff-service-nonsecure:3000.*` |
| `mc-service` | `http://mc-service:3001` | bearer JWT (`bearer-auth.js`) | baseline: no · full: **yes** | `http://mc-service:3001.*` |
| `agent-gateway` | `http://movie-assistant-gateway:8000` | bearer JWT (`bearer-auth.js`) | **never** (spider + passive only — clarification Q2, FR-006) | `http://movie-assistant-gateway:8000.*` |

**Keycloak** (`http://keycloak-service:8080`) is reachable for auth (the scripts mint/refresh tokens
against it) but MUST NOT appear as a scan target in any context — it is out of scope.

## Registered scripts (AF `script` job)

Both are ZAP **HTTP Sender** scripts (the type that decorates every spidered/attacked request and can
react to a 401), loaded from `../scripts/`:

- `bearer-auth.js` — injects `Authorization: Bearer <ROPC access_token>` for the `mc-service` and
  `agent-gateway` hosts; re-mints on 401 (survives the 300s token TTL, FR-013).
- `bff-session-refresh.js` — attaches the `mcm_*` cookies (from the gitignored
  `../reports/.auth.local.json` produced by `scripts/dast-bff-login.mjs`) for the `bff` host; refreshes
  via `POST /bff-api/auth/refresh` on 401.

## Network

The ZAP container attaches to the shared external `backend-network`, which is where all four hosts
resolve by DNS. No new published host ports are introduced (FR-016).
