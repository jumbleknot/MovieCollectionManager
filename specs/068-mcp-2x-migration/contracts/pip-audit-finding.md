# Contract: project-qualified `pip-audit` finding location

**Governs**: FR-003, FR-004, FR-005, FR-006
**Amends**: [specs/033-sast-semgrep/contracts/findings.schema.json](../../033-sast-semgrep/contracts/findings.schema.json)
and [allowlist.schema.json](../../033-sast-semgrep/contracts/allowlist.schema.json) — the shape of
`Finding.location` for one scanner only.

## What changes

Feature 033 defines `Finding.location` as *"SAST: `path:line`. SCA: `package@version`"*. That was
unambiguous while exactly one Python project was scanned. With four, `click@8.5.0` no longer says
*which* project, and a suppression written against it silently covers all four.

`pip-audit` findings gain a project prefix. **No other scanner's location format changes** —
`cargo-audit` and `pnpm-audit` each scan one workspace-wide lockfile and have no such ambiguity.

## The format

```
<project-path>:<package-name>@<version>
```

- `<project-path>` is the project's repository-relative directory, exactly as it appears in the
  scanner's surface list — `agents/movie-assistant`, `mcp-servers/movie-mcp`,
  `mcp-servers/spreadsheet-mcp`, `mcp-servers/web-api-mcp`.
- `<package-name>` and `<version>` are unchanged from today: the values `pip-audit` reports, with the
  package name **not** normalized (today's code interpolates `dep.name`, and normalization is applied
  only to set membership).

Examples:

```
agents/movie-assistant:cryptography@50.0.0
mcp-servers/web-api-mcp:click@8.5.0
```

The separator is `:`, matching the SAST `path:line` convention already in the schema. A package name
cannot contain `:`, and a project path here never does, so the format parses unambiguously from the
right.

## Consequences for a suppression entry

`locationPattern` is a regex matched against the whole `location` string. Under this contract:

| pattern | matches | verdict |
|---|---|---|
| `^mcp-servers/web-api-mcp:click@.*` | that project only | **correct form** |
| `click@.*` | *unanchored* — still matches all four projects | accepted, but see the guard |
| `^click@.*` | nothing at all | **caught by FR-005's static check** — names no known surface |

The static check required by FR-005 is what makes the third row loud: the pattern names no surface
in the list, so the gate fails naming it — without needing the scan to produce a finding first. The
historical failure mode recorded in [allowlist.yaml](../../../security/sast/allowlist.yaml) — an
entry that "does not expire, it just quietly matches nothing" — is caught at the shape level here and
at the runtime level by feature 057's weekly check.

Anchoring is not *enforced* by schema, because a deliberately cross-project suppression is
occasionally legitimate (one advisory, same package, accepted identically everywhere). It must be
written as a deliberate unanchored pattern and justified as such.

## Invariants

- **INV-1**: Every `pip-audit` finding's `location` matches
  `^(agents|mcp-servers)/[a-z0-9-]+:[^:]+@[^:]+$`.
- **INV-2**: Two findings for the same advisory and package in different projects have **different**
  `location` values, and are therefore separately suppressible.
- **INV-3**: A suppression entry with `scanner: pip-audit` whose `locationPattern` names no surface
  in the surface list fails the gate, naming the entry. Checked **statically** against the entry's
  own text, not against a run's findings — so it holds when the scan reports zero, which is the
  normal state. (Runtime "matched nothing this run" detection is `selectUnmatched` in
  `scripts/allowlist-expiry.mjs`, from feature 057: report-only, separate schedule, and suppressed
  when the scanner produced no findings. The two are complementary, not alternatives.)
- **INV-4**: The `location` format of `semgrep`, `cargo-audit` and `pnpm-audit` findings is
  unchanged.

## Migration of existing entries

Exactly one `pip-audit` entry exists ([allowlist.yaml:86](../../../security/sast/allowlist.yaml#L86),
`PYSEC-2026-2132` / `click@.*`). It is **retired**, not rewritten: `click` resolves to 8.5.0 in all
four locks and PyPI reports that version clean, so the entry suppresses nothing and its stated
premise ("pinned at 8.2.0 by a transitive cap") no longer holds. Retiring it means a genuine
regression re-blocks instead of being absorbed by a dead entry until its 2026-10-12 expiry.

Had it still been live, the correct migration would be `^agents/movie-assistant:click@.*` — the one
surface it was ever triaged against.
