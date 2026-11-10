# Research: Session-Maintained Wiki Summaries (098)

Measured on `origin/main` at 211aa928 (2026-11-10) unless stated otherwise.

## R1 — Fingerprint: what is hashed, where it lives, what it is called

- **Decision**: `resource-sha256: <64 hex>` in the page's front matter. It is the SHA-256 of the
  resource file's bytes after normalising `\r\n` to `\n`, read from the working tree.
- **Rationale**:
  - **Working tree, not `git show HEAD:`.** A session records the fingerprint before it commits,
    and CI's checkout *is* the commit. Both read the same bytes.
  - **CRLF normalisation.** A checkout on Windows with `core.autocrlf` must not make every page
    stale. The operator's host is Windows (CLAUDE.md, devcontainer runbook).
  - **The name pairs with `resource`.** No OKF rule restricts unknown keys (checked: no
    allowed-key list in `check-openwiki-okf.mjs`), so a new key costs nothing.
- **Alternatives considered**:
  - The git blob SHA: it hashes the stored form, so it differs from working-tree bytes when the
    file is uncommitted.
  - mtime or commit date: this is what the V12 drift warning uses today. It cannot tell a content
    change from a touch, and it needs git history in the checkout.

## R2 — The timestamp a refresh writes

- **Decision**: recording a fingerprint also sets `timestamp: <ISO 8601 UTC>` and removes
  `verified:`. `generated:` is left as provenance.
- **Rationale**:
  - `conceptStamp` (`scripts/openwiki-stamp.mjs`) already takes the newest of `generated.at`,
    `verified.at` and `timestamp`, so a session's refresh correctly becomes the page's stamp with
    no change to that reader.
  - `verified:` records Claims verification, which no longer exists (R5).
- **Alternatives considered**: rewriting `generated:` with a session actor. Rejected because it
  would misstate provenance: `generated` means "openwiki rewrote the body".

## R3 — The two directory resources

| Page | Resource | Decision | Why |
|---|---|---|---|
| `process/spec-driven-development.md` | `specs/` | **Canonical** (operator, 2026-11-10) | It is about process, which does not change with the specs' contents. Item #739 parked it for exactly this reason. |
| `architecture/data-model.md` | `backend/mc-service/src/domain/` | **Canonical** | It genuinely summarises 14 files across `domain/` and `domain/specifications/`, so no single file is honest. `domain/` has **0 commits since 2026-08-10**, so a hand-maintained page carries no real drift risk. |

- **Alternative considered**: a tree hash over the directory. Rejected because FR-006 rules out
  directory resources, and a tree hash would block every PR touching any domain file on one large
  page. If the domain layer becomes active again, re-pointing the page is a one-line change plus a
  stamp.

## R4 — Files no `resource` may name (FR-007)

- **Decision**: the governance check fails a derived page whose `resource` matches either of two
  sets:
  1. **A fixed deny-list** of files that Renovate's default managers or CD rewrite:
     - `**/.env.deploy`
     - `**/package.json`, `**/pnpm-lock.yaml`
     - `**/Cargo.toml`, `**/Cargo.lock`
     - `**/pyproject.toml`, `**/uv.lock`
     - `**/Dockerfile*`, `**/*.Dockerfile`
     - compose files (`**/*compose*.y?(a)ml`)
     - `.forgejo/workflows/**`
     - `renovate.json`
     - toolchain pins Renovate updates by default: `**/.nvmrc`, `**/.node-version`, `**/.tool-versions`, `**/rust-toolchain.toml`, `**/.python-version`, `**/requirements*.txt`
  2. **Every `managerFilePatterns` regex in `renovate.json`'s `customManagers`.** These are read at
     check time, so a new custom manager is covered without editing the check.
- **Authority**: this list is the definition of "Renovate-managed" for G14, kept beside the check with a
  comment naming Renovate's default `fileMatch` set as its source. Widening it is a one-line edit. It
  is not a promise to mirror Renovate exactly; FR-007 says so.
- **Measured**: none of the 50 file resources matches today. The near misses are
  `infrastructure-as-code/komodo/stacks.toml` and `infrastructure-as-code/project.json`; neither
  is managed by Renovate.
- **Alternative considered**: asking Renovate for its file list (`renovate --print-config`).
  Rejected because it needs the Renovate toolchain and network in the `okf` job.

## R5 — What is retired, and who reads it today

| Artifact | Readers today | Fate |
|---|---|---|
| `openwiki/.claims/**` (4.5 MB, 43 sidecars) | openwiki's preflight, V16, `openwiki-claims.mjs`, `wiki-claims-audit.mjs`, `wiki-maintain.mjs` | Deleted and gitignored |
| `openwiki/.page-manifest.json` (18 KB, 45 entries) | openwiki in-run skip/resume, V16 | Deleted and gitignored |
| `openwiki/.last-update.json` | openwiki's `update` mode | Deleted and gitignored |
| `openwiki/.maintenance-state.json` | `wiki-maintain.mjs`, `wiki-quiet.mjs` | Deleted (no run record) |
| `sources:` front-matter list | nothing: each `openwiki-source-*` id appears once, in front matter | Stripped |
| `verified:` front matter | `openwiki-stamp.mjs` (as one stamp candidate), V16 | Stripped (R2) |
| V16, V12, G13 | the gates | Removed. V12 is replaced by the new V17; G13 has nothing left to separate |
| `scripts/wiki-quiet.mjs`, `wiki-escalation.mjs`, `wiki-claims-audit.mjs`, `openwiki-claims.mjs`, `openwiki-drift.mjs` | `wiki-maintain.mjs`, the workflow | Deleted, with their tests (`wiki-quiet`, `wiki-escalation`, `wiki-claims-audit`, `openwiki-claims`, `openwiki-drift`, `wiki-cooldown`, `wiki-drift-plan`, `openwiki-ignore-claims.guard`). `openwiki-drift.mjs` is used once by the cut-over (R8) before deletion. |
| `policy.yaml` entries `openwiki/.claims/**`, `openwiki/.page-manifest.json` | G1 (classification) | Removed; the paths are no longer tracked |

