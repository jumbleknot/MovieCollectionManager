# Phase 8 — Control Tower Un-defer (OPA · Unleash · OpenSearch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement task-by-task. Steps use checkbox
> (`- [ ]`) syntax. This document is the executable detail for **tasks.md Phase 8 (T074–T077)** and
> **research R16** — those remain the plan-of-record; this adds the design-bearing code + TDD
> sequencing. SDD is source of truth (do NOT create a parallel `docs/superpowers/` plan — session-4
> lesson).

**Goal:** Bring the three deferred Control-Tower services into scope as real deployed services —
OPA (token-exchange + UI-action authz), Unleash (config-gated flags over the env flags), and a
config-deployable OpenSearch append-only audit sink — in the order OPA → Unleash → OpenSearch.

**Architecture:** Every piece is **config-gated + additive (SC-005)**: with its service URL unset
the behavior is byte-for-byte today's (env flags / TS authorizer / stdout audit); with it set the
service is authoritative (OPA fails closed). The in-code seams already exist — this stands up the
servers, authors the Rego policies / Unleash flags, ships audit, and adds real-service integration
tests. OPA + Unleash fold into `--profile observability`; OpenSearch is its own `--profile audit`.

**Tech Stack:** OPA (Rego, REST `/v1/data`), Unleash (`unleashorg/unleash-server` + Python
`UnleashClient` SDK), OpenSearch (single-node, `opensearch-py` / `fetch`), Docker Compose profiles,
pytest (`@nxlv/python`), Jest (BFF).

---

## File Structure

**OPA (T074)**
- Create `infrastructure-as-code/opa/policies/agent_token_exchange.rego` — exchange decision + `*_test.rego`.
- Create `infrastructure-as-code/opa/policies/agent_ui_action.rego` — UI-action decision + `*_test.rego`.
- Modify `infrastructure-as-code/docker/observability/compose.yaml` — add the `opa` service.
- Create `agents/movie-assistant/tests/integration/test_opa_authz.py` — gateway vs real OPA.
- Create `frontend/mcm-app/src/bff-server/opa-client.ts` — fetch-based OPA client (fail-closed).
- Modify `frontend/mcm-app/src/app/bff-api/agent/ui-action+api.ts` — consult OPA, fall back to TS.
- Create `frontend/mcm-app/src/bff-server/unit-tests/opa-client.test.ts` + a Rego/TS parity test.
- `agents/movie-assistant/src/tools/opa.py` — **unchanged** (already wired; only proven live).

**Unleash (T075)**
- Create `agents/movie-assistant/src/flags.py` — `FlagProvider` / `EnvFlags` / `UnleashFlags`.
- Modify `agents/movie-assistant/src/kill_switch.py`, `src/models.py`, `src/circuit_breaker.py` /
  `src/graph.py` call sites — consult the provider (signatures unchanged).
- Modify `infrastructure-as-code/docker/observability/compose.yaml` — `unleash` + `unleash-postgres`
  + `unleash-seed`.
- Create `agents/movie-assistant/tests/unit/test_flags.py` + `tests/integration/test_unleash_flags.py`.

**OpenSearch (T076)**
- Create `infrastructure-as-code/docker/opensearch/compose.yaml` — single-node, 1 GB heap, audit user.
- Modify root `compose.yaml` — `include:` the opensearch compose.
- Create `agents/movie-assistant/src/audit_sink.py` + `frontend/mcm-app/src/bff-server/audit-sink.ts`.
- Modify `agents/movie-assistant/src/tools/mcp_tools.py` (tool-call + `_dead_letter`) and the BFF
  `run+api.ts` / `resume+api.ts` / `ui-action+api.ts` audit call sites to fan out through the sink.
- Create `tests/unit` + `tests/integration` audit-sink tests both sides.

**Docs (T077):** `.env.local.example`s, agent README, root `CLAUDE.md`.

---

## Slice 1 — OPA (T074)

### Task 1: OPA server in the observability profile (T074a)

**Files:** Modify `infrastructure-as-code/docker/observability/compose.yaml`.

- [ ] **Step 1: Add the service** (under `services:`, mirroring the existing `profiles:`/`networks:`/`logging:` style):

