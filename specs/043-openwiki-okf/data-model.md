# Phase 1 Data Model: OKF Bundle

**Feature**: 043-openwiki-okf · **Date**: 2026-07-26

The "data model" here is the on-disk shape of the bundle and the rules the conformance gate enforces
over it. Field semantics mirror the shipped `dist/okf/frontmatter.js` (research R8); the repository's
additional rules are marked **[repo]**.

---

## File classes

A bundle is a directory tree of markdown files. The gate must classify each file **before** validating
it — applying concept rules to the hand-authored brief is the single easiest way to make this gate
fail on its own repository.

| Path | Class | Front matter | Validated as concept | Must be listed in an `index.md` |
|---|---|---|---|---|
| `openwiki/INSTRUCTIONS.md` | Hand-authored brief | none | **No — exempt entirely** | No |
| `<dir>/index.md` | Directory summary | yes | Yes, **plus** sibling-listing rule | No (it *is* the listing) |
| `<dir>/log.md` | Change history | yes | Yes | No |
| any other `<dir>/*.md` | Concept | yes | Yes | **Yes** |
| non-`.md` files | Ignored | — | No | No |

`log.md` is singular. The vendor blog says `logs.md`; the shipped code does not (research R7).

---

## Entity: Concept

One markdown file describing one subject. **Its path is its identity** — there is no separate ID field.

### Front-matter fields

| Field | Required | Type | Rule |
|---|---|---|---|
| `type` | **Yes** | non-empty string | The only field the format requires. The tool injects `type: "Reference"` into any page lacking one. |
| `title` | No | non-empty string when present | Must not be present-but-blank. |
| `description` | No | non-empty string when present | Used by `index.md` for navigation, so its absence degrades retrieval — but it is **not** an error. |
| `resource` | No | non-empty string when present | Link to the authoritative source. Resolution rules below. |
| `tags` | No | array of non-empty strings | Must be an array; a bare string is invalid. |
| `timestamp` | No | non-empty string when present | **[repo]** must additionally parse as ISO 8601. |

Unknown custom keys are permitted and ignored — the format is deliberately lenient and grows
backward-compatibly. **The gate must not reject unknown keys.**

### Deliberate non-rules

The gate does **not** require `title` or `description`, because the generator itself leaves such pages
unchanged when they already declare a `type`. A stricter gate would fail pages its own generator
considers valid, producing a red build no regeneration could fix.

---

## Validation rules (what the gate enforces)

Each rule maps to exactly one fixture bundle in `scripts/__tests__/fixtures/openwiki-okf/`.

| ID | Rule | Class | Fixture |
|---|---|---|---|
| V1 | Front matter is present and parses as YAML | fail | `unparseable-frontmatter/` |
| V2 | `type` is present and is a non-empty string | fail | `missing-type/` |
| V3 | Optional string fields, when present, are non-empty strings | fail | `blank-optional-field/` |
| V4 | `tags`, when present, is an array of non-empty strings | fail | `tags-not-array/` |
| V5 | **[repo]** `timestamp`, when present, parses as ISO 8601 | fail | `bad-timestamp/` |
| V6 | **[repo]** a repository-relative `resource` resolves to an existing path | fail | `dangling-resource/` |
| V7 | **[repo]** an external `resource` is well-formed; **never fetched** | pass (no network) | `external-resource/` |
| V8 | **[repo]** every directory containing concepts has an `index.md` | fail | `missing-index/` |
| V9 | **[repo]** every concept is listed by its directory's `index.md` | fail | `orphaned-concept/` |
| V10 | **[repo]** the bundle exists and is non-empty — fail-closed, no opt-out | fail | *absent bundle* (no fixture dir; gate run against an empty path) |
| V11 | **[repo]** `INSTRUCTIONS.md` is exempt from all concept rules | pass | `instructions-only/` |
| V12 | **[repo]** drift: a concept whose repo-relative `resource` changed after the concept's `timestamp` | **warn, exit 0** | `stale-concept/` |
| V13 | A fully conformant bundle passes with no findings | pass | `valid/` |

**V12 is the only rule that reports without failing** (FR-014b). Every other listed failure is exit 1.

### Resource resolution (V6 / V7)

Classification is by shape, and resolution is **offline in both branches** (FR-013a):

- Value parses as an absolute URL with a network scheme → **external**. Check well-formedness only.
  Never issue a request. The gate must remain runnable with no network at all.
- Otherwise → **repository-relative**. Resolve against the repository root and fail if the target does
  not exist. Fragments (`#anchor`) and query strings are stripped before the existence check.

### Drift detection (V12)

For a concept with both a `timestamp` and a repository-relative `resource`, compare the source's last
modification against the concept's timestamp. Later source ⇒ emit a drift warning naming both files.
**Never** affects the exit code — a documentation edit must never block a merge on a paid regeneration
run.

---

## Entity: Directory summary (`index.md`)

A concept in its own right (so V1–V7 apply), with one extra obligation: it must reference every
sibling concept in its directory (V9 is evaluated from its content). It is itself exempt from V9.

Nested directories each carry their own `index.md`; the rule is per-directory, not per-bundle.

---

## Entity: Generation instructions (`openwiki/INSTRUCTIONS.md`)

Hand-authored, read by the tool for scope and priorities, and **never rewritten by init, update, or
chat runs**. It has no front matter and is not a concept.

Required content (FR-009 – FR-011), in four groups:

1. **Exclusions** — `node_modules/`, `target/`, `.venv/`, `.nx/`, `.pnpm-store/`, `.mypy_cache/`,
   `.ruff_cache/`, `dist/`, `coverage/`, `test-results/`, all `.env*`, `secrets/`, lockfiles, and
   `docs/proposals/**`.
2. **Redaction** — never reproduce hostnames, host+port pairs, tokens, or credential-shaped values;
   refer to "the forge host" and "the prod domain" abstractly.
3. **Summarize and link** — never restate `docs/`; carry a distilled summary, the gotchas, and a
   `resource` link.
4. **Priority areas** — per-project overviews, cross-cutting invariants, and the non-obvious design
   decisions currently held only in `CLAUDE.md`.

**This file is the remediation surface.** When a gate rejects generated content, the fix is here
followed by regeneration — never an allowlist entry (FR-012).

---

## Coverage obligation (SC-012)

Beyond per-file validity, the bundle must reach **full navigational coverage**: every runbook, ADR,
and architecture document has at least one concept citing it. This is verified during review against
the documentation tree and recorded in the evidence document (FR-029). It is deliberately **not** a
gate rule — a newly added runbook would otherwise redden CI before anyone could regenerate, which is
the same disproportion that made drift detection report-only.
