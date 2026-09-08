# Implementation Plan: MCP SDK 2.x migration on an audited baseline

**Branch**: `068-mcp-2x-migration` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/068-mcp-2x-migration/spec.md`

## Summary

Extend `pip-audit` from one Python surface to four, then migrate the MCP SDK from 1.29.1 to 2.2.0
across the agent gateway and the three MCP servers. Two pull requests, in that order, because a red
`sast` on a batched change could not distinguish an advisory the migration introduced from one that
had always been there and nothing was looking for.

The migration is larger than backlog item #310 records. #310 lists two breakages, both real; a real
2.2.0 install surfaces **five**, and the one with teeth is that `streamable_http_client` no longer
takes `auth=` — so `DownscopedTokenAuth`, the code that carries the downscoped backend token, is
rewritten rather than renamed. See [research.md](./research.md) R5.

Two things the spec flagged as unmeasured are now measured. Cross-version interoperability **holds in
both directions** (R4), so the servers and the gateway need not land atomically. And the `host`
parameter new to `streamable_http_app()` is **inert** whenever `transport_security` is passed
explicitly, which all three servers do (R6) — so FR-013 is discharged by a comment, not a value.

## Technical Context

**Language/Version**: Python 3.14 (the four `uv` projects) plus Node 24 guard tests (`node:test`)
for the scanner change. No Rust, no frontend.

**Primary Dependencies**: `mcp` 1.29.1 → 2.2.0 across four `pyproject.toml`/`uv.lock` pairs. The
2.x transitive change is `httpx`/`httpcore`/`httpx-sse` → `httpx2`/`httpcore2` plus `mcp-types`,
`truststore` and (emscripten-marked, never installed) `httpx2-jsfetch`; `pydantic-settings` and
`python-dotenv` leave the three servers. `pip-audit` 2.10.1 via `uv run --with`, `uv` 0.12.10 in CI.

**Storage**: N/A.

**Testing**: `pytest` for the four Python projects (unit + integration; the gateway also has the
`golden` marker tier). `node --test scripts/__tests__/*.test.mjs` for the scanner guards, run by
`guardrails / naming`. `guardrails / sast` is the gate that Phase 1 changes. Playwright `@gate`
agent E2E for the merge signal on Phase 2.

**Target Platform**: Forgejo Actions on the single self-hosted runner; the four services run under
local Compose and production Komodo stacks.

**Project Type**: Dependency migration plus CI-scanner coverage change within the existing monorepo.

**Performance Goals**: N/A. The one measurable cost is CI: three added `uv sync --frozen` steps and
three added advisory passes in the `sast` job — roughly +50% on `pip-audit`'s share, since each
server is ~55 packages against the gateway's ~185, not +300%.

**Constraints**: `pip-audit` must keep failing closed when advisory data is unreachable, across four
surfaces rather than one (FR-008). Token custody is NON-NEGOTIABLE per the constitution's Identity
Propagation rule — no credential may reach checkpointed state, traces or logs (FR-020). Suppression
entries must fail loudly rather than match nothing (FR-005). Phase 2 may not start until Phase 1 is
green on `main` (SC-007).

**Scale/Scope**: Phase 1 — 1 scanner function generalized, 1 finding field changed, 1 suppression
entry retired, 1 guard test file, 3 CI steps, 2 docs. Phase 2 — 4 `pyproject.toml` + 4 `uv.lock`,
3 server modules, 1 gateway transport module, 14 renamed field reads across 3 test/source files,
2 integration-test harnesses, 1 new annotation guard.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Assessment |
|---|---|---|
| **AI Assistant Constraints** | Yes | Scoped to the spec. The `click` suppression is retired because it demonstrably suppresses nothing (R3), not as drive-by tidying. No unrelated refactoring of the servers while their files are open. |
| **Behavior-Descriptive Identifiers** | Yes | New test names describe the behaviour asserted (e.g. *a suppression written for one project does not suppress another*), never `FR-004`. Requirement IDs appear only in provenance comments. |
| **Test-Driven Development (NON-NEGOTIABLE)** | Yes | Every guard is written and **seen to fail** before the code it constrains changes. `tasks.md` must carry Verify RED / Verify GREEN per the tasks-template. Note the measured trap: `node --test <file> --test-name-pattern "x"` silently runs everything — node's flags go BEFORE the path. |
| **Test Type Integrity (NON-NEGOTIABLE)** | Yes | No test changes tier. The two server integration suites swap one in-process client construction for another (`create_connected_server_and_client_session` → `Client(server)`); both are in-process harnesses over the **real** server object, and the real collaborators behind it (mc-service, TMDB) stay real exactly as today. Nothing newly mocked. |
| **Identity Propagation (NON-NEGOTIABLE)** | Yes | **The principal risk of this feature.** FR-014/FR-015/FR-020 govern it. The rewritten transport must keep both credentials per-call and independently omitted, release the client on both paths, and persist neither. Asserted by the gateway integration tests against live `movie-mcp` and `web-api-mcp`. |
| **Agent Security** | Yes | The DNS-rebinding posture is deliberately disabled today and must stay exactly as disabled — not more, not less — after moving configuration point (FR-012, R6). |
| **AI Agent Technology Stack** | Yes | Python remains the AI-layer language; `mcp` remains the MCP SDK. A major bound moves; no technology is introduced or replaced. |
| **Testing tiers / what gates a merge** | Yes | Phase 2's merge signal is golden + `@gate` E2E; the `@model-decision` tier runs non-blocking. Per repo rule, run the tiers the **diff** touches: `nx lint`/`nx test` for all four Python projects, not only the ones remembered. |

**Result: PASS.** No violations to justify; Complexity Tracking is therefore omitted.

## Project Structure

### Documentation (this feature)

```text
specs/068-mcp-2x-migration/
├── plan.md              # This file
├── research.md          # Phase 0 — the nine measured decisions
├── data-model.md        # Phase 1 — the five entities the spec names
├── quickstart.md        # Phase 1 — how to validate each phase
├── contracts/
│   ├── pip-audit-finding.md    # the project-qualified location contract
│   └── mcp-tool-result.md      # the result contract that must not shift
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
scripts/
├── sast-scan.mjs                       # runPipAudit: 1 surface → 4; location gains project
├── check-sast-findings.mjs             # gate; selftest covers the qualified form
└── __tests__/
    └── sast-scan.guard.test.mjs        # + qualified-location and unmatched-entry guards

security/sast/
└── allowlist.yaml                      # retire the click entry; correct the stale comment

.forgejo/workflows/
└── guardrails.yml                      # sast job: +3 `uv sync --frozen` steps

docs/runbooks/
└── sast-scanning.md                    # scanner table: surface is 4 projects, not 1

agents/movie-assistant/
├── pyproject.toml + uv.lock            # mcp >=2,<3
└── src/tools/mcp_tools.py              # DownscopedTokenAuth, transport, field renames

mcp-servers/{movie-mcp,spreadsheet-mcp,web-api-mcp}/
├── pyproject.toml + uv.lock            # mcp >=2,<3
├── src/server.py                       # MCPServer; transport kwargs move to build_app()
└── tests/integration/test_server.py    # Client(server) harness; field renames
                                        #   (spreadsheet-mcp has no such suite)
```

**Structure Decision**: No new directories, no new projects. The change is confined to the four
existing Python projects, the one scanner script and its guard test, one CI workflow job, and two
documents. Every path above already exists.

## Phase ordering and the merge gate

**Phase 1 lands alone, on `mcp` 1.29.1.** Its value does not depend on Phase 2 and its green result
is the baseline Phase 2 is measured against (SC-002). Measured today: all three servers report zero
advisories on 1.x, so Phase 1 should land green with no triage.

**Phase 2 lands second, after Phase 1 is on `main`.** Within it, R4 permits the servers and the
gateway to be separate commits — but they ship in **one** pull request, because
[pull-request-batching.md](../../openwiki/process/pull-request-batching.md) says split only when a
red would be ambiguous, and here it would not be: a red inside Phase 2 is the migration's either
way. Splitting further would buy a second ~35-minute E2E cycle for nothing.

## Constitution re-check (post-design)

Re-evaluated after Phase 0/1. **Still PASS**, with two gates strengthened rather than weakened by
what the research found:

- **Identity Propagation** — R5 confirmed the credential-carrying code is rewritten, not renamed, and
  that the caller now owns the HTTP client's lifetime. This produced a genuinely new invariant
  (contract §3, INV-8: released on both paths) that did not exist on 1.x, where the transport owned
  the client. The gate is tighter after design than before it.
- **Test Type Integrity** — R5 also confirmed the replacement in-process harness is the **public**
  `Client(server)`, not the private `_memory` module. No test changes tier and nothing is newly
  mocked.

No new violations. Complexity Tracking remains omitted.
