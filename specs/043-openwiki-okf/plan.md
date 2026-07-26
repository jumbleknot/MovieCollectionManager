# Implementation Plan: OpenWiki + OKF Knowledge Layer

**Branch**: `043-openwiki-okf` | **Date**: 2026-07-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/043-openwiki-okf/spec.md`

## Summary

Stand up an OKF-formatted knowledge bundle at `openwiki/` that navigates and links to the canonical
documentation rather than restating it, and gate it so malformed or leaky content cannot land.

The technical approach, after Phase 0 research: install `openwiki@0.2.3` (pinned) and drive it
**entirely from environment variables** — never the interactive onboarding — using
`openwiki code --update --print`, which creates the bundle when none exists. Author
`openwiki/INSTRUCTIONS.md` first to scope generation and forbid topology leakage. Validate the result
with a new `scripts/check-openwiki-okf.mjs` gate that mirrors the tool's own front-matter contract and
layers this repository's extra rules on top, wired into `guardrails.yml` as a new `okf` job with the
mandatory failure digest. Telemetry — on by default in this tool, and unmentioned by the proposal — is
explicitly disabled in both workspaces.

## Technical Context

**Language/Version**: Node.js ≥ 22 (dev container runs v24.18.0). Gate script is plain ESM `.mjs`,
matching the nine existing `scripts/check-*.mjs` gates. Bundle content is Markdown + YAML front matter.

**Primary Dependencies**: `openwiki@0.2.3` as a **pinned global dev tool** — not a workspace
dependency, nothing added to `package.json` or any lockfile. The gate imports `yaml`, already a root
dependency used by several existing gates. **No new runtime dependency is introduced.**

**Storage**: Files in git. The bundle is `openwiki/**`. Tool state lives in the disposable
`~/.openwiki` (see research R6) — deliberately **not** persisted to a named volume.

**Testing**: `node:test` + `node:assert/strict`, test file at
`scripts/__tests__/check-openwiki-okf.test.mjs`, driving the real gate CLI as a subprocess against
fixture bundles in a temp dir — the established pattern from `check-dast-findings.test.mjs`. Plus the
repository-wide gates (`secret-scan.mjs`, `check-topology-scrub.mjs`, `check-ci-digest-coverage.mjs`)
and the full web E2E regression, which the spec requires with no deviation.

**Target Platform**: Dev container (primary, Linux) and Windows host (secondary — mobile, emulator,
native builds). CI runs on the self-hosted Forgejo `ubuntu-latest` runner.

**Project Type**: Repository tooling + documentation. No application code changes; no service,
schema, or API surface is touched.

**Performance Goals**: The gate must add negligible time to `guardrails` — target **under 5 seconds**
for a bundle of the expected size, since it only reads and parses local markdown and performs no
network I/O (FR-013a).

**Constraints**: Gate is **offline, keyless, and fail-closed**. No new CI secret (FR-019). No egress
allowlist change (FR-027, FR-030). No content removed from `CLAUDE.md` (FR-022). Generation is a
paid model run, so the update loop stays manual this feature (spec Out of Scope).

**Scale/Scope**: ~40–70 concepts targeting full navigational coverage of the canonical docs (FR-007,
SC-012): 12 runbooks + 2 relocated operator documents, the ADR set, the architecture documents,
per-project overviews, cross-cutting invariants, and one process concept.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — see bottom.*

| Principle | Assessment |
|---|---|
| **Technology Agnosticism in Specification** | **PASS.** `spec.md` names no version, package, path, env var, or job. All of that lives here in `plan.md`. Verified during `/speckit-clarify` and recorded in the requirements checklist notes. |
| **Test-Driven Development (NON-NEGOTIABLE)** | **PASS.** The gate is the testable artifact. Fixture bundles per failure class fail before each validation exists and pass after (SC-010). Fail-closed behavior (FR-014a) makes fixture-driven RED→GREEN mandatory rather than optional, since the real-tree run cannot be green until the bundle exists. |
| **Secrets Management (NON-NEGOTIABLE)** | **PASS, and strengthened.** No new secret material anywhere: generation reuses the ambient `ANTHROPIC_API_KEY`, no `~/.openwiki/.env` is created (research R2), no CI secret is added, and the existing whole-tree gates are asserted to cover `openwiki/**` (FR-018). |
| **Documentation must be updated as part of implementation** | **PASS.** Two setup runbooks, the README structure block, the constitution directory tree, and the Final Validation Checklist are all in scope. |
| **Monorepo Directory Structure** | **DEVIATION — APPROVED by Steve, 2026-07-26.** The governing tree does not include a root `openwiki/`; the amendment adding it is approved. Tracked in Complexity Tracking below and carried out by FR-025. |
| **AI Assistant Constraints — No Vibe Coding** | **PASS.** Phase 0 verified tool behavior against the shipped package rather than the vendor blog, and corrected two proposal errors (instructions-file location, `logs.md` vs `log.md`). |
| **Behavior-Descriptive Identifiers** | **PASS.** `check-openwiki-okf.mjs` describes behavior; requirement IDs appear only in header comments, per the traceability exception. |

**No security-principle gates apply** — this feature adds no endpoint, no authentication path, no data
store, and no user-facing surface. The Security section's authN/authZ, session, and transport
requirements are not engaged.

## Project Structure

### Documentation (this feature)

```text
specs/043-openwiki-okf/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — package inspection findings
├── data-model.md        # Phase 1 output — concept/bundle model + validation rules
├── quickstart.md        # Phase 1 output — runnable validation guide
├── contracts/
│   └── check-openwiki-okf-cli.md   # Gate CLI contract (args, exit codes, output)
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
openwiki/                              # NEW — the OKF bundle (generated, committed)
├── INSTRUCTIONS.md                    # NEW — hand-authored generation brief (NOT generated; R1)
├── index.md                           # generated directory summary
├── log.md                             # generated change history (singular — R7)
└── <concept dirs>/…                   # generated concepts, one per subject

scripts/
├── check-openwiki-okf.mjs             # NEW — conformance gate (--selftest, exit 0/1/2)
└── __tests__/
    ├── check-openwiki-okf.test.mjs    # NEW — fixture-driven contract tests (node:test)
    └── fixtures/openwiki-okf/         # NEW — one fixture bundle per failure class

.devcontainer/toolchain.Dockerfile     # MODIFIED — pin openwiki@0.2.3 beside claude-code
.devcontainer/devcontainer.json        # MODIFIED — OPENWIKI_* + telemetry-disable containerEnv
.forgejo/workflows/guardrails.yml      # MODIFIED — new `okf` job + failure-digest step
infrastructure-as-code/project.json    # MODIFIED — `wiki-update` + `okf-lint` Nx targets

CLAUDE.md                              # MODIFIED — OPENWIKI block (tool-managed) + shell-line fix
AGENTS.md                              # MODIFIED — OPENWIKI block (tool-managed)
.github/agents/…, .opencode/…, .codex/…  # MODIFIED — hand-added pointer (3 surfaces)

docs/runbooks/
├── devcontainer.md                    # MODIFIED — container setup + pin
├── dev-environment-setup.md           # MODIFIED — host setup + same pin
├── Phase-15-Operator-Checklist.md     # MOVED from docs/proposals/homelab-setup/
└── Server-Setup-Runbook.md            # MOVED from docs/proposals/homelab-setup/

.specify/memory/constitution.md        # MODIFIED — directory tree amendment (FR-025)
README.md                              # MODIFIED — repo-structure block
```

**Structure Decision**: The bundle is a **new root-level directory**, kept strictly separate from
`docs/`. This gives the clean ownership rule the spec depends on: everything under `openwiki/` may be
regenerated by a tool; everything under `docs/` is human-owned and no generator may touch it. The
gate script and its tests follow the existing `scripts/` + `scripts/__tests__/` layout exactly rather
than introducing a new location.

## Implementation Approach

### Ordering constraint (from the fail-closed clarification)

FR-014a makes the gate fail when the bundle is absent, so the gate cannot be committed green ahead of
the bundle. The build order is therefore:

1. Gate + fixtures + tests (RED→GREEN entirely against fixtures — never the real tree).
2. `openwiki/INSTRUCTIONS.md` authored.
3. First generation run → real bundle exists.
4. Gate runs green against the real tree; only then is the `okf` CI job wired in.

Wiring CI before step 3 would redden `main` for every intermediate commit.

### Generation invocation — an Nx target, not a remembered command

Generation and update are exposed as **Nx targets** on the `infrastructure-as-code` project, alongside
the existing `dast`, `sast`, `infra-scan`, and `check:naming` wrappers:

```bash
pnpm nx wiki-update infrastructure-as-code     # generate or refresh the bundle
pnpm nx okf-lint    infrastructure-as-code     # run the conformance gate locally
```

The target sets `OPENWIKI_PROVIDER=anthropic` and **`OPENWIKI_TELEMETRY_DISABLED=1`** itself and runs:

```bash
openwiki code --update --print
```

`--update` creates the bundle if absent, so the interactive `--init` is never run and no
`~/.openwiki/.env` is written (research R2). `ANTHROPIC_API_KEY` is already ambient in both workspaces.

**Why a wrapper rather than documented env vars** (research R4c): the container can set the variable
via committed `devcontainer.json` `containerEnv`, but the Windows host has no committed equivalent, so
documentation alone would reduce FR-030's "every environment" to "every environment where the
developer remembered." The Nx target makes the opt-out structural in both workspaces. The
`containerEnv` entry is kept as defense in depth for ad-hoc direct CLI use.

**No new host environment variable is required by this feature.** Both `containerEnv` values
(`OPENWIKI_PROVIDER=anthropic`, `OPENWIKI_TELEMETRY_DISABLED=1`) are non-secret **literals written
directly in `devcontainer.json`** — deliberately *not* `${localEnv:…}` passthroughs. The only host
value consumed is `ANTHROPIC_API_KEY`, already mapped by an existing `${localEnv}` entry. A host-side
`setx OPENWIKI_PROVIDER …` is inert for both the container (host vars reach it only through an explicit
`${localEnv:…}` mapping, and only after a rebuild) and the Nx target (which sets the variable itself).

**`DO_NOT_TRACK` is deliberately not set** (research R4b): it is a cross-tool convention, not an
OpenWiki variable, and is fully redundant with `OPENWIKI_TELEMETRY_DISABLED` for this tool. Setting it
repository-wide is a separate posture decision with a much wider blast radius.

For the SC-013 evidence run, pass `--telemetry-file=<path>` through the target and confirm the payload
is empty.

### Gate design

Mirrors the tool's own front-matter rules (research R8) and layers this repository's requirements on
top — deliberately **not** stricter about `title`/`description`, which the generator itself tolerates,
so the gate never fights its own generator. Full argument, exit-code, and output contract in
[contracts/check-openwiki-okf-cli.md](./contracts/check-openwiki-okf-cli.md); validation rules and file
classes in [data-model.md](./data-model.md).

### Leak-gate interaction

`secret-scan.mjs` and `check-topology-scrub.mjs` already walk the whole tracked tree, so `openwiki/**`
is covered the moment it is committed. FR-018 requires this be *asserted* rather than assumed — a test
confirms a planted topology-shaped string inside a bundle path is caught. Per FR-012, a real hit is
fixed in `INSTRUCTIONS.md` and regenerated; **no allowlist entry is ever added.**

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New root directory `openwiki/`, absent from the constitution's Monorepo Directory Structure | The tool writes its code-mode bundle to `openwiki/` by convention, and the separation from `docs/` is what makes the "generated vs human-owned" ownership rule enforceable | Nesting under `docs/` was rejected: it would put generator-rewritable files in the same tree as the precision operator runbooks, destroying the review rule that protects them. **Amendment approved by Steve on 2026-07-26**; the edit itself is an implementation task under FR-025. |
| A tenth `check-*.mjs` gate and a fourth `guardrails` job | FR-016 requires always-on enforcement, and FR-017 requires a job-scoped failure digest | Folding into the existing `naming` job was rejected: it conflates unrelated gates and makes the published failure digest ambiguous about which gate failed. |

## Post-Design Constitution Re-Check

Re-evaluated after Phase 1 artifacts were produced:

- **TDD** — reinforced. The CLI contract fixes exit codes before implementation, and every validation
  rule in `data-model.md` maps to a named fixture, so no rule can be written without a failing test.
- **Secrets** — reinforced. Research R2 removed the `~/.openwiki/.env` the proposal assumed, and R4
  added a telemetry requirement the proposal missed entirely. Net secret surface is unchanged, and
  outbound reporting is now explicitly off rather than accidentally blocked.
- **Technology Agnosticism** — holds. All concrete choices landed here and in the Phase 1 artifacts;
  `spec.md` gained only outcome-shaped requirements (FR-030, SC-013).
- **Directory Structure** — the single deviation remains, tracked above, unchanged by the design work.

**Gate status: PASS**, with one documented deviation requiring human approval at review time.
