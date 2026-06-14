# Contract: `spreadsheet-mcp` Tools

New scoped-capability MCP server (`mcp-servers/spreadsheet-mcp/`). No backend/network IO; reads only the transient upload store via an opaque handle (plan R3/R11). `enable_dns_rebinding_protection=False` on the transport (012 gotcha). Added to the gateway tool allowlist for the import/export nodes only.

## Tool: `parse_spreadsheet`

Parse an uploaded CSV/`.xlsx` into structured tabs. Does NOT classify columns or match collections — pure structural extraction (the orchestration node does mapping/resolution).

**Input**:
```json
{
  "fileHandle": "string (required) — opaque transient-store handle",
  "sampleSize": "integer (optional, default 20) — non-empty values sampled per column"
}
```

**Output**:
```json
{
  "tabs": [
    {
      "name": "string",
      "eligible": "boolean — has at least Title, Year, Content Type columns",
      "columns": [{ "header": "string", "sampleValues": ["string"] }],
      "rowCount": "integer",
      "rows": [{ "<header>": "string (raw cell)" }]
    }
  ]
}
```

**Errors** (MCP `isError`): unreadable/corrupt file, unsupported format, empty file, handle expired/not-found. No partial result on a corrupt file (FR-022). For very large files, `rows` MAY be returned in pages (cursor) to support the chunked/no-cap requirement (FR-021b) — paging shape decided in tasks.

**Idempotency**: read-only; safe to retry. The handle is single-use and may be invalidated after first successful parse.

## Tool: `build_workbook`

Build a single multi-tab `.xlsx` from per-collection movie data and store it for download.

**Input**:
```json
{
  "tabs": [
    {
      "collectionName": "string — becomes the sheet name",
      "columns": ["string — ordered attribute headers"],
      "rows": [{ "<attribute>": "string — multi-values pre-joined with | by the caller, or raw" }]
    }
  ],
  "multiValueDelimiter": "string (optional, default \"|\")"
}
```

**Output**:
```json
{ "downloadHandle": "string — transient-store handle for the BFF download route", "filename": "string" }
```

**Errors**: empty `tabs`, sheet-name collision (must be de-duplicated by caller/tool), write failure.

**Notes**: One sheet per `tabs[]` entry; first row = headers; a collection with zero movies yields a header-only sheet (edge case). Multi-value join with `|` (FR-027). Excludes collection/user/ownership fields — the caller (export node) selects the attribute set (FR-026).
