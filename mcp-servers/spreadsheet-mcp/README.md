# spreadsheet-mcp

Scoped-capability MCP server for **feature 014 — spreadsheet import/export**. File processing
only: it parses an uploaded CSV/`.xlsx` into structured tabs (`parse_spreadsheet`) and builds a
multi-tab `.xlsx` for download (`build_workbook`). It performs **no backend/domain network
calls** — the only external resource it touches is the transient upload/download store (Redis),
which it reads/writes by an opaque, short-TTL, single-use handle (014 research R3/R11). It never
sees a user JWT and never persists files.

## Tools

| Tool | Purpose |
|---|---|
| `parse_spreadsheet(fileHandle, filename?, sampleSize?)` | Fetch the uploaded bytes from the transient store by handle and return `{ tabs: [{ name, eligible, columns, rowCount, rows }] }`. Pure structural extraction — no column classification or collection matching (the orchestration node does that). |
| `build_workbook(tabs, multiValueDelimiter?)` | Build one `.xlsx` (one sheet per `tabs[]` entry, header row, multi-values joined with `\|`), store it, and return `{ downloadHandle, filename }` for the BFF download route. |

See `specs/014-spreadsheet-import-export/contracts/spreadsheet-mcp-tools.md` for the full contract.

## Environment

| Var | Default | Notes |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Transient store. Namespaces: `import:file:<handle>` (BFF-written upload), `export:file:<handle>` + `export:name:<handle>` (generated download). |
| `SPREADSHEET_MCP_HOST` / `SPREADSHEET_MCP_PORT` | `0.0.0.0` / `8000` | Container bind. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | Env-gated OTel tracing (no-op unless set). |

`enable_dns_rebinding_protection=False` on the transport — the MCP SDK otherwise 421-rejects a
Docker service-name `Host` (durable 012 gotcha). Reachable only on the private agent network.

## Commands (Nx)

```bash
pnpm nx test spreadsheet-mcp                 # unit
pnpm nx test:integration spreadsheet-mcp     # integration (real transient store)
pnpm nx lint spreadsheet-mcp                 # ruff + mypy
pnpm nx build spreadsheet-mcp                # docker build → spreadsheet-mcp:latest
```
