# Implementation Plan: Session-Maintained Wiki Summaries

**Branch**: `098-session-maintained-wiki` | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/098-session-maintained-wiki/spec.md`. Source proposal:
[docs/proposals/PRD-SessionMaintainedWiki.md](../../docs/proposals/PRD-SessionMaintainedWiki.md).

## Summary

Routine freshness of the `openwiki/` summaries moves from a paid CI generator to the coding session
that changes a summary's source:

- **Fingerprint:** each derived page records `resource-sha256`, the hash of its single source
  file.
- **Check:** the required `okf` check gains rule **V17**, which fails any page whose fingerprint no
  longer matches its source.
- **Refresh tool:** `scripts/wiki-refresh.mjs` lists stale pages, shows each source's diff since
  the last refresh, and records the new fingerprint. A `wiki-refresh` skill teaches the procedure.
- **Retired:** openwiki's bookkeeping (Claims sidecars, page manifest, run marker, `sources:`,
  `verified:`) and the checks that existed for it (V12, V16, G13). The files are gitignored.
- **Generator:** it stays as a manual rebuild of operator-named pages (`--pages`). The unattended
  machinery around it is deleted: range planning, run record, backlog, escalation, cooldowns, drift
  and the quiet-trigger.
- **Record:** ADR-0004 documents the progression and supersedes the Claims half of ADR-0003.
- **Cut-over:** refresh **11** pages (research R8), record the rest, and turn V17 on in the same PR.

## Technical Context

**Language/Version**: Node.js 24 (ES modules), the repository's `scripts/` toolchain. YAML front
matter is parsed by the existing gate readers.

**Primary Dependencies**:
- Node built-ins only: `node:crypto` (SHA-256), `node:fs`, `node:child_process` (for `git` in
  `--diff`).
- The existing `scripts/lib/argv-contract.mjs`, `scripts/openwiki-policy.mjs` and
  `scripts/openwiki-stamp.mjs`.
- No new package.

**Storage**: files in git. Derived-page front matter carries the fingerprint, and four generator
artifacts become gitignored.

**Testing**:
- `node --test` under `scripts/__tests__/`.
- Each gate's `--selftest`: `check-openwiki-okf.mjs` and `check-openwiki-governance.mjs`.
- The workflow guard test (`wiki-maintain.guard.test.mjs`).

**Target Platform**: Linux CI runner (`guardrails / okf`), and the dev container and Windows host
for sessions. Line endings are normalised (R1).

**Project Type**: repository tooling. It lives outside the SDD-gated source trees, but the gate is
honoured anyway because the change rewrites a required CI context.

**Performance Goals**: V17 adds under 5 s over the full bundle (SC-006). That is about 50 hashes of
files under 100 KB, so milliseconds in practice.

**Constraints**:
- Offline, free and credential-less (FR-005).
- Unknown CLI arguments are rejected.
- No model call anywhere in the routine path.
- `MCM_ANTHROPIC_API_KEY` is used only by a manual rebuild, which is unchanged.

**Scale/Scope**:
- 74 concepts; 50 derived after R3; 24 canonical.
- 18 wiki test files, of which 8 are deleted with their modules (R5).
- `wiki-maintain.mjs` shrinks from 3,315 lines by roughly half (R7).

## Constitution Check

*GATE: must pass before Phase 0 research, and again after Phase 1 design.*

| Principle | Status | How |
|---|---|---|
| AI Assistant Constraints: adherence, no vibe coding | ✅ | Spec → plan → tasks before any script change. Deviations are recorded here. |
| Behavior-descriptive identifiers | ✅ | `staleDerivedPages`, `recordSourceFingerprint`, `wiki-refresh.mjs`. Requirement IDs appear only in provenance comments. V17/G14 are rule labels, which is the existing gate convention, not identifiers. |
| Comments only for non-obvious rationale | ✅ | Kept to the "why" (for example, why CRLF is normalised). |
| Technology agnosticism (spec vs plan) | ✅ | The spec names repository artifacts as subject matter (checklist note). The hash algorithm and code layout live here. |
| TDD (NON-NEGOTIABLE), with RED/GREEN checkpoints | ✅ | Every new rule and command has a self-test or unit test that is RED first (contracts list the scenarios). tasks.md follows `docs/templates/feature-test-tasks-template.md`. |
| Test type integrity | ✅ | Unit tests run against fixture trees in a temp dir. No integration tier is claimed. |
| Documentation updated with the change | ✅ | Runbook, INSTRUCTIONS.md, AGENTS.md, CLAUDE.md gate line, ADR-0004, ADR-0003 status (FR-011, FR-020, FR-021). |
| Security: no secrets in clear text, least credential | ✅ | Removes a recurring use of the paid key from CI's unattended path. Adds no credential. |
| Guards updated at the cause, never deleted (CLAUDE.md) | ✅ | G3 keeps its meaning under list-valued `actor` (R6). The workflow guard now asserts the absence of a schedule. Guards for retired machinery are deleted *with the machinery they guarded*, which is not a guard removed for convenience. Each deletion is listed in R5. |

**Re-check after Phase 1**: no new violations. The design adds one CLI, one OKF rule and one
governance rule, and only removes code elsewhere.

## Project Structure

### Documentation (this feature)

```text
specs/098-session-maintained-wiki/
├── spec.md
├── plan.md                 # this file
├── research.md             # R1–R9
├── data-model.md           # E1–E4
├── quickstart.md
├── contracts/
│   ├── wiki-refresh-cli.md
│   └── okf-v17.md          # also G14
├── checklists/requirements.md
└── tasks.md                # /speckit-tasks
```

### Source code (repository root)

```text
scripts/
├── openwiki-fingerprint.mjs        # NEW: sha256 (CRLF-normalised), staleDerivedPages(), recordSourceFingerprint()
├── wiki-refresh.mjs                # NEW: CLI per contracts/wiki-refresh-cli.md
├── check-openwiki-okf.mjs          # + V17; − V12, V16
├── check-openwiki-governance.mjs   # + G14; − G13; list-valued actor in G2/G3
├── openwiki-policy.mjs             # ACTORS membership for list-valued actor; mayWrite
├── openwiki-stamp.mjs              # drop `verified` from candidates (R2)
├── wiki-maintain.mjs               # + --pages; − range planning, run record, backlog, escalation, cooldowns, drift, claims audit
├── wiki-quiet.mjs, wiki-escalation.mjs, wiki-claims-audit.mjs,
│   openwiki-claims.mjs, openwiki-drift.mjs        # DELETED (drift after cut-over)
└── __tests__/
    ├── openwiki-fingerprint.test.mjs, wiki-refresh.test.mjs   # NEW
    └── (8 retired test files deleted; R5)

