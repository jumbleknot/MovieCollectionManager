# Data Model: MCM Maintainability Hardening

**Not applicable.**

This feature introduces, changes, and removes **no runtime data entities, fields, relationships, or persisted state**. It is a source-code rename (one module + three importers) plus a governance-document amendment.

The one storage-adjacent value in scope — the browser `sessionStorage` key `mcm_auto_nav_done` used by the renamed module — is an **external/persisted contract** that is already behavior-named and is intentionally **left unchanged** (spec FR-005), so there is no data-model impact.
