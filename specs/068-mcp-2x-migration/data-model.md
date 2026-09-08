# Phase 1 Data Model: MCP SDK 2.x migration on an audited baseline

No database, no schema migration, no persisted state. The "entities" here are the in-flight records
this feature creates, reshapes or must preserve. Two are scanner records (Phase 1) and three are
runtime records (Phase 2).

---

## Python project surface *(Phase 1 — new)*

The unit the security scan iterates over. Today it is implicit and singular; this feature makes it a
first-class list of four.

| field | type | notes |
|---|---|---|
| `project` | string | repository-relative directory; the value that prefixes a finding's `location` |
| `dir` | absolute path | resolved from repo root; where `uv` commands run |
| `agentSet` | set of normalized names | full dependency graph, from `uv export` |
| `runtimeSet` | set of normalized names | `--no-dev` subset; drives runtime-vs-dev scope |

**Members**: `agents/movie-assistant`, `mcp-servers/movie-mcp`, `mcp-servers/spreadsheet-mcp`,
`mcp-servers/web-api-mcp`.

**Rules**

- `agentSet` and `runtimeSet` are derived **per surface**. Borrowing the gateway's sets would
  misclassify a server's dev-only package as runtime, or worse, filter out a package the gateway
  does not have (FR-002).
- A surface whose environment is not synced, or whose advisory lookup fails, **fails the scan**. It
  is never skipped, and three-of-four is never reported as success (FR-008).
- `runtimeSet` may be `null` only if derivation itself fails, in which case the existing conservative
  behaviour applies — everything classifies as runtime.

---

## Advisory finding *(Phase 1 — one field reshaped)*

An entry in `findings.json`, the gate's input contract. Only `location` changes, and only for the
`pip-audit` scanner.

| field | before | after |
|---|---|---|
| `location` | `click@8.5.0` | `mcp-servers/web-api-mcp:click@8.5.0` |

Every other field — `scanner`, `kind`, `id`, `title`, `ecosystem`, `nativeSeverity`, `severity`,
`scope`, `blocking`, `fixAvailable` — is unchanged, as is the format for the other three scanners.
Full rules and invariants: [contracts/pip-audit-finding.md](./contracts/pip-audit-finding.md).

**State transitions**: a finding is *blocking* or *warning* (derived from kind, severity and scope),
and independently *suppressed* or *not* (derived from the allowlist). Suppression is gate-only — a
suppressed finding stays visible in the report. This feature changes neither derivation, only what
a suppression can address.

---

## Suppression entry *(Phase 1 — one retired)*

An accepted-or-not-exploitable determination in `security/sast/allowlist.yaml`. Schema unchanged
(`scanner`, `id`, `locationPattern`, `justification`, `addedBy`, optional `expiry`).

**Rules**

- A `pip-audit` entry's `locationPattern` is matched against the project-qualified location, so an
  entry can now name one surface (FR-004).
- An entry matching **zero** findings in a completed scan is a defect and fails a guard test naming
  it (FR-005). This is the one genuinely new rule, and it exists because this repository has already
  shipped an entry that quietly matched nothing.
- The single existing `pip-audit` entry is **deleted** (FR-006): `click` is 8.5.0 in all four locks
  and clean, so it suppresses nothing and its premise is stale.

---

## MCP tool result *(Phase 2 — preserved)*

The record a tool call returns to the assistant: error flag, structured payload, text content. Field
names change from camelCase to snake_case; **semantics do not**. Mappings pass through as-is,
sequences are wrapped under `result`, and a tool's declared return annotation is load-bearing — a
bare `dict` silently yields no structured payload on 2.x.

Full table, the 14 call sites, and the annotation rule:
[contracts/mcp-tool-result.md](./contracts/mcp-tool-result.md) §1–2.

---

## Per-call credential *(Phase 2 — preserved, custody rewritten)*

Two independent values read from ContextVars immediately before an outbound MCP call: the downscoped
backend token (`Authorization: Bearer`) and the per-run external API key (`X-TMDB-Key`). Each is
omitted when its ContextVar is unset.

**Lifecycle — the part that actually changes.** On 1.x the transport owned the HTTP client, so the
credential-bearing auth object lived and died with the call. On 2.x the caller supplies the client,
so the caller owns its lifetime: it must be released on both the success and the failure path, and
the credential must be injected per-request by the auth hook rather than baked into a client's
default headers.

**Rules**: independence (INV-6), never persisted to checkpointed state, traces or logs (INV-7,
constitutional), released on both paths (INV-8), injected per-request (INV-9). See
[contracts/mcp-tool-result.md](./contracts/mcp-tool-result.md) §3.