## R6 — The writer policy (FR-015)

- **Today**:
  - `ACTORS = ['agent', 'generator']` (`scripts/openwiki-policy.mjs:33`).
  - `actor` holds one value.
  - G3 confines `generator` to `openwiki/`.
  - `mayWrite(policy, path, actor = 'generator')` is what `wiki-maintain.mjs` verifies generator
    writes against.
- **Decision**: `actor` may be a **list**. `openwiki/**` becomes `actor: [agent, generator]`.
  - G2 validates each member.
  - G3 still forbids `generator` outside `openwiki/`.
  - `mayWrite` checks membership.
  - The rationale line cites ADR-0004.
- **Rationale**: both writers are real. A session writes routinely, and the generator writes on a
  manual rebuild. The guard (G3) keeps its meaning and is updated at the cause, not deleted.
- **Alternative considered**: `actor: agent` only. Rejected because it would fail the rebuild's
  own policy check, or force that check to be deleted.

## R7 — How much of `wiki-maintain.mjs` the named-page rebuild keeps

- **Today**: 3,315 lines, with dispatch inputs `max-slices`, `since` and `reasoning-effort`, and
  no way to name pages. Its plan comes from a git range (`--since`/`coveredCommit`) through
  `computePlan`, plus drift, cooldowns, the backlog and escalation.
- **Decision**: add `--pages <area/page.md,…>`, which builds slices directly. Pages are grouped by
  area, using the existing `renderRunMessage({area, pages})`, and then reuse the existing
  execution chain:
  - preflight,
  - `wiki-update` invocation under the job deadline,
  - `revertUnrequested`,
  - per-slice verification (conformance and policy),
  - a post-step that stamps (R1) and strips (R5) each landed page,
  - `--propose`.
  The workflow gets a required `pages` input. `max-slices` and `since` are removed.
- **Removed from `wiki-maintain.mjs`**:
  - `computePlan`/`planSlices` range planning,
  - `selectDrift`,
  - `cooledPages`,
  - the backlog, escalation and `parked` handling,
  - the run-record read/write/merge (`writeRunRecord`, `mergeRunRecords`, `assertRecordShape`),
  - `--plan`/`--since`/`--claims-audit`/`--merge-record`,
  - the marker-advance commit.
  The remaining exit codes are 0 (all named pages landed), 1 (a named page failed) and 2
  (bad input/preflight); 3 has nothing left to mean.
- **Rationale**: the spec removes what is unattended (FR-016), not what makes a rebuild correct
  (Assumptions). Each kept piece has its own tests today, and they are re-pointed at `--pages`.
- **Alternative considered**: a new slim `wiki-rebuild.mjs` that imports the kept functions, with
  `wiki-maintain.mjs` deleted. Possible, but it moves about 1,500 lines under a new name with no
  behaviour gain, and makes the diff harder to review. Deletion in place keeps `git blame`.

## R8 — The cut-over set

- **Measured** (`check-openwiki-okf.mjs` V12, 2026-11-10): **12 pages** have a source newer than
  their stamp:
  - `architecture/system-overview.md`, `projects/mc-service.md`, `projects/mcp-servers.md`
    (all from `docs/MCM-Architecture.md`),
  - `projects/repository.md`,
  - the gotcha pages `expo-router-and-transport-traps.md`, `external-id-url-opening.md`,
    `keycloak-service-account.md`, `playwright-testid-mapping.md`,
    `session-lifecycle-and-eviction.md`,
  - `runbooks/devcontainer.md`, `runbooks/wiki-maintenance.md`,
  - `process/spec-driven-development.md`, which becomes canonical (R3).
  That leaves **11 to refresh**.
  - The "30" in the proposal was openwiki's Claim-level staleness: any file cited by any Claim
    changed. That is exactly the granularity this feature abandons (FR-002).
- **Decision**:
  - The cut-over refreshes those 11 against their sources' current content.
  - It stamps all other derived pages as they are, because their stamp is already newer than
    their source's last commit.
  - V17 then turns on in the same PR.
- **Rationale**: the stamp-versus-last-commit test is the best available evidence of "fresh"
  before fingerprints exist. After the cut-over, fingerprints replace it.

## R9 — Where the duty is announced (FR-011)

- **Decision**:
  - **CLAUDE.md** gets a new gate line in "Gates that run before you act". It points at the
    `wiki-refresh` skill and at the runbook section, because CLAUDE.md is an index and the
    governance check fails prose there.
  - **AGENTS.md** replaces the OpenWiki paragraph, including "Do not hand-edit pages under
    `openwiki/` that carry a `resource`".
  - **`openwiki/INSTRUCTIONS.md`**: its "where a new learning goes" rule inverts for derived pages.
    Edit the source **and** refresh the summary in the same PR.
- **Measured**: the CLAUDE.md gate list is one-line entries with a link. `check-openwiki-governance.mjs`
  enforces "index only", so the line must follow that form.
- **Naming**: the proposal's `wiki-refresh --stamp` is `--record` here (contracts/wiki-refresh-cli.md).
  "Stamp" already names the page's `generated.at`/`timestamp` date (`openwiki-stamp.mjs`), so the command
  that writes the source fingerprint is named for what it records.