.claude/skills/wiki-refresh/SKILL.md          # NEW
.forgejo/workflows/wiki-maintain.yml          # required `pages` input; − max-slices, since; − quiet step, marker commit
openwiki/policy.yaml, openwiki/protected.yaml, openwiki/INSTRUCTIONS.md
openwiki/**/*.md                              # cut-over: 11 refreshed, all recorded, sources/verified stripped
.gitignore                                    # + the four retired artifacts
docs/decisions/ADR-0004-session-maintained-wiki.md   # NEW
docs/decisions/ADR-0003-claims-and-fingerprints.md   # status: superseded in part
docs/runbooks/wiki-maintenance.md, AGENTS.md, CLAUDE.md (one gate line)
```

**Structure decision**: the shared fingerprint logic gets its own module,
`openwiki-fingerprint.mjs`. It is imported by V17, G14 (the resource rules) and `wiki-refresh.mjs`,
following the existing one-definition pattern of `openwiki-stamp.mjs` and `openwiki-claims.mjs`.

## Delivery order (one PR, per the batching rule)

The bundle edits and the check must land together, or `main` goes red. Everything else is small
enough to review in the same PR. Commit order inside the PR:

1. **Foundation (RED → GREEN):** `openwiki-fingerprint.mjs` and its tests; `wiki-refresh.mjs` and
   its tests.
2. **Governance:** list-valued actor; G14; the policy.yaml entry; the two pages become canonical.
3. **Retirement:**
   - delete sidecars, manifest, marker and run record, and gitignore them;
   - strip `sources:`/`verified:`;
   - remove V16/G13 and the dead modules and tests.
4. **Rebuild path:** `--pages` in `wiki-maintain.mjs`, the workflow input, the post-step
   stamp/strip, and the guard test updates.
5. **Cut-over:**
   - refresh the 11 pages, each from its source diff;
   - `--record --all-fresh` for the rest;
   - **V17 on**, V12 off;
   - `openwiki-drift.mjs` deleted last.
6. **Records:** ADR-0004, ADR-0003 status, runbook, INSTRUCTIONS.md, AGENTS.md, the CLAUDE.md gate
   line, and the `wiki-refresh` skill.
7. **Backlog:** close item #977 (superseded) and item #739 (resolved by canonicalisation), each with
   a comment, after merge.

## Risks

| Risk | Mitigation |
|---|---|
| Sessions bump fingerprints without reading the diff | The skill makes `--diff` step one. A fingerprint-only change is visible in review. Accepted by the operator (spec Assumptions). |
| Another session merges a source change mid-PR | V17 fails on rebase and names the page. Refresh and re-record, as a normal conflict. |
| A canonical `data-model.md` drifts if the domain layer becomes active again | Measured 0 commits in 3 months. Re-pointing at a file later is a one-line change plus a record. |
| The rebuild's generator rewrites a session-corrected page | It only rewrites pages the operator names. |

## Complexity Tracking

No constitution violations to justify.