```yaml
  # ── Open Policy Agent — agent authorization decisions (token-exchange + UI-action, R16) ──────
  opa:
    image: openpolicyagent/opa:latest
    container_name: opa
    profiles: [observability]
    restart: unless-stopped
    command:
      - "run"
      - "--server"
      - "--addr=0.0.0.0:8181"
      - "--log-level=info"
      - "/policies"
    volumes:
      - ../../opa/policies:/policies:ro
    ports:
      - "127.0.0.1:8181:8181"
    networks:
      - backend-network
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:8181/health"]
      interval: 10s
      timeout: 5s
      retries: 10
    logging: *obs-logging
```

- [ ] **Step 2: Bring it up and verify**

Run: `docker compose --profile observability up -d opa`
Then: `curl -s http://localhost:8181/health` → Expected: `{}` (HTTP 200).

- [ ] **Step 3: Commit**

```bash
git add infrastructure-as-code/docker/observability/compose.yaml
git commit -m "feat(012): T074a OPA server in observability profile"
```

### Task 2: Token-exchange Rego policy (T074b)

**Files:** Create `infrastructure-as-code/opa/policies/agent_token_exchange.rego` +
`agent_token_exchange_test.rego`.

- [ ] **Step 1: Write the failing test** (`agent_token_exchange_test.rego`):

```rego
package mcm.agent_token_exchange

test_allow_mc_service_agent_origin {
    allow with input as {"user_id": "u1", "audience": "mc-service", "agent_origin": true}
}
test_deny_wrong_audience {
    not allow with input as {"user_id": "u1", "audience": "other", "agent_origin": true}
}
test_deny_non_agent_origin {
    not allow with input as {"user_id": "u1", "audience": "mc-service", "agent_origin": false}
}
```

- [ ] **Step 2: Run it — expect FAIL** (no policy yet)

Run: `opa test infrastructure-as-code/opa/policies -v`
Expected: errors / undefined `allow`.

- [ ] **Step 3: Write the policy** (`agent_token_exchange.rego`):

