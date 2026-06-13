# Phase 0 Research: Spreadsheet Import & Export

All Technical-Context unknowns resolved below. Each: **Decision / Rationale / Alternatives considered**.

## R1 — Optional `language`: empty-string vs true-optional

**Decision**: Make `language` truly optional — `Option<String>` in the mc-service domain entity, Create/Update/Response DTOs (with `#[serde(default)]`), and the MongoDB DAO; drop the `RequiredStringSpec` check on `language` in `create_movie`/`update_movie`; frontend `language?: string` and remove the form's required validation. No data backfill (existing docs all have a value; the DAO serde-default tolerates absence going forward).

**Rationale**: "Unknown language" ≠ empty string; a nullable field is the correct model and is what the agent/MCP path already anticipates (`proposals.py` defaults to `"English"` only as a fallback). Backward-compatible: the API still accepts `language` when present, so existing clients are unaffected. Confirmed by the impact analysis in `docs/PRD-ImportExportSpreadsheet.md`.

**Alternatives considered**: (A) Allow empty string only (drop validation, keep `String`) — smaller (4 files) but stores `""` sentinels and pollutes filter/sort. Rejected as a worse model. (C) Keep required, default missing imports to `"English"` — rejected: fabricates data the user didn't provide.

## R2 — Spreadsheet parsing/building library

**Decision**: `spreadsheet-mcp` uses **`openpyxl`** for `.xlsx` read+write and the **stdlib `csv`** module for CSV read. No pandas.

**Rationale**: openpyxl is the de-facto pure-Python `.xlsx` library (multi-sheet read, sheet-named write, streaming read via `read_only=True` for large files — supports the no-cap/chunked requirement). pandas would pull a heavy numpy stack into the MCP image for no benefit (we need cell/row access, not dataframes). CSV is single-sheet, stdlib-sufficient.

**Alternatives considered**: pandas/`openpyxl`-via-pandas (rejected: image weight, dtype coercion surprises on years/flags); `xlsxwriter` for write-only (rejected: openpyxl already covers read+write, one dependency).

## R3 — Transient upload transport (file → parse tool)

**Decision**: The BFF accepts the upload on a new route, writes the raw bytes to a **short-TTL transient store keyed by an opaque handle**, and passes only that handle as a run input. `spreadsheet-mcp.parse_spreadsheet(file_handle)` fetches the bytes from the same store. Default store: a dedicated Redis key namespace (`import:file:<handle>`) with a short TTL (e.g. 15 min) and a size guard; the handle is single-use and deleted after parse. The MCP server reads via a minimal, scoped fetch (the handle is unguessable and TTL-bound). **No file bytes ever enter checkpointed agent state, traces, or logs.**

**Rationale**: Satisfies "no file bytes in checkpoint/logs" (Identity Propagation principle) and the no-fixed-cap requirement (bytes live in the store, not the LLM context). Redis is already in the stack. The node calls `parse_spreadsheet` in pure code with the handle (not an LLM-chosen arg), so the file never rides a model tool-call.

**Alternatives considered**: base64 bytes as a run/tool argument (rejected — checkpointed-state + trace bloat, cap risk); shared Docker volume (rejected — couples MCP container to BFF filesystem, harder in the existing compose topology); object store (overkill for a transient personal-scale file). **Open sub-question for implementation**: whether to reuse the BFF session Redis (db 0) with a strict prefix or a separate logical store — decide in tasks; both satisfy the principle.

## R4 — Column mapping by confidence (high/medium/low)

**Decision**: A two-stage mapping. (1) **Pure-code deterministic matcher** maps headers via a synonym/alias table to movie attributes (e.g. `Video Type|Type|Format→contentType`, `Children's|Kids→childrens`, `Media→ownedMedia`, `MPAA|Rated→rated`, `Directors/Actors/Genres/Tags→multi-value`, `IMDB Id/URL/TMDB Id→externalIds`), corroborated by value-shape heuristics (Yes/No → boolean flag; pipe-delimited → multi-value; 4-digit → year). Exact/strong alias + matching value-shape ⇒ **high** (auto). (2) For headers the code can't confidently place, the **LLM proposes** a candidate mapping with a confidence; the node treats model-medium as **ask-the-user** and unmatched/contradicted as **low → ignore**. Resolution of the user's button choice is **pure code** (no golden re-record for the mapping pick itself).

**Rationale**: Mirrors the 013 discipline — model proposes, code resolves — keeping golden cassettes stable and behavior testable. The sample headers `Pick`, `Top`, `Tagline` (no model attribute) validate the low→ignore path; a generic `Rating`/`Score` header (MPAA `rated` vs a personal rating) validates medium→ask. `Set→movieSet`, `Outline→outline`, `Plot→plot`, `Original Title→originalTitle`, `Release Date→releaseDate`, `Runtime→runtime` are direct high-confidence matches against the real `MovieDto` (verified — there is no `overview` field).

