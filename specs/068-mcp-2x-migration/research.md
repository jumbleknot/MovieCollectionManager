# Phase 0 Research: MCP SDK 2.x migration on an audited baseline

Every decision below is a measurement taken on 2026-09-08, not a reading of upstream documentation.
Where an instrument could not be used, that is stated rather than glossed (R9).

---

## R0 — Instrument check, before any finding is believed

**The gate's exact instrument could not be run here, and a substitute was validated before use.**

`guardrails / sast` runs `pip-audit --format json -s osv` against the **installed** venv in
`agents/movie-assistant` ([sast-scan.mjs:446](../../scripts/sast-scan.mjs#L446)). In this dev
container `api.osv.dev` **does not resolve** — it was never added to
[.devcontainer/egress-allowlist.json](../../.devcontainer/egress-allowlist.json), which lists
`pypi.org` but no advisory host.

Substitute: `pip-audit` 2.10.1 with `-s pypi`, whose feed *is* reachable. Validated for sensitivity
before any conclusion was drawn from it — it reports `PYSEC-2026-2132` for `click 8.2.0`, carrying
aliases `CVE-2026-7246` and `GHSA-47fr-3ffg-hgmw`, i.e. the same advisory in the same identifier
namespace the gate uses.

**Decision**: report every advisory result in this feature as "PyPI feed, 2026-09-08", and let CI's
OSV run be the authority. **Alternative rejected**: adding `api.osv.dev` to the egress allowlist —
out of scope here, but worth its own backlog item, since "I cannot reproduce the security gate
locally" is a standing cost, not a one-off.

---

## R1 — Two phases, two pull requests, audit first

**Decision**: extend `pip-audit` coverage first, on `mcp` 1.x; migrate second.

**Rationale**: `mcp` 2.x brings the `httpx2` stack into the three MCP servers, and **no scanner
looks at those three projects** — `pip-audit` runs against `agents/movie-assistant` alone.
[allowlist.yaml](../../security/sast/allowlist.yaml) states this deliberately ("pip-audit audits
that venv alone (sast-scan.mjs), so the mcp-servers' own locks were deliberately left untouched").
Batched, a red `sast` could not be attributed. Split, Phase 1 establishes a measured-green baseline
and any Phase 2 red is the migration's.

**Alternatives considered**: one PR (fastest, ambiguous red); two separate specs (cleanest
separation, but the coverage extension is small enough that a second full spec→plan→tasks cycle is
overhead the work does not earn).

**Cost accepted**: one extra CI cycle.

---

## R2 — pip-audit covers four surfaces the same way it covers one

**Decision**: keep the installed-venv mode and apply it four times. `runPipAudit()`
([sast-scan.mjs:436-456](../../scripts/sast-scan.mjs#L436-L456)) loops over four `{project, dir}`
entries; each derives its **own** `agentSet` (full graph) and `runtimeSet` (`--no-dev` subset) from
that project's `uv export`, so runtime-vs-dev scope is never borrowed from the gateway's graph.
CI gains three `uv sync --frozen` steps beside the existing one.

**Rationale**: one mechanism, no second failure mode, and the runbook's "audits the installed venv"
sentence stays true everywhere.

**Alternatives considered and rejected**:

- *Requirements mode (`-r --no-deps`) for the three servers.* Cheaper — no syncs — and it demonstrably
  works for all three today. Rejected because it is a second mechanism inside one scanner, and it
  **already fails for the gateway**: `pip-audit -r` still performs a pip dry-run resolution, and
  `guardrails-ai==0.11.0` requires Python `<3.14` while pip-audit's ephemeral env is 3.14. A mode
  that works for three of four surfaces and breaks on a dependency's `Requires-Python` is a mode that
  breaks silently later.
- *One merged export across all four projects.* Fewest advisory lookups, but conflicting pins across
  projects would need reconciling and a finding loses the project it came from — which is exactly
  what R3 needs.

**Measured cost**: each server is ~55 packages against the gateway's ~185, so roughly +50% on
`pip-audit`'s share of the `sast` job, not +300%.

---

## R3 — Findings carry their project; the click suppression is retired

**Decision**: `location` becomes `` `${project}:${dep.name}@${dep.version}` `` (e.g.
`mcp-servers/web-api-mcp:click@8.5.0`), replacing today's `` `${dep.name}@${dep.version}` ``
([sast-scan.mjs:424](../../scripts/sast-scan.mjs#L424)). The one existing `pip-audit` suppression is
deleted, and a guard test asserts both the qualified format and that a suppression matching nothing
fails.

**Rationale**: with four surfaces, an unqualified `locationPattern` such as `click@.*` suppresses a
risk in `spreadsheet-mcp` **and** in the gateway, silently. This repository has already been bitten
by the adjacent failure — allowlist.yaml records entries that "do not expire, [they] just quietly
match nothing" after `pip-audit` switched identifier namespace. A format change without a guard
repeats that; a guard makes it loud.

**Why retire rather than migrate the click entry**: measured — `click` resolves to **8.5.0** in all
four locks (base *and* candidate), and PyPI reports 8.5.0 clean of `PYSEC-2026-2132`. The entry's own
justification rests on a premise that no longer holds ("pinned at 8.2.0 by a transitive cap blocking
the click>=8.3.3 fix"). It suppresses nothing today, so rewriting its pattern would preserve dead
weight past its 2026-10-12 expiry. Deleting it means a genuine regression re-blocks.

**Timing note**: there is exactly **one** `pip-audit` suppression to reconcile. The format change
will never be cheaper than it is now.

---

## R4 — Cross-version interoperability: MEASURED, both directions

The spec flagged this as assumed. It is now measured, with same-version controls.

A 2.x `MCPServer` and a 1.x `FastMCP` server were each served over streamable HTTP on a local port,
and each was called by both a 1.x and a 2.x client — `initialize`, `list_tools`, `call_tool`:

| client | server | result |
|---|---|---|
| 1.29.1 | **2.2.0** | tools listed, call succeeded, structured content identical |
| 2.2.0 | **1.29.1** | tools listed, call succeeded, structured content identical |
| 1.29.1 | 1.29.1 (control) | pass |
| 2.2.0 | 2.2.0 (control) | pass |

**Decision**: the wire protocol is unchanged, so the gateway and the servers **need not migrate
atomically**. They may be separate commits, and a partially rolled-out deployment is safe.

**Consequence for the plan**: they still ship in one pull request (R1's ambiguity argument does not
apply *within* Phase 2, and a second ~35-minute E2E cycle buys nothing) — but if Phase 2 needs to be
bisected during review, this says it safely can be.

---

## R5 — The migration surface is five changes, not the two #310 records

Measured against a real `mcp` 2.2.0 install. Item #310 lists the first and third.

1. **`FastMCP` → `MCPServer`.** `mcp.server.fastmcp` still exists as a shim that raises with the
   migration URL — a helpful failure, not a silent one. New home: `mcp.server.mcpserver.MCPServer`.
2. **Transport kwargs move off the constructor.** `MCPServer.__init__` accepts **none** of
   `stateless_http`, `json_response`, `transport_security`. All three are now parameters of
   `streamable_http_app()`. So each server's module-level construction loses them and each
   `build_app()` gains them. `TransportSecuritySettings` itself is unchanged (same three fields).
3. **`streamablehttp_client` → `streamable_http_client`**, and **`auth=` is gone**. The 2.x signature
   is `(url, *, http_client: httpx2.AsyncClient | None = None, terminate_on_close: bool = True)`.
   Credentials now ride on a caller-owned client. Also `TransportStreams` is a **2-tuple**, so
   `async with client as (read, write, _)` becomes `as (read, write)`.
4. **camelCase → snake_case on the wire types.** `isError`→`is_error`,
   `structuredContent`→`structured_content`, `inputSchema`→`input_schema`. **14 call sites**, located
   by search: [mcp_tools.py:323,326](../../agents/movie-assistant/src/tools/mcp_tools.py#L323) and
   both server integration suites. Absent from #310's description entirely.
5. **`mcp.shared.memory.create_connected_server_and_client_session` is gone.** That module now
   exports only stream primitives.

**On (3), the one with teeth.** `DownscopedTokenAuth` subclasses `httpx.Auth` and injects the
per-call bearer and the per-run TMDB key from ContextVars. `httpx2.Auth` exposes the **same**
`auth_flow`/`async_auth_flow` contract (verified), so the class ports by changing its base and its
`httpx.Request` annotations. What is genuinely new is the **lifecycle**: an `httpx2.AsyncClient` must
be created, passed in, and closed on both the success and failure paths (FR-015). This is the only
code in the feature that carries a credential, hence the constitution gate in `plan.md`.

**On (5), use the public replacement.** `mcp.client._memory.InMemoryTransport` exists but is a
private module. The **public** `mcp.client.Client(server)` accepts an `MCPServer` directly and was
run end-to-end against a real server here: `list_tools` and `call_tool` both work. FR-017 takes the
public path.

---

## R6 — The new `host` parameter is inert as we use it

**Decision**: keep passing `transport_security` explicitly and do **not** set `host`; record why in a
comment beside the existing DNS-rebinding comment.

**Rationale**: reading `Server.streamable_http_app`, `host` is consulted in exactly one place —

```python
# Auto-enable DNS rebinding protection for localhost (IPv4 and IPv6)
if transport_security is None and host in ("127.0.0.1", "localhost", "::1"):
    transport_security = TransportSecuritySettings(..., allowed_hosts=[...], allowed_origins=[...])
```

`host` is the trigger for the auto-enable branch, and that branch is guarded by
`transport_security is None`. All three servers pass `transport_security` explicitly, so the branch
never runs and `host` is never read. FR-013's requirement to "state host-binding behaviour
explicitly" is therefore discharged by making the inertness explicit — setting a `host` value would
imply a binding effect it does not have. It is **not** the uvicorn bind address; that stays
`MC_MCP_HOST` in each `main()`.

---

## R7 — Dependency resolution and advisories: measured on both sides

All four projects were copied to scratch, their bound changed `mcp>=1.28.1,<2` → `>=2,<3`, and
re-resolved with `uv lock`. The repository was not touched.

**Resolves to `mcp 2.2.0`** in all four.

| project | delta | advisories (base → candidate) |
|---|---|---|
| `agents/movie-assistant` | `mcp 1.29.1→2.2.0`, `+mcp-types 2.2.0`, `−httpx-sse` | 0 → 0 |
| `mcp-servers/movie-mcp` | `+httpx2 2.12.0`, `+httpcore2`, `+httpx2-jsfetch 1.0`, `+mcp-types`, `+truststore 0.10.4`; `−httpx-sse`, `−pydantic-settings`, `−python-dotenv` | 0 → 0 |
| `mcp-servers/web-api-mcp` | as above | 0 → 0 |
| `mcp-servers/spreadsheet-mcp` | as above, plus `−httpx 0.28.1`, `−httpcore 1.0.9` | 0 → 0 |

**The `httpx` → `httpx2` swap reads worse than it is.** `httpx2` (`github.com/pydantic/httpx2`, first
published 2026-05-11) is young. But `httpx2 2.12.0`, `httpcore2`, `httpx2-jsfetch` and `truststore`
are **already in the gateway's lock on `main` today**, pulled by `anthropic==1.3.0` and
`langsmith==0.12.1`. The merge gate has been auditing `httpx2` all along and is green. What changes
is that it enters three projects nothing was auditing — which is precisely what Phase 1 fixes first.

`httpx2-jsfetch` carries the marker `sys_platform == 'emscripten'`; it never installs here.

**Removals are safe**: `pydantic_settings` and `dotenv` have **no import anywhere** under `agents/`
or `mcp-servers/` (searched). They were transitive-only.

**Re-run at implementation time.** Upstream is shipping fast — `mcp 2.2.0` and `mcp 1.30.0` were both
published 2026-09-07 — so `tasks.md` re-runs this comparison rather than trusting the table.

---

## R8 — Structured-content semantics are preserved, but one annotation shape is a trap

**Measured on 2.2.0** against the annotations actually in use:

| tool return annotation | `structured_content` |
|---|---|
| `dict[str, Any]` | the mapping, as-is — **same as 1.x** |
| `list[dict[str, Any]]` | wrapped: `{"result": [...]}` — **same as 1.x** |
| bare `dict` | **`None`** — structured output silently lost |

So `_to_call_result`'s `{"result": ...}` unwrap and both suites' `_payload()` remain correct.

**Exposure check**: all 15 tools across the three servers were AST-parsed — 9 in `movie-mcp`, 4 in
`spreadsheet-mcp`, 2 in `web-api-mcp`. Every one is precisely annotated (`dict[str, Any]` or
`list[dict[str, Any]]`). **No current exposure.**

**Decision**: add the guard anyway (FR-018). Nothing today would catch a future loosening to bare
`dict`, and on 2.x that silently changes what the assistant receives without any test failing. A
regex over source is insufficient — the guard AST-parses each server module and asserts every
`@mcp.tool()`-decorated function has a return annotation that is not `dict`, `list`, `Any` or absent.

---

## R9 — Item #310's own trigger table, refreshed

The item defers itself until one of three triggers fires. **None has**, re-measured today:

| trigger | state | evidence (2026-09-08) |
|---|---|---|
| a security fix lands only in 2.x | **no** | `mcp 1.29.1` reports **zero** advisories on the PyPI feed; so does `1.30.0`. |
| a needed feature or dependency requires 2.x | **no** | all four bounds are `<2` and nothing in any lock demands `>=2`. `langchain-mcp-adapters` — the forcing function the item named — is still absent from the tree. |
| 1.x goes EOL | **no** | **`mcp 1.30.0` was published 2026-09-07**, the same day as 2.2.0. The 1.x line is actively maintained. |

**Decision**: proceed anyway, as scheduled work taken deliberately, and record this table in
`spec.md` so a reviewer sees the migration bought no new exposure and was under no pressure — rather
than inferring urgency that does not exist.

---

## Out of scope, filed rather than done

- **`api.osv.dev` is absent from the dev container's egress allowlist** (R0), so the security gate
  cannot be reproduced locally. Worth a backlog item; not this feature.
- **The `click` suppression's stale premise** is resolved here only because Phase 1 touches that file
  (R3). No other suppression is reviewed.