```rego
package mcm.agent_token_exchange

import rego.v1

default allow := false

# An agent-origin caller may exchange ONLY for the mc-service audience (research R3/R16).
allow if {
    input.agent_origin == true
    input.audience == "mc-service"
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `opa test infrastructure-as-code/opa/policies -v` → Expected: 3 passed.

- [ ] **Step 5: Commit** — `git commit -m "feat(012): T074b token-exchange Rego policy + tests"`.

### Task 3: Gateway integration vs real OPA (T074c)

**Files:** Create `agents/movie-assistant/tests/integration/test_opa_authz.py`. (`src/tools/opa.py`
is already the default `AuthorizeFn` — this only proves it live; follow the skip-if-absent pattern
of the other `tests/integration/*` files.)

- [ ] **Step 1: Write the test** (skips when no OPA reachable):

```python
import os
import httpx
import pytest
from src.tools import opa

OPA_URL = os.environ.get("OPA_URL", "http://localhost:8181")

def _opa_up() -> bool:
    try:
        return httpx.get(f"{OPA_URL}/health", timeout=2.0).status_code == 200
    except httpx.HTTPError:
        return False

pytestmark = pytest.mark.skipif(not _opa_up(), reason="OPA not reachable")

@pytest.mark.asyncio
async def test_allows_mc_service(monkeypatch):
    monkeypatch.setenv("OPA_URL", OPA_URL)
    assert await opa.authorize_exchange("u1", "mc-service") is True

@pytest.mark.asyncio
async def test_denies_wrong_audience(monkeypatch):
    monkeypatch.setenv("OPA_URL", OPA_URL)
    assert await opa.authorize_exchange("u1", "some-other-service") is False

@pytest.mark.asyncio
async def test_fail_closed_when_unreachable(monkeypatch):
    monkeypatch.setenv("OPA_URL", "http://127.0.0.1:1")  # nothing listening
    assert await opa.authorize_exchange("u1", "mc-service") is False

@pytest.mark.asyncio
async def test_gated_skip_when_unset(monkeypatch):
    monkeypatch.delenv("OPA_URL", raising=False)
    assert await opa.authorize_exchange("u1", "mc-service") is True
```

- [ ] **Step 2: Run RED first** with OPA down (or the policy absent) to see the deny/allow contract,
  then with `--profile observability up -d opa`:

Run: `pnpm nx test:integration movie-assistant -- -k opa_authz`
Expected: 4 passed (with OPA up).

- [ ] **Step 3: Commit** — `git commit -m "feat(012): T074c gateway OPA authz integration (live)"`.

### Task 4: UI-action Rego policy (T074d)

**Files:** Create `agent_ui_action.rego` + `agent_ui_action_test.rego`. Mirror
`ui-action-authorizer.ts` exactly (navigate → home/collection/movie-detail/profile; prefill →
add-movie; require `mc-user`, mc-admin implies mc-user).

- [ ] **Step 1: Tests first** (`agent_ui_action_test.rego`):

```rego
package mcm.agent_ui_action

test_allow_navigate_collection_mc_user {
    allow with input as {"action_type": "navigate", "target": "collection", "roles": ["mc-user"]}
}
test_admin_implies_user {
    allow with input as {"action_type": "navigate", "target": "home", "roles": ["mc-admin"]}
}
test_allow_prefill_add_movie {
    allow with input as {"action_type": "prefill", "target": "add-movie", "roles": ["mc-user"]}
}
test_deny_unlisted_target {
    not allow with input as {"action_type": "navigate", "target": "admin-panel", "roles": ["mc-user"]}
}
test_deny_missing_role {
    not allow with input as {"action_type": "navigate", "target": "collection", "roles": []}
}
test_deny_unknown_action {
    not allow with input as {"action_type": "delete", "target": "collection", "roles": ["mc-user"]}
}
```

- [ ] **Step 2: Run RED** — `opa test … -v` (undefined).
- [ ] **Step 3: Policy** (`agent_ui_action.rego`):

```rego
package mcm.agent_ui_action

import rego.v1

default allow := false

navigable := {"home", "collection", "movie-detail", "profile"}
prefillable := {"add-movie"}

has_mc_user if input.roles[_] == "mc-user"
has_mc_user if input.roles[_] == "mc-admin"   # mc-admin implies mc-user

allow if {
    input.action_type == "navigate"
    navigable[input.target]
    has_mc_user
}
allow if {
    input.action_type == "prefill"
    prefillable[input.target]
    has_mc_user
}
```

- [ ] **Step 4: Run GREEN** — `opa test … -v` → 6 passed.
- [ ] **Step 5: Commit** — `git commit -m "feat(012): T074d UI-action Rego policy + tests"`.

> Role-string note: confirm the exact role strings the BFF passes (`ClientRole.MCUser` resolves to
> `"mc-user"`); the Rego must use the same wire strings. Verify against `@/types/auth` before Step 3.

### Task 5: BFF OPA client + wire ui-action + parity test (T074e)

**Files:** Create `frontend/mcm-app/src/bff-server/opa-client.ts`; modify
`src/app/bff-api/agent/ui-action+api.ts`; create
`src/bff-server/unit-tests/opa-client.test.ts` + a parity test.

- [ ] **Step 1: Client** (`opa-client.ts`) — gated + fail-closed when configured:

```typescript
import { logger } from '@/bff-server/logger';

const UI_ACTION_DECISION = '/v1/data/mcm/agent_ui_action/allow';

export function isOpaConfigured(): boolean {
  return Boolean((process.env.OPA_URL ?? '').trim());
}

/** Ask OPA whether a UI action is allowed. Allow when OPA is unconfigured (caller falls back to the
 *  TS authorizer); fail CLOSED (false) when OPA is configured but errors/denies. */
