# Quickstart: Spreadsheet Import & Export

How to bring up and exercise feature 014 locally. Assumes the standard dev stack and the agent stack from features 012–013.

## Prerequisites

- Base infra + Keycloak + mc-service: `pnpm nx up-all infrastructure-as-code`
- Agent stack (containerized production-node gateway + MCP, incl. the **new `spreadsheet-mcp`**): build images then bring up — `pnpm nx up-agents-prod infrastructure-as-code` (rebuild `agent-gateway:latest` AND the new `spreadsheet-mcp:latest` after any source change; a stale gateway runs old code → tool-free).
- Web client (Metro) or dev-container BFF (`:8082`) for final E2E.
- Sample import file: `docs/test-data/sample-movies.xlsx` (data tab `Sample`; helper tabs `Lists`/`Category`/`MediaType`/`YesNo` are ignored by design).

## US1 — Optional language (web + mobile)

1. Run mc-service unit + integration: `pnpm nx test mc-service` then `pnpm nx test:integration mc-service`.
2. Web: open the add-movie form, leave Language blank, save → movie created, no error; appears in the list with a neutral language placeholder.
3. Verify filter/sort by language groups the language-less movie consistently.
4. E2E: `pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts` (language-optional cases) and the Maestro `movie-add` flow.

## US2/US4 — Import (web)

1. In the assistant dock: "import this spreadsheet" → file picker (BFF `import-upload` stashes the file, returns a handle).
2. The assistant parses tabs (`spreadsheet-mcp.parse_spreadsheet`), ignores ineligible tabs, and for the `Sample` tab (matches no collection) **prompts** for the target collection via disambiguation buttons.
3. Medium-confidence columns (e.g. `Plot`/`Outline`→overview) prompt for confirmation; `Set`/`Pick`/`Top` are silently ignored (low confidence).
4. A title like `"…, The"` is normalized to leading-article form; an uncertain trailing word prompts.
5. **Preview** appears (per-tab create/update/skip counts). Exclude a tab if desired, then **Confirm**.
6. Writes run chunked with progress; the result summary reports created/updated/skipped/failed. On-screen lists refresh (dock data-revision).
7. Re-run the same file → 0 created, 0 unintended changes (idempotent).

**Tests**: `pnpm nx test movie-assistant` (unit + leak scan) → `pnpm nx test:integration movie-assistant` (real MCP + mc-service) → golden replay (`LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`) → web E2E via `node scripts/agent-e2e.mjs` (containerized gateway). **Re-record intent cassettes** after the supervisor-prompt change and run the FULL agent E2E (routing regressions don't show in stubbed integration).

## US3 — Export (web)

1. "export my collections to a spreadsheet" → multi-select collections (buttons).
2. The assistant reads each collection (`list_movies`, all pages), builds one `.xlsx` (`build_workbook`), and surfaces a download (BFF `export-download` streams it).
3. Verify: one tab per selected collection, one column per attribute (no collection/user fields), multi-values pipe-joined; opens in Excel/Sheets.
4. **Round-trip**: export a collection, then import the produced file back → same multi-value sets (order-independent), no duplicate movies.

## Gotchas (carried from 012/013)

- Rebuild BOTH `agent-gateway:latest` (agent source) and `mcm-bff:latest` (`pnpm nx docker-build mcm-app`, for frontend/BFF changes) before agent E2E — the runner only RECREATES containers, never rebuilds.
- `spreadsheet-mcp` must set `enable_dns_rebinding_protection=False` or the gateway's MCP client 421s on the Docker service-name Host.
- `production_nodes_enabled` needs BOTH MCP URLs set + the new server registered, or the gateway serves the tool-free graph.
- Run agent E2E specs isolated per file (parallel = per-user rate-limit + ~5-min token expiry → `no_token`).
- Mobile import/export is intentionally **not** implemented (web-first); only US1 is exercised on the emulator.
