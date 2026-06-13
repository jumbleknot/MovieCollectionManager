# Phase 1 Data Model: Spreadsheet Import & Export

Covers the persisted-schema change (US1) and the transient, non-persisted structures that flow through the import/export orchestration. Only US1 touches stored data; all import/export structures are ephemeral run state (never written to `agent-db` if they carry file bytes — see plan R3).

## 1. Movie (persisted) — US1 change

Existing `Movie` entity in mc-service (`mc_db.movies`), unchanged except:

| Field | Before | After | Notes |
|---|---|---|---|
| `language` | `String` (required, non-empty) | `Option<String>` (optional) | Domain entity, Create/Update/Response DTOs, DAO. `#[serde(default)]` on the DAO so existing/absent docs deserialize. Frontend `language?: string`. |

**Validation rules after change**:
- `title` remains required & non-empty (`RequiredStringSpec`).
- `year`, `contentType` remain required.
- `language` MUST be accepted as absent/empty; when absent, stored as MongoDB missing/`null`, displayed as a neutral placeholder, and grouped consistently in sort/filter.
- All other movie attributes unchanged.

**Multi-value attributes** (relevant to import/export): `genres`, `directors`, `actors`, `tags`, `ownedMedia`, `ripQuality`, `externalIds` are lists. Boolean flags: `owned`, `ripped`, `childrens`.

No migration required (existing docs all carry `language`).

## 2. ImportFile (transient)

Represents the user-selected upload while in flight.

| Field | Type | Notes |
|---|---|---|
| `handle` | string (opaque, unguessable) | Key into the transient store (plan R3). Single-use, short TTL. |
| `filename` | string | Original name (display only; not trusted for logic). |
| `kind` | enum `csv` \| `xlsx` | Inferred from content/extension; drives single-sheet vs multi-tab handling. |
| `sizeBytes` | number | Size guard. |

Never checkpointed; bytes live only in the transient store.

## 3. ParsedWorkbook → Tab → Column → Row (transient)

Output of `spreadsheet-mcp.parse_spreadsheet`.

**ParsedWorkbook**: `{ tabs: Tab[] }`

**Tab**:
| Field | Type | Notes |
|---|---|---|
| `name` | string | Sheet name (CSV → derived from filename / single implicit tab). |
| `columns` | Column[] | Header + sampled values. |
| `rows` | object[] | Row cells keyed by column header (raw strings). |
| `eligible` | boolean | True iff it contains at least Title, Year, Content Type (FR-008). Ineligible tabs are ignored. |

**Column**:
| Field | Type | Notes |
|---|---|---|
| `header` | string | Raw header text. |
| `sampleValues` | string[] | First N non-empty cells (for value-shape heuristics). |

## 4. ColumnMapping (transient)

The resolved correspondence per tab (plan R4).

| Field | Type | Notes |
|---|---|---|
| `header` | string | Source column. |
| `attribute` | string \| null | Target movie attribute, or null if ignored. |
| `confidence` | enum `high` \| `medium` \| `low` | high→auto, medium→ask (FR-012), low→ignore (FR-013). |
| `multiValue` | boolean | If true, split cell on `|` into separate values (FR-016). |
| `resolvedBy` | enum `code` \| `user` \| `model` | Provenance; user picks resolved in pure code. |

Canonical alias seeds (from the sample fixture; extend in tasks): `Title→title`, `Year→year`, `Video Type→contentType`, `Children's→childrens`, `Owned→owned`, `Media→ownedMedia`, `Ripped→ripped`, `Rip Quality→ripQuality`, `MPAA→rated`, `Language→language`, `Directors→directors`, `Actors→actors`, `Genres→genres`, `Tags→tags`, `IMDB Id`/`IMDB URL`/`TMDB Id→externalIds`. Ambiguous: `Plot`/`Outline`→`overview` (medium → ask). No target: `Set`, `Pick`, `Top` (low → ignore).

## 5. TitleNormalization (transient)

| Field | Type | Notes |
|---|---|---|
| `original` | string | As read (may be `"Matrix, The"`). |
| `normalized` | string | Leading-article form (`"The Matrix"`). |
| `article` | enum `The`\|`A`\|`An`\|null | Detected article. |
| `needsConfirm` | boolean | True when a trailing comma-word is not one of the three articles (FR-015). |

## 6. ImportPreview → ImportPlanItem (transient)

Shown before any write (FR-020); the HITL gate consumes it.

**ImportPreview**: `{ tabs: TabPlan[] }`

**TabPlan**:
| Field | Type | Notes |
|---|---|---|
| `tabName` | string | Source tab. |
| `targetCollectionId` | string | Resolved (exact match) or user-chosen (FR-009/FR-010). |
| `toCreate` | ImportPlanItem[] | New movies. |
| `toUpdate` | ImportPlanItem[] | Existing movies (compose-then-replace, FR-019). |
| `skipped` | { row, reason }[] | Missing required field / unmapped / duplicate-in-import. |
| `excluded` | boolean | User excluded this whole tab at the gate (FR-020a). |

**ImportPlanItem**:
| Field | Type | Notes |
|---|---|---|
| `title` | string | Normalized title. |
| `movieId` | string \| null | Non-null ⇒ update; null ⇒ create. |
| `payload` | object | Full movie payload (composed for updates; built for creates). |
| `idempotencyKey` | string | Per-write key (Agent Security). |

## 7. ImportResultSummary (transient)

Final report (FR-021).

| Field | Type |
|---|---|
| `created` | number |
| `updated` | number |
| `skipped` | { count, reasons } |
| `failed` | { count, reasons } |
| `perTab` | per-tab breakdown |

## 8. ExportRequest → ExportDocument (transient)

| Entity | Fields | Notes |
|---|---|---|
| `ExportRequest` | `collectionIds: string[]` | From the AG-UI multi-select (FR-024). |
| `ExportTabData` | `collectionName`, `movies: object[]` | One per selected collection; movies read via `list_movies` all pages. |
| `ExportDocument` | `handle`, `filename` | `.xlsx` built by `build_workbook`; streamed by the BFF download route (FR-028). One tab per collection, one column per attribute (excl. collection/user/ownership), multi-values `|`-joined (FR-026/FR-027). |

## Relationships

```text
ImportFile --parse--> ParsedWorkbook --(per Tab)--> ColumnMapping[] + TitleNormalization[]
        --resolve--> ImportPreview(TabPlan[]) --HITL confirm--> writes (movie-mcp) --> ImportResultSummary
ExportRequest --(per collection)--> ExportTabData[] --build_workbook--> ExportDocument --download--> user
Movie(persisted): language now Option<String>
```