export async function opaAllowsUiAction(input: {
  action_type: string;
  target: string;
  roles: string[];
}): Promise<{ configured: boolean; allowed: boolean }> {
  const base = (process.env.OPA_URL ?? '').trim();
  if (!base) return { configured: false, allowed: true };
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}${UI_ACTION_DECISION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!resp.ok) {
      logger.error('OPA ui-action decision non-2xx — denying', { action: 'opa_ui_action', status: resp.status });
      return { configured: true, allowed: false };
    }
    const body = (await resp.json()) as { result?: unknown };
    return { configured: true, allowed: body.result === true };
  } catch (err) {
    logger.error('OPA ui-action request failed — denying', { action: 'opa_ui_action', error: err });
    return { configured: true, allowed: false };
  }
}
```

- [ ] **Step 2: Wire `ui-action+api.ts`** — consult OPA when configured, else the existing TS
  `authorizeUiAction`. (Read the current handler first; replace the single `authorizeUiAction` call
  with: if `isOpaConfigured()` → `opaAllowsUiAction({action_type: action.type, target: action.target, roles: user.roles})`; else the TS function. Preserve the existing audit + 403-discard behavior.)

- [ ] **Step 3: Client unit test** (`opa-client.test.ts`): mock `fetch` — unset URL → `{configured:false, allowed:true}`; `result:true` → allowed; non-2xx → denied; throw → denied.

Run: `pnpm nx test mcm-app -- -t "opa-client"` → Expected: PASS.

- [ ] **Step 4: Parity test** — assert the Rego allowlists equal the TS maps so they never drift.
  Import `NAVIGABLE_TARGETS`/`PREFILL_TARGETS` from `ui-action-authorizer.ts`, read the `.rego`
  file text, assert every TS key appears in the corresponding Rego set and vice-versa.

Run: `pnpm nx test mcm-app -- -t "rego parity"` → Expected: PASS.

- [ ] **Step 5: Integration** vs real OPA: `pnpm nx test:integration mcm-app -- -t "ui-action"` —
  allow (mc-user, collection), deny (no role / unlisted target), and fallback-to-TS when `OPA_URL`
  unset. Add the route to the T028a auth-guard expectations if needed.

- [ ] **Step 6: Commit** — `git commit -m "feat(012): T074e BFF OPA client + ui-action wiring + Rego/TS parity"`.

---

## Slice 2 — Unleash (T075)

### Task 6: Unleash server + Postgres + seed (T075a)

**Files:** Modify `infrastructure-as-code/docker/observability/compose.yaml`.

- [ ] **Step 1: Add the services** (dev creds inline, matching the file's existing convention):

```yaml
  # ── Unleash — agent feature flags / kill-switch (config-gated layer, R16) ───────────────────
  unleash:
    image: unleashorg/unleash-server:latest
    container_name: unleash
    profiles: [observability]
    restart: unless-stopped
    depends_on:
      unleash-postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://unleash:unleash@unleash-postgres:5432/unleash
      DATABASE_SSL: "false"
      INIT_ADMIN_API_TOKENS: "*:*.mcm-dev-unleash-admin-token"
      INIT_CLIENT_API_TOKENS: "default:development.mcm-dev-unleash-client-token"
    ports:
      - "127.0.0.1:4242:4242"
    networks:
      - backend-network
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:4242/health"]
      interval: 10s
      timeout: 5s
      retries: 15
    logging: *obs-logging

  unleash-postgres:
    image: postgres:16-alpine
    container_name: unleash-postgres
    profiles: [observability]
    restart: unless-stopped
    environment:
      POSTGRES_USER: unleash
      POSTGRES_PASSWORD: unleash
      POSTGRES_DB: unleash
    volumes:
      - unleash-pg-data:/var/lib/postgresql/data
    networks:
      - backend-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U unleash -d unleash"]
      interval: 10s
      timeout: 5s
      retries: 10
    logging: *obs-logging

  # One-shot: create the three default-off flags via the admin API (idempotent).
  unleash-seed:
    image: curlimages/curl:latest
    container_name: unleash-seed
    profiles: [observability]
    depends_on:
      unleash:
        condition: service_healthy
    entrypoint:
      - /bin/sh
      - -c
      - |
        for f in mcm.agent.kill-switch mcm.agent.frontier-escalation mcm.agent.degrade; do
          curl -s -X POST http://unleash:4242/api/admin/projects/default/features \
            -H "Authorization: *:*.mcm-dev-unleash-admin-token" \
            -H "Content-Type: application/json" \
            -d "{\"name\":\"$$f\",\"type\":\"kill-switch\"}" || true
        done
        echo "unleash flags seeded (default-off)"
    networks:
      - backend-network
    logging: *obs-logging
```

Add `unleash-pg-data:` under the `volumes:` block.

- [ ] **Step 2: Verify** — `docker compose --profile observability up -d unleash unleash-seed`; then
  `curl -s -H "Authorization: *:*.mcm-dev-unleash-admin-token" http://localhost:4242/api/admin/projects/default/features`
  shows the three flags (each `enabled:false`).

- [ ] **Step 3: Commit** — `git commit -m "feat(012): T075a Unleash server + Postgres + flag seed"`.

> Verify the `INIT_*_API_TOKENS` format + the feature-create payload against the Unleash version the
> image resolves to before relying on the seed (the admin API shape has changed across majors).

### Task 7: Flag provider (T075b)

