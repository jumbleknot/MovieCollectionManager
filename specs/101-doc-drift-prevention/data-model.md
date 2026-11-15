# Data Model: Doc-Drift Prevention

No persisted application data. Two file-level structures and one in-memory result.

## Fork-point header (first line of the override)

```text
<!-- forked-from: <core path> sha256=<hex64> spec-kit=<version> -->
```

| Field | Rule |
|---|---|
| core path | Always `.specify/templates/tasks-template.md`. A different path is a failure. |
| sha256 | 64 lowercase hex characters, the SHA-256 of the core template's bytes. Written only by `--record`. |
| spec-kit | `speckit_version` from `.specify/init-options.json` at record time. Informational, not compared. |

A header that is missing or malformed is a failure in its own right (the guard cannot tell what was forked).

## Override content invariant

At least one task line (`- [ ] …`) contains the literal marker `**Doc-impact sweep**`.

## Guard result (in memory)

`{ ok: boolean, failures: Array<{ code, message }> }`. The codes, one per spec failure condition:

| code | condition |
|---|---|
| `override-missing` | The override file is absent. |
| `header-invalid` | The first line is not a well-formed fork-point header. |
| `sweep-missing` | No task line carries the sweep marker. |
| `core-changed` | The core template's SHA-256 ≠ the recorded sha256. The message names both files and carries the diff or the "history unavailable" note. |
| `resolution-broken` | `setup-tasks.ps1` no longer resolves through `Resolve-Template`, or `Resolve-Template` no longer checks `overrides/` first. |

All conditions are evaluated, and every failure is reported, not just the first.

## State transitions (fork point)

```text
recorded(h) --upgrade changes core--> core-changed --re-merge + --record--> recorded(h')
```
