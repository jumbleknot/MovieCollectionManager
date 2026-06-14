# Implementation Review — Feature 014: Spreadsheet Import & Export

**Date**: 2026-06-14 · **Branch**: `014-spreadsheet-import-export` · **Reviewer**: Claude (Opus 4.8) · **Scope**: the 179-file diff vs `main` (US1 optional language + US2–US4 assistant-driven import/export + the new `spreadsheet-mcp` server).

This review was conducted after the feature was functionally complete (all 62 tasks `[X]`, PR #15 open). It is organized in four parts: (1) code & security review with fixes applied, (2) learnings + artifact improvements, (3) spec alignment, (4) this summary.

---

## Part 1 — Code & Security Review

### Method

Four parallel best-practice reviews, one per tech stack (Rust mc-service, TS/RN mcm-app, Python movie-assistant, Python spreadsheet-mcp), each using the appropriate skill/guidance, reporting findings only. Then a `/security-review` pass (identification sub-agent + the skill's false-positive discipline). Fixes were then applied centrally and the affected suites re-run.

### Findings & fixes applied

| # | Sev | Area | Finding | Fix |
|---|-----|------|---------|-----|
| 1 | **HIGH** | `spreadsheet-mcp/src/store.py` | A fresh `redis.from_url` client (+ connection pool) was constructed on **every** tool call and never closed → pool/socket leak over the long-lived server. | Cache a process-shared, lazily-created client (movie-mcp's single-client pattern). |
| 2 | MED | `spreadsheet-mcp/src/builder.py` ↔ `parser.py` | CSV/formula injection: an exported cell beginning with `= + - @ \t \r` executes as a live formula when the workbook is opened; data is user-supplied. | **Symmetric guard**: `_cell` escapes a leading trigger with an apostrophe on export; `_cell_to_str` strips exactly that guard on import — so the SC-004 round-trip stays faithful and a legit leading apostrophe (`'71`) survives. Added unit + build→parse round-trip tests. |
| 3 | MED | `import-upload+api.ts` | The 50 MB store guard runs only **after** `arrayBuffer()` has buffered the whole body into BFF memory. | Reject by `Content-Length` (cap 52 MB, multipart overhead) **before** reading the body. |
| 4 | MED | mc-service `create_movie.rs` / `update_movie.rs` | Handlers accepted `Some("")` for `language` and persisted `""`, violating the domain's stated invariant ("unknown language is absence, not an empty string"); the filter-options facet papered over it with an `!is_empty()` filter. | Normalize empty/whitespace `language` → `None` at the command boundary; updated the unit test to assert the normalized `None`. The facet filter is now defense-in-depth. |
| 5 | LOW | `export-download+api.ts` | `Content-Disposition` filename interpolated unescaped (currently a constant, but trusts an upstream invariant). | Strip `CR/LF/"/\` from the filename. |
| 6 | LOW | `runtime_nodes.py` (export tab build) | `c["collectionId"]` would `KeyError` on a malformed collection record in the "export all" branch. | Defensive `c.get("collectionId")`, skip empties. |

### Pre-existing breakage caught by the review (not introduced by the fixes)

- **`spreadsheet-mcp` unit suite was RED on the branch.** Commit `6d200ee` ("updated sample data") changed `docs/test-data/sample-movies.xlsx` from 200→204 rows but left `test_sample_tab_row_count_and_columns` asserting 200. Fixed the assertion (204; headers still 27, first row unchanged).
- **`movie-assistant` lint was failing.** Two `E501` line-too-long errors in `tests/integration/test_import_flow.py` (introduced by a recent commit, lint not re-run). Reflowed both.

### Unused files

Scanned every new module: all are referenced (spreadsheet-mcp `parser/builder/store/observability` ← `server.py`; agent `import_collection/import_disambiguation/import_resolvers/export_collection` ← graph/runtime/supervisor; frontend `import-preview/render-import-report/request-import-file/ui-action-tools/pick-file/use-spreadsheet-import` ← dock). The only empty files are required `__init__.py` package markers. **No unused files or directories — nothing removed.**

### Security review result

**No HIGH or MEDIUM vulnerabilities** (no finding reached the confidence-≥8 bar). Verified safe: cross-user import write (tab→collection match only against the requester's own `list_collections()` via the downscoped subject token; mc-service re-enforces DAC), cross-user export read (`select_export_collections` filters to owned ids), handle ownership (128-bit `randomBytes` import handle never sent to the client; single-use `uuid4` export capability), openpyxl (`read_only`, no external-entity resolution; no pickle/yaml/eval), the `X-Import-File`/identity bridge (server-set, `user_id` always from the token), and imported `externalIds[].url` (additionally gated by mc-service `validate_external_ids`, which rejects `javascript:`). The formula-injection vector (finding #2) is the one concrete hardening that was applied.

### Verification (post-fix)

`spreadsheet-mcp` unit ✓ · `mc-service` unit ✓ (incl. new normalization test) · `movie-assistant` 812 passed / 2 skipped ✓ · `mcm-app` 1032 passed ✓ · `tsc --noEmit` clean ✓ · lint clean on all four projects (`mc-service` clippy, `mcm-app` eslint, `movie-assistant` + `spreadsheet-mcp` ruff+mypy) ✓.

---

## Part 2 — Learnings & Artifact Improvements

### What went wrong, and the root cause

1. **Resource lifecycle in a stateless MCP (finding #1).** The "stateless, token-free" framing of `spreadsheet-mcp` made a per-call client feel natural, but the *server process* is long-lived. The same class of bug (resolve/connect once, reuse) was already documented for Vault in the 012 review — it recurred because the rule lived in a feature-specific note, not the MCP guidance.
2. **Export-document safety was unspecified (finding #2).** The spec covered *input* robustness (FR-022: reject corrupt/empty/unsupported) but said nothing about *output* safety. Formula/CSV injection is a well-known spreadsheet-export hazard that no artifact flagged, so it wasn't implemented.
3. **The "absence vs empty string" contract wasn't enforced (finding #4).** US1's spec/contract said "optional," and the domain entity comment said "absence, not empty string," but neither the contract nor a task said *normalize at the boundary* — so the handlers accepted `""` and a downstream filter compensated.
4. **Fixture edits bypassed validation (pre-existing RED).** Two quick commits ("good progress", "updated sample data") edited a shared fixture and a test file without re-running the consuming projects' unit + lint. The Final Validation Checklist exists but is framed as an end-of-feature gate, so mid-feature data edits slipped through.
5. **UI design drifted from plan without artifact updates (Part 3 finding I1).** The Session-7 UX rework (type-to-start) replaced the planned dialog components, but plan.md/tasks.md kept the old filenames.

### Improvements applied to artifacts

- **`CLAUDE.md`** (feature-014 note): added five durable implementation-review lessons — MCP servers reuse one backend/Redis client; export cells carry a symmetric formula guard; `language` normalized to `None` at the command boundary; BFF uploads reject by `Content-Length` before buffering; **editing `sample-movies.xlsx` must re-run the consuming projects' unit + lint** (fixture-derived counts).
- **`spec.md`** (Edge Cases): added the blank-language→absence rule and the export formula-injection guard (with the round-trip-preserving symmetry).
- **`contracts/mc-service-language-delta.md`**: added the canonical-absence normalization rule (empty/whitespace → `None` at the create/update boundary).
- **`plan.md` / `tasks.md`**: realigned the frontend component list + T037/T047 to the shipped type-to-start UX (see Part 3).

### Constitution amendment (human-approved, applied as v2.1.0)

Per SDD, this was proposed and then **approved by the maintainer and applied**. A new **File-Processing Safety** control was added under `### Agent Security (NON-NEGOTIABLE)`: file-processing MCP servers must (a) treat all parsed input as untrusted — reject malformed/empty/oversized/unsupported input with no partial result, parse in a streaming/read-only mode that resolves no external entities; and (b) neutralize injection in any document they emit (spreadsheet formula/CSV-injection escaping on export, reversed symmetrically on re-import). Version bumped 2.0.0 → **2.1.0** (MINOR — guidance addition, no principle redefined). The shipped code already satisfies it after the Part 1 fixes, so no migration is required.

---

## Part 3 — Spec Alignment (`/speckit-analyze`)

Cross-artifact analysis of spec.md / plan.md / tasks.md against the constitution. **Coverage 100%** — all 31 FRs and 9 SCs map to ≥1 completed task; no unmapped tasks; no constitution violations (the plan's all-PASS Constitution Check holds, and the Part 1 fixes strengthen the Scoped-Capability/secure-proxy posture).

Findings and resolutions:

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| I1 | HIGH | plan.md/tasks.md named superseded frontend files (`spreadsheet-import-dialog.tsx`, `spreadsheet-export-dialog.tsx`, `use-spreadsheet-export.ts`) never shipped; the Session-7 rework shipped `request-import-file.tsx` + `import-preview.tsx` + `render-import-report.tsx` + `ui-action-tools.tsx` + `pick-file.ts` instead. | Updated plan.md component list and tasks.md T037/T047 to the shipped files, with an explicit "deviates from original plan" note. |
| I2 | LOW | plan.md referenced a `state.py` that was never created (state lives in `runtime_context.py`/node modules). | Corrected the plan's agent-layer file list. |
| C1 | MEDIUM | spec.md `Status: Draft` despite completion. | Bumped to `Implemented (PR #15…)`. |

No CRITICAL issues; the feature is consistent across artifacts after these edits.

---

## Part 4 — Summary

Feature 014 shipped in good shape: the security model (downscoped identity, single-use handles, DAC re-enforcement, token-free file MCP) held up under a focused security review with **no exploitable vulnerabilities**, and the architecture honored every Constitution Check gate. The review nonetheless surfaced **one HIGH resource-leak**, **three MEDIUM hardening/correctness gaps** (formula injection, pre-buffer upload cap, language normalization), **two LOW defense-in-depth items**, and — importantly — **two pre-existing test/lint failures left RED on the branch** by quick fixture/edit commits that skipped re-validation. All ten items are fixed; all suites and linters are green.

The most leverage-positive takeaways are process-level: (1) the resource-reuse and document-safety lessons are now in CLAUDE.md and proposed for the constitution so they don't recur per-feature; (2) the "re-run consuming unit + lint after any fixture edit" rule is documented to prevent the silent RED that this review caught; and (3) the spec/plan/tasks now match the shipped type-to-start UX.

**Net change in this review**: 9 source/test files edited (1 Rust pair, 2 TS routes, 1 Python node, 3 spreadsheet-mcp modules + 2 of its test files), 4 spec/doc artifacts realigned, CLAUDE.md lessons appended. No behavior regressions; coverage and gates intact.