**Files:** Create `agents/movie-assistant/src/flags.py` + `tests/unit/test_flags.py`.

- [ ] **Step 1: Failing test** (`test_flags.py`):

```python
from src.flags import get_flag_provider, EnvFlags, UnleashFlags

def test_unset_url_returns_envflags():
    assert isinstance(get_flag_provider({}), EnvFlags)

def test_set_url_returns_unleashflags():
    p = get_flag_provider({"UNLEASH_URL": "http://localhost:4242/api"})
    assert isinstance(p, UnleashFlags)

def test_envflags_reads_env_truthy():
    assert EnvFlags({"AGENT_KILL_SWITCH": "true"}).enabled("mcm.agent.kill-switch") is True
    assert EnvFlags({}).enabled("mcm.agent.kill-switch") is False

def test_default_off_for_unmapped_flag():
    assert EnvFlags({}).enabled("mcm.agent.frontier-escalation") is False
```

- [ ] **Step 2: Run RED** — `pnpm nx test movie-assistant -- -k flags` (import error).

- [ ] **Step 3: Implement** (`flags.py`) — interface + the two impls; `UnleashClient` lazy-imported
  so unit tests don't need the SDK; default-off semantics; map flag-name → existing env var for
  `EnvFlags`:

```python
"""Feature-flag provider (research R16). Config-gated: UNLEASH_URL set -> Unleash, else env flags.
Every flag is DEFAULT-OFF so an unconfigured / unreachable provider matches today's behavior."""
from __future__ import annotations
from collections.abc import Mapping
from typing import Protocol

KILL_SWITCH = "mcm.agent.kill-switch"
FRONTIER_ESCALATION = "mcm.agent.frontier-escalation"
DEGRADE = "mcm.agent.degrade"

_ENV_BY_FLAG = {KILL_SWITCH: "AGENT_KILL_SWITCH"}  # only the kill-switch had a pre-existing env flag
_TRUTHY = frozenset({"1", "true", "yes", "on", "disabled"})


class FlagProvider(Protocol):
    def enabled(self, flag: str) -> bool: ...


class EnvFlags:
    def __init__(self, env: Mapping[str, str]) -> None:
        self._env = env

    def enabled(self, flag: str) -> bool:
        var = _ENV_BY_FLAG.get(flag)
        if var is None:
            return False  # default-off (escalation/degrade had no env flag historically)
        return (self._env.get(var) or "").strip().lower() in _TRUTHY


class UnleashFlags:
    def __init__(self, url: str, env: Mapping[str, str]) -> None:
        from UnleashClient import UnleashClient

        self._client = UnleashClient(
            url=url,
            app_name="movie-assistant",
            custom_headers={"Authorization": env.get("UNLEASH_API_TOKEN", "")},
        )
        self._client.initialize_client()
        self._fallback = EnvFlags(env)

    def enabled(self, flag: str) -> bool:
        # Unleash is authoritative; default-off (and env fallback) if it can't answer.
        return bool(self._client.is_enabled(flag, fallback_function=lambda *_: self._fallback.enabled(flag)))


def get_flag_provider(env: Mapping[str, str]) -> FlagProvider:
    url = (env.get("UNLEASH_URL") or "").strip()
    return UnleashFlags(url, env) if url else EnvFlags(env)
```

- [ ] **Step 4: Run GREEN** — `pnpm nx test movie-assistant -- -k flags` (the UnleashFlags
  construction test may need the SDK; if absent, mark that one `importorskip("UnleashClient")`).

- [ ] **Step 5: Commit** — `git commit -m "feat(012): T075b flag provider (env fallback / Unleash)"`.

### Task 8: Wire the three call sites (T075c)

**Files:** Modify `src/kill_switch.py` (+ `src/graph.py`), `src/models.py`, `src/circuit_breaker.py`
(+ its call in `src/graph.py`). Signatures unchanged.

- [ ] **Step 1: Kill-switch** — `assistant_disabled(env)` delegates to the provider:

```python
from src.flags import get_flag_provider, KILL_SWITCH

def assistant_disabled(env: Mapping[str, str]) -> bool:
    """Kill switch engaged? Unleash when UNLEASH_URL is set, else the AGENT_KILL_SWITCH env flag."""
    return get_flag_provider(env).enabled(KILL_SWITCH)
```

Test (`test_graceful_degradation.py` already covers the env path): add a case where a stub provider
returns True → graph short-circuits to `disabled`. Keep the env-unset path identical (regression).