**Alternatives considered**: pure-LLM mapping (rejected — non-deterministic, fragile golden tests, slower); pure-code only (rejected — can't handle novel/renamed headers, which is the whole point of "medium confidence → ask").

## R5 — Trailing sorting-article normalization

**Decision**: Deterministic, pure-code transform recognizing only the English articles **`The`, `A`, `An`** as a trailing `", The"` / `", A"` / `", An"` (case-insensitive match, original case preserved on the moved article). Anything else (e.g. a trailing word after a comma that isn't one of the three, or an ambiguous case like `"Goodbye, Lenin!"`) is **not** auto-transformed and is surfaced to the user via an AG-UI confirm (FR-015). Same normalizer is reused by the existing 013 article-insensitive `titleSort` work where applicable.

**Rationale**: Per clarification Q4. Deterministic and unit-testable; the uncertainty prompt catches the long tail without a multilingual list.

**Alternatives considered**: multilingual article list / configurable list (rejected per Q4 — false-positive risk, larger test matrix).

## R6 — Dedup & update-without-blanking

**Decision**: "Already exists" = case-insensitive **title match within the target collection** (consistent with mc-service's existing per-collection title uniqueness; year as a tie-breaker only if a future stricter key is needed). For an existing movie, build the update with the **`compose_movie_payload` full-replace pattern from 013 US2**: start from the current movie (a `list_movies`/get read), overlay only the attributes the import actually supplies, and PUT — so unspecified attributes are preserved, never blanked (FR-019). New movies → `create_movie`.

**Rationale**: Reuses a proven 013 pattern and the mc-service request DTOs (which have no `deny_unknown_fields`, so round-trips are clean). Title-based identity is forced by the existing uniqueness rule — no new ambiguity.

**Alternatives considered**: external-id (IMDB/TMDB) identity (rejected for MVP — not all rows have IDs; revisit later); PATCH semantics (rejected — mc-service movie update is full-replace PUT; compose-then-replace is the established approach).

## R7 — Preview + HITL approval (best-effort, chunked, tab-exclusion)

**Decision**: After resolution, the node emits a **generative-UI preview** (per-tab: target collection, N to create, M to update, skipped rows + reasons) and routes through the existing **approval-gate** (preview-then-confirm, FR-020). The gate allows **excluding whole tabs** (FR-020a) — excluded tabs are dropped and reported skipped. On confirm, writes run **chunked sequentially (≤50/batch)** with visible progress (FR-021b), **best-effort per movie** (a failed row is logged + counted, never aborts the run — FR-021a), each carrying an **idempotency key**. Ends with a single result summary (created/updated/skipped/failed).

**Rationale**: Reuses the 012/013 batch-approval + pending-batches self-loop and the dock data-revision refresh (so on-screen lists update post-import, FR-031). Satisfies HITL-for-writes and idempotency principles.

**Alternatives considered**: all-or-nothing transactional import (rejected per Q1); per-movie preview exclusion (rejected per Q3 — tab-level only).

## R8 — Export build + download

**Decision**: `export_collection` node reads each selected collection's movies via `movie-mcp.list_movies` (cursor-paginated, all pages), passes the structured per-collection data to `spreadsheet-mcp.build_workbook`, which writes one `.xlsx` with **one tab per collection** (tab = collection name), **one column per exported attribute** (excluding collection/user/ownership fields), multi-values joined with `|`. The tool returns a transient download handle; a new BFF route streams the file so the web client triggers a browser download. CSV export is out of scope (Q5).

**Rationale**: Symmetric with import transport (R3); multi-tab requires `.xlsx` (CSV can't). Collection multi-select is an AG-UI button group.

**Alternatives considered**: client-side workbook generation (rejected — domain data shaping belongs server/tool-side, and the universal client shouldn't bundle an xlsx writer); one file per collection (rejected — spec requires a single file).

## R9 — Supervisor intents & golden cassettes

**Decision**: Add two intents — **`import`** ("import this spreadsheet / load my movies from a file") and **`export`** ("export my collections to a spreadsheet / download…") — to `classify_intent` with label definitions + a few-shot example each, disambiguated from `search`/`query`/`organize`. Because this changes the supervisor prompt, **delete the stale intent cassettes and re-record**, and verify the classifier on **both** the runtime model (qwen2.5) and the Claude gate (per the recurring 012/013 lesson). Mapping/article/preview resolution stay pure-code (no golden surface).

**Rationale**: Established 013 lesson — supervisor-prompt changes force a golden re-record, and routing regressions only surface in the full agent E2E (integration stubs the plan/extract). Run the full agent E2E after the prompt change.

**Alternatives considered**: overloading an existing intent (rejected — import/export are distinct user goals needing distinct nodes/tools).

## R10 — Platform scope & test strategy

**Decision**: Web is the MVP for import/export — Playwright web E2E + the agent E2E harness (`scripts/agent-e2e.mjs` against the containerized production-node gateway). **Mobile import/export = N/A for this feature**, documented in the Platform Parity Table with the web-first justification (file browse/download is web-centric; constitution parity exception recorded). **Optional language (US1) is covered on BOTH** web (Playwright) and mobile (Maestro) since it's a form/display change.

**Rationale**: Per clarification (web-first). Agent mobile E2E is also the OOM-prone path (013 lesson) — another reason to keep import/export web-only for MVP.

**Alternatives considered**: full parity now (rejected per scope decision — large native file-picker/SAF + download work).

## R11 — `spreadsheet-mcp` security posture

**Decision**: New scoped-capability MCP server, isolated container, **no internal network access, no backend calls**. It sets `enable_dns_rebinding_protection=False` in its transport security (the durable 012 gotcha — the MCP SDK 421-rejects a Docker service-name `Host`). It reads only the transient upload store via the unguessable handle and never persists files. Added to the gateway's per-agent tool allowlist for the import/export nodes only.

**Rationale**: Matches the existing `movie-mcp`/`web-api-mcp` container pattern and the documented DNS-rebinding fix; least-privilege allowlist per Agent Security.

**Alternatives considered**: extending `movie-mcp` with parse/build tools (rejected — `movie-mcp` is a thin wrapper over mc-service REST; mixing a file-processing capability violates its single responsibility and its allowlist scope).