- [ ] **Step 2: Escalation guard** — in `models.py`, before returning the escalation spec, the
  caller checks `get_flag_provider(env).enabled(FRONTIER_ESCALATION)`; off ⇒ escalation tier not
  selected (today's effective behavior). Add a unit test: flag off → escalation not chosen; on →
  chosen. (If escalation isn't routed anywhere yet, gate the selection helper and unit-test the
  helper directly.)

- [ ] **Step 3: Manual degrade** — `ErrorRateBreaker.opened()` OR-s in the flag:
  `return self._auto_opened() or get_flag_provider(env).enabled(DEGRADE)`. Inject `env`/provider via
  `from_env` so the test can force it. Unit-test: flag on → `opened()` True even with zero failures.

- [ ] **Step 4: Run** — `pnpm nx test movie-assistant -- -k "kill_switch or escalation or degrade or graceful"` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(012): T075c route kill-switch/escalation/degrade through the flag provider"`.

### Task 9: Integration vs real Unleash (T075d)

**Files:** Create `tests/integration/test_unleash_flags.py` (skip if `UNLEASH_URL` unreachable).
Toggle each flag via the admin API, assert behavior: kill-switch on → run short-circuits; escalation
on → escalation selectable; degrade on → breaker `opened()`.

- [ ] **Step 1: Write the test** (skip-guard + admin toggle helper).
- [ ] **Step 2: Run** with the profile up — `pnpm nx test:integration movie-assistant -- -k unleash` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(012): T075d Unleash flags integration (live)"`.

---

## Slice 3 — OpenSearch (T076)

### Task 10: OpenSearch compose (own `--profile audit`) (T076a)

**Files:** Create `infrastructure-as-code/docker/opensearch/compose.yaml`; modify root `compose.yaml`
(`include:` it).

- [ ] **Step 1: Compose** (single-node, **1 GB heap hard-pin**, dev admin):

```yaml
name: opensearch

services:
  opensearch:
    image: opensearchproject/opensearch:2
    container_name: opensearch
    profiles: [audit]
    restart: unless-stopped
    environment:
      - discovery.type=single-node
      - bootstrap.memory_lock=true
      # Hard heap cap (R16): without this OpenSearch defaults to ~4 GB and risks OOM-ing the dev box.
      - "OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g"
      - "OPENSEARCH_INITIAL_ADMIN_PASSWORD=Mcm-dev-Audit-1!"
    ulimits:
      memlock: { soft: -1, hard: -1 }
      nofile: { soft: 65536, hard: 65536 }
    volumes:
      - opensearch-data:/usr/share/opensearch/data
    ports:
      - "127.0.0.1:9200:9200"
    networks:
      - backend-network
    healthcheck:
      test: ["CMD-SHELL", "curl -sk -u admin:Mcm-dev-Audit-1! https://localhost:9200/_cluster/health || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 12
      start_period: 40s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  opensearch-data:

networks:
  backend-network:
    external: true
```

- [ ] **Step 2: `include:` from root `compose.yaml`** (add to the `include:` list, matching the
  existing service-compose entries).

- [ ] **Step 3: Verify** — `docker compose --profile audit up -d`; then
  `curl -sk -u admin:Mcm-dev-Audit-1! https://localhost:9200` → 200; and
  `curl -sk -u admin:Mcm-dev-Audit-1! https://localhost:9200/_nodes/jvm | grep heap_max_in_bytes`
  → ≈ `1073741824`.

- [ ] **Step 4: Write-only audit user** — a one-shot init (curl) creates a `agent-audit` role
  (cluster/index `index`+`create_index` on `mcm-agent-audit-*`, **no read/delete**) + user; document
  the prod posture. (For the MVP integration test the admin write + a separate `agent-audit` read-deny
  assertion is sufficient.)

- [ ] **Step 5: Commit** — `git commit -m "feat(012): T076a OpenSearch audit profile (1 GB heap, write-only role)"`.

### Task 11: Python audit sink (T076b)

**Files:** Create `agents/movie-assistant/src/audit_sink.py` + `tests/unit/test_audit_sink.py`;
modify `src/tools/mcp_tools.py`.

- [ ] **Step 1: Failing test** — doc shape + redaction + no-op when unset:

```python
from src.audit_sink import build_audit_doc, audit

def test_doc_has_no_token_or_pii():
    doc = build_audit_doc("tool_call", {"userId": "u1", "threadId": "t1", "tool": "add_movie",
                                        "token": "SECRET", "email": "a@b.c"})
    assert "token" not in doc and "email" not in doc
    assert doc["action"] == "tool_call" and doc["userId"] == "u1"

def test_noop_when_unset(monkeypatch):
    monkeypatch.delenv("OPENSEARCH_URL", raising=False)
    assert audit("tool_call", {"userId": "u1"}) is None  # logs only, no POST
```

- [ ] **Step 2: Run RED** — `pnpm nx test movie-assistant -- -k audit_sink`.

- [ ] **Step 3: Implement** — always log; POST best-effort when configured; redact the logger's
  sensitive keys; date-rolled index; never raise:

```python
"""Append-only agent audit sink (research R16). Always logs (today's behavior); ALSO best-effort
appends to OpenSearch when OPENSEARCH_URL is set. Never a token/PII; never raises."""
from __future__ import annotations
import logging, os
from collections.abc import Mapping
from typing import Any
import httpx

logger = logging.getLogger(__name__)
_REDACT = {"token", "password", "secret", "cookie", "authorization", "email", "username", "code"}

def build_audit_doc(action: str, fields: Mapping[str, Any]) -> dict[str, Any]:
    doc = {k: v for k, v in fields.items() if k.lower() not in _REDACT}
    doc["action"] = action
    return doc

def _index_name() -> str:
    # Date-rolled; caller passes a UTC date via fields if determinism is needed (no Date.now in plan).
    return "mcm-agent-audit"

def audit(action: str, fields: Mapping[str, Any]) -> None:
    doc = build_audit_doc(action, fields)
    logger.info("audit %s %s", action, {k: doc.get(k) for k in ("userId", "threadId")})
    base = (os.environ.get("OPENSEARCH_URL") or "").strip()
    if not base:
        return None
    try:
        auth = (os.environ.get("OPENSEARCH_USERNAME", ""), os.environ.get("OPENSEARCH_PASSWORD", ""))
        httpx.post(f"{base.rstrip('/')}/{_index_name()}/_doc", json=doc, auth=auth, verify=False, timeout=3.0)
    except httpx.HTTPError as exc:  # best-effort — audit must never break the call
        logger.warning("audit append failed (%s)", type(exc).__name__)
    return None
```

- [ ] **Step 4: Wire `mcp_tools.py`** — replace the `_dead_letter` `logger.error` + add a tool-call
  success/failure `audit("tool_call", {...})` (userId/threadId from the run context if available;
  tool name + status; never the token).

- [ ] **Step 5: Run GREEN** — `pnpm nx test movie-assistant -- -k audit_sink` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(012): T076b Python audit sink + mcp_tools wiring"`.

### Task 12: BFF audit sink (T076c)

**Files:** Create `frontend/mcm-app/src/bff-server/audit-sink.ts` +
`src/bff-server/unit-tests/audit-sink.test.ts`; modify `run+api.ts`, `resume+api.ts`,
`ui-action+api.ts`.

- [ ] **Step 1: Sink** — wraps `logger.audit` (keep it) + best-effort OpenSearch POST when configured:

```typescript
import { logger } from '@/bff-server/logger';

export function buildAuditDoc(action: string, fields: Record<string, unknown>): Record<string, unknown> {
  const redact = new Set(['token', 'sessionId', 'password', 'secret', 'cookie', 'authorization', 'code', 'email', 'username']);
  const doc: Record<string, unknown> = { action };
  for (const [k, v] of Object.entries(fields)) if (!redact.has(k)) doc[k] = v;
  return doc;
}

/** Always emits the structured audit log; ALSO appends to OpenSearch when OPENSEARCH_URL is set.
 *  Best-effort — never throws, never blocks the route. */
export async function audit(action: string, fields: Record<string, unknown>): Promise<void> {
  logger.audit(action, fields);
  const base = (process.env.OPENSEARCH_URL ?? '').trim();
  if (!base) return;
  try {
    const auth = 'Basic ' + Buffer.from(`${process.env.OPENSEARCH_USERNAME ?? ''}:${process.env.OPENSEARCH_PASSWORD ?? ''}`).toString('base64');
    await fetch(`${base.replace(/\/$/, '')}/mcm-agent-audit/_doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(buildAuditDoc(action, fields)),
    });
  } catch (err) {
    logger.error('audit append failed', { action: 'audit_append', error: err });
  }
}
```

- [ ] **Step 2: Swap the call sites** — `logger.audit('approval_decision', …)` (run+api/resume+api)
  and `logger.audit('ui_action', …)` (ui-action+api) → `await audit(…)` (or fire-and-forget; keep
  non-blocking). The doc shape is unchanged for the log; OpenSearch gets the same redacted fields.

- [ ] **Step 3: Unit test** — `buildAuditDoc` strips token/PII; `audit` no-op POST when unset (mock fetch).

Run: `pnpm nx test mcm-app -- -t "audit-sink"` → PASS.

- [ ] **Step 4: Commit** — `git commit -m "feat(012): T076c BFF audit sink + run/resume/ui-action wiring"`.

### Task 13: Integration vs real OpenSearch (T076d)

**Files:** Create `tests/integration/test_audit_opensearch.py` (Python) + a BFF integration spec.
Skip if `OPENSEARCH_URL` unreachable.

- [ ] **Step 1** — with `--profile audit` up, drive an approval decision + a ui-action + a tool-call;
  query `mcm-agent-audit-*/_search` (as admin) → assert three docs with `userId/threadId/action`,
  **no token/PII**; then assert the `agent-audit` write-only account `GET _search` / `DELETE` is 403
  (append-only proof).
- [ ] **Step 2: Run** — `pnpm nx test:integration movie-assistant -- -k audit_opensearch` +
  `pnpm nx test:integration mcm-app -- -t "audit-opensearch"` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(012): T076d OpenSearch audit integration (append-only, write-only account)"`.

---

## Slice 4 — Docs + additivity (T077)

### Task 14: Docs (T077a)

- [ ] Update `.env.local.example`s (`OPA_URL`, `UNLEASH_URL`/`UNLEASH_API_TOKEN`,
  `OPENSEARCH_URL`/`_USERNAME`/`_PASSWORD`), agent README, root `CLAUDE.md` (observability profile
  now includes OPA + Unleash; new `--profile audit` for OpenSearch + the 1 GB heap rationale).
- [ ] Commit — `git commit -m "docs(012): T077a Control-Tower env + profiles + heap rationale"`.

### Task 15: Additivity proof (T077b)

- [ ] With NO Control-Tower URLs set, rebuild + redeploy the gateway + BFF images, then
  `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` → green (no-op default). Golden replay
  unaffected: `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → green.
- [ ] Targeted smoke with the services up: OPA enforcing the exchange + ui-action, a flag toggled
  (kill-switch flips the assistant off then on), an audit doc landing in OpenSearch.
- [ ] Update HANDOFF + the Completion Checklist; commit — `git commit -m "test(012): T077b Phase 8 additivity + configured-path smoke"`.

---

## Self-Review

- **Spec coverage (R16):** OPA exchange (Task 2/3) + UI-action (Task 4/5, one Rego engine) ✓;
  Unleash config-gated layer with env fallback (Task 7/8) + default-off seed (Task 6) ✓; OpenSearch
  separate `--profile audit` + 1 GB heap (Task 10) + direct write-only clients both sides
  (Task 11/12) + append-only/write-only proof (Task 13) ✓; observability profile for OPA+Unleash
  (Task 1/6) ✓; env vars + docs (Task 14) ✓; additivity (Task 15) ✓.
- **Type/name consistency:** flag constants (`KILL_SWITCH`/`FRONTIER_ESCALATION`/`DEGRADE`) shared
  between `flags.py` and the seed flag names (`mcm.agent.kill-switch`…) ✓; the OPA decision paths
  (`/v1/data/mcm/agent_token_exchange/allow`, `/v1/data/mcm/agent_ui_action/allow`) match the Rego
  `package` names ✓; `build_audit_doc`/`audit` names consistent both sides ✓.
- **Open verifications flagged inline** (do before coding the dependent step): exact Unleash image
  version's admin-API payload + token format (Task 6); the wire role strings from `@/types/auth`
  (Task 4); the OpenSearch 2.x security-config shape for the write-only role (Task 10 Step 4).
- **No-Date determinism:** the audit index is a fixed name (`mcm-agent-audit`) rather than
  `Date.now()`-rolled, to stay deterministic; date-rolling is a prod ISM concern (out of scope, R16).
