# OpenWiki 0.2 (with OKF) — Research & Adoption Plan for MovieCollectionManager

**Date:** 2026-07-18 · **Revised:** 2026-07-26 (rescan of repo changes; dual host/dev-container setup; `docs/proposals` scoping decision; `docs/` migrate-vs-reference recommendation)
**Scope:** Research on OpenWiki 0.2 and the Open Knowledge Format (OKF), plus a concrete, repo-specific recommendation for adopting them in the MCM monorepo. Prepared read-only — no files in the repository were created or modified.

**What changed in the repo since the first draft (rescan 2026-07-26):**

- `specs/042-ci-self-serve-diagnostics/` now exists → the adoption feature proposed here is renumbered **043**.
- New runbook `docs/runbooks/ci-diagnostics.md` (runbook count now 12); `devcontainer.md`, `e2e-testing.md`, `android-emulator.md`, `sast-scanning.md`, and `prod-reboot-resilience.md` all updated this week.
- Two new proposals (`PRD-CISelfServeDiagnostics.md`, `PRD-McServiceHttpAuthzIntegration.md`) — `docs/proposals` is still actively growing.
- `CLAUDE.md` grew from ~61 KB to ~68.5 KB in eight days (+13%) — the instruction-file-bloat problem is compounding, which strengthens the case for the wiki.
- CI workflows (`guardrails.yml`, `app-ci.yml`, `cd-deploy.yml`, `infra-image-scan.yml`), `package.json`, and `renovate.json` updated; no changes that alter the approach below.
- Correction from Steve: the **DinD dev container is now the primary dev workspace** (the Windows host remains necessary for emulator/native-mobile work). Note that `CLAUDE.md` still opens with "the default shell on this machine is PowerShell" — an example of instruction files lagging reality that the wiki's `--update` loop is designed to catch.

---

## Part 1 — What OpenWiki 0.2 and OKF actually are

### OpenWiki (LangChain)

OpenWiki is LangChain's open-source CLI/agent that **generates and maintains an agent-facing wiki for a codebase**. Instead of packing everything into ever-growing `CLAUDE.md`/`AGENTS.md` instruction files, it writes a separate wiki and adds a short reference in the instruction files telling coding agents when to consult it. Key mechanics:

- Install: `npm install -g openwiki` (on Windows, npm or pnpm is preferred over bun, which needs VS Build Tools to compile `better-sqlite3`).
- `openwiki --init` — interactive init: prompts for a model provider + API key, scans the repo, generates the wiki (an `openwiki/` directory) and wires references into `AGENTS.md`/`CLAUDE.md`. An `INSTRUCTIONS.md` file lets you author scope and priorities for the generator.
- `openwiki --update` — incremental maintenance: examines recent commits/diffs and updates only the affected wiki sections.
- Configuration and API keys live in `~/.openwiki/.env` (home directory, **outside the repo**). Providers: Anthropic, OpenAI, OpenRouter, Fireworks, Baseten, and OpenAI-compatible endpoints; `OPENWIKI_PROVIDER` / `OPENWIKI_MODEL_ID` select the model.
- CI automation: a shipped `openwiki-update.yml` GitHub Action runs on a schedule and opens a PR with doc updates; GitLab CI and Bitbucket examples exist in `/examples`. In workflows, `openwiki code --update --print` runs without `--init`.

### OKF — the Open Knowledge Format

OKF is a **vendor-neutral spec from Google Cloud (v0.1, published June 2026)** that formalizes the "LLM wiki" pattern: curated knowledge as plain markdown files with a small set of structured YAML front-matter fields. OpenWiki 0.2's headline change is that **generated wikis are now OKF-formatted** (existing wikis convert automatically on upgrade). The spec in brief:

- **Just markdown, just files, just YAML front matter.** A "bundle" is a directory tree; each markdown file is one *concept*; the file path is the concept's identity.
- **Front matter:** only `type` is required. Reserved queryable fields: `title`, `description`, `resource` (canonical URL to the authoritative source), `tags`, `timestamp` (ISO 8601). Unknown custom keys are permitted and ignored by consumers.
- **Reserved filenames:** `index.md` per directory (progressive-disclosure navigation — summarizes contained files using their front-matter descriptions) and `log.md` (dated change history; OpenWiki's blog refers to `logs.md`).
- **Links are edges:** ordinary markdown links between concept files turn the directory into a knowledge graph.
- **Deliberately lenient** conformance (broken links and unknown types tolerated); designed for backward-compatible growth.

### Why this combination matters for agents

Structured front matter lets agents **retrieve deterministically** (filter by `type`, `tags`, `description`) instead of open-ended agentic grep across a large wiki — fewer tokens, faster context assembly. `logs.md` lets an agent see *what changed* without re-reading the wiki. And because OKF is an open format, the wiki is consumable by any tool (Google ships a static HTML visualizer; community linters/viewers are emerging), not just OpenWiki itself.

---

## Part 2 — Repository assessment (what I found)

MCM is a polyglot Nx/pnpm monorepo: Expo/React Native universal app + BFF (`frontend/mcm-app`), Rust/Axum Clean-Architecture service (`backend/mc-service`), Python LangGraph agent gateway (`agents/movie-assistant`), three Python MCP servers, Docker/Komodo IaC, and self-hosted Forgejo Actions CI/CD. Development is strictly spec-driven (GitHub Spec Kit: 42 feature folders under `specs/`, a 109 KB constitution) with mandatory TDD.

Observations that shape the recommendation:

1. **This repo is exactly OpenWiki's target case — instruction-file bloat is real and compounding.** `CLAUDE.md` is ~68.5 KB (up 13% in the last week alone) of dense, load-bearing operational knowledge (gotchas, CI operator loops, env-scoped model rules, port-collision history). It is loaded into every Claude Code session whether or not the session touches those areas. A structured wiki with progressive disclosure is precisely the remedy OpenWiki 0.2 was built for.

2. **Knowledge is already rich but scattered across at least five surfaces:** `CLAUDE.md`, `AGENTS.md`, `docs/` (architecture, 12 runbooks, ~20 PRDs/proposals, ADRs), `.specify/memory/constitution.md`, and per-project READMEs — plus parallel agent-config trees for four assistants (`.claude/`, `.github/agents` (Copilot), `.opencode/`, `.codex/`). An OKF wiki can become the shared, tool-neutral knowledge layer all of them point at.

3. **Hard repo rules the adoption must respect:**
   - **pnpm only; npm/yarn hard-blocked** in-repo via `preinstall: only-allow pnpm`. (A *global* `npm install -g` wouldn't trip that guard, but use `pnpm add -g openwiki` for consistency with policy.)
   - **Everything runs through Nx** for build/test/lint/deploy; dev-machine tools like RTK are the sanctioned exception pattern.
   - **No secrets in git — CI-enforced** by `scripts/secret-scan.mjs` (whole tracked tree, credential-*shaped* strings included) and `scripts/check-topology-scrub.mjs` (blocks the real domain/tailnet-host/IPs). **Generated wiki pages will be scanned**, so the generator must never echo hosts or credential-shaped values it sees in runbooks.
   - **CI is Forgejo Actions, not GitHub Actions** (`.forgejo/workflows/`; GitHub is a no-Actions push mirror). OpenWiki's shipped GitHub Action can't be dropped in as-is; PRs must be opened via the Forgejo API (the repo already documents this pattern — `gh` doesn't work against the forge).
   - **Spec-driven development governs structural changes.** The constitution's Monorepo Directory Structure doesn't include an `openwiki/` directory, and constitution deviations need human approval. Adoption should be a Spec Kit feature — **`specs/043-openwiki-okf/`** (042 is now taken by ci-self-serve-diagnostics) — with a small constitution/README amendment.
   - **The DinD dev container is the primary dev workspace**; the Windows host remains in play for Android emulator, native builds, and Maestro mobile E2E. OpenWiki therefore has to work in **both** environments (see Phase 1). The container has a default-deny egress firewall whose allowlist already includes `api.anthropic.com` and `registry.npmjs.org` — both installing and running OpenWiki work in-container **with no firewall change** (and per the repo's own rule, the allowlist should not be widened).

4. **Anthropic API access already exists in both environments** (`ANTHROPIC_API_KEY` reaches the container via `devcontainer.json` `${localEnv}` passthrough; Claude is the golden/prod model for the agent layer), so `OPENWIKI_PROVIDER=anthropic` needs no new secret infrastructure for local runs.

---

## Part 3 — Recommended approach

### Guiding principle: the wiki is a *navigation and gotcha* layer, not a rewrite of `docs/`

MCM already has excellent canonical docs. The failure mode to avoid is a second, drifting copy of `MCM-Architecture.md` and the runbooks. Instead, use OKF's `resource` field the way the spec intends: wiki concepts carry the structured metadata, the distilled summary, and the load-bearing gotchas, and **link to the canonical doc** (`docs/runbooks/...`, `specs/NNN-.../plan.md`, constitution sections) as the authoritative source. `INSTRUCTIONS.md` is the lever for enforcing this. (Whether `docs/` should *eventually* fold into the wiki is addressed in Part 4.)

### Decision: exclude `docs/proposals` from the wiki

Short answer to the open question: **no, proposals should not be wiki'd.** The wiki's job is to describe *current truth* about the codebase; proposals are pre-spec ideation that is superseded the moment a spec exists (`PRD-IntegrationTestCIEnforcement` → spec 041, `PRD-CISelfServeDiagnostics` → spec 042, etc.). Generating concept pages for them would (a) burn generation tokens on content that is stale by design, (b) pollute tag/type-based retrieval with dead ideas — the exact deterministic-search benefit OKF exists to provide, and (c) create a recurring review burden every `--update` cycle as proposals churn.

Recommended handling in `INSTRUCTIONS.md`: exclude `docs/proposals/**` from analysis, and instead have the wiki carry **one** small concept page (`type: Process`) describing the proposal → spec → implementation lifecycle, linking to the folder for humans.

One caveat the exclusion surfaces: a handful of files under `proposals/homelab-setup/` are not really proposals — `Phase-15-Operator-Checklist.md` and `Server-Setup-Runbook.md` are *live operator documents* that `CLAUDE.md` references as the authoritative CI/CD procedure. Excluding `proposals/**` would hide them from the wiki. Recommendation: relocate those living documents to `docs/runbooks/` (a rename, done inside feature 043, with the `CLAUDE.md` links updated) so the exclusion rule stays clean. Stale-but-kept history remains in `proposals/` untouched.

### Phase 0 — Govern it like any other feature (½ day)

Create **`specs/043-openwiki-okf/`** via the normal Specify flow. The spec covers: the new root `openwiki/` directory, the `docs/proposals` exclusion (and the two operator-doc relocations), the dual host/container setup, the maintenance workflow, and the guardrail interactions. Include a one-line amendment to the constitution's directory-structure tree and the README repo-structure block.

### Phase 1 — Set up in both environments, then init and review hard (1–1½ days)

OpenWiki must be runnable from the **dev container (primary)** and the **Windows host** (emulator/native-mobile sessions still happen there, and the host is where `--init`/`--update` may first be trialled).

**Dev container (primary) — bake it into the toolchain image.** The repo's stated philosophy is "full toolchain, pre-provisioned" (feature 038), and wiki maintenance is a *team/repo process*, not a personal convenience — so it belongs in `toolchain.Dockerfile` next to the existing `npm install -g @anthropic-ai/claude-code`, version-pinned (e.g., `npm install -g openwiki@0.2.x`), delivered via the normal `devcontainer-image.yml` image-refresh path. (The alternative — the dotfiles/personal-layer route used for RTK — would make wiki tooling per-developer and unavailable to a teammate's container; wrong fit here.) Configuration needs **no key material in the container**: set `OPENWIKI_PROVIDER=anthropic` (via `containerEnv` or the stack env) and let it reuse the `ANTHROPIC_API_KEY` that already arrives through `${localEnv}` passthrough — no `~/.openwiki/.env` to manage, nothing new to persist across recreates, no firewall change (both `api.anthropic.com` and `registry.npmjs.org` are already allowlisted). One devcontainer-specific check for the spec: confirm `~/.openwiki` state (OpenWiki keeps a local SQLite index) either tolerates ephemeral container home directories or gets a line in the named-volume persistence list alongside the existing tool caches.

**Windows host — per-machine install, RTK-style.** `pnpm add -g openwiki@latest` (npm/pnpm explicitly preferred over bun on Windows because of the `better-sqlite3` native build), config in `%USERPROFILE%\.openwiki\.env` with `OPENWIKI_PROVIDER=anthropic` + the same key — outside git, compliant with the secrets policy by construction. Pin the same version as the container image and record both in `docs/runbooks/dev-environment-setup.md` (host) and `docs/runbooks/devcontainer.md` (container), the same way RTK's pin is documented.

**Then init:**

1. Author `INSTRUCTIONS.md` *before* the first generation. Suggested directives:
   - Exclude from analysis: `node_modules/`, `target/`, `.venv/`, `.nx/`, `.pnpm-store/`, `.mypy_cache/`, `.ruff_cache/`, `dist/`, `coverage/`, `test-results/`, **all `.env*` files**, `secrets/`, lockfiles, and **`docs/proposals/**`** (per the decision above).
   - Never reproduce hostnames, ports+hosts, tokens, or anything credential-shaped; refer to "the forge host" / "the prod domain" abstractly (mirrors the existing topology-scrub rule).
   - Prefer linking to `docs/`, `specs/`, and the constitution over restating them; wiki pages should be summaries + pointers + gotchas.
   - Priority areas: per-project overviews (BFF modules, mc-service layers, agent layer, MCP servers), cross-cutting invariants (auth chain, env-scoped models, port ranges), and the "non-obvious design decisions" currently trapped in `CLAUDE.md`.
2. Run `openwiki --init` from the repo root — **in the dev container**, since that's the primary workspace and proves the baked-in setup end-to-end.
3. **Review the diff hard** before committing:
   - `CLAUDE.md` and `AGENTS.md` contain machine-managed blocks (`<!-- nx configuration start/end -->`, `<!-- SPECKIT START/END -->`). Verify OpenWiki's inserted wiki reference doesn't land inside or clobber them.
   - Run the guardrail gates locally against the generated tree: `node scripts/secret-scan.mjs` and `node scripts/check-topology-scrub.mjs` (each with `--selftest` first, per house rules). Treat any hit as a generator-prompt fix in `INSTRUCTIONS.md`, not an allowlist entry.
   - Spot-check factual accuracy of a sample of pages against source (LLM-generated docs can be confidently wrong; the wiki inherits the repo's "no vibe coding" standard). The stale "PowerShell is the default shell" line in `CLAUDE.md` is a live example of the class of drift to look for — fix it in `CLAUDE.md` as part of this feature.

### Phase 2 — Commit and wire up consumers (½ day)

- Commit `openwiki/` at the repo root (OKF is git-native by design; the wiki versions with the code it describes).
- Beyond the automatic `CLAUDE.md`/`AGENTS.md` references, add the same short pointer ("structured OKF wiki at `openwiki/` — query front matter by `type`/`tags` before broad searching") to the Copilot (`.github/agents/copilot-instructions.md`), OpenCode, and Codex config surfaces so all four assistants benefit, not just Claude Code.
- PR it through the normal forge flow. Note: `openwiki/**` is not in `app-ci`'s `paths:` filter, so wiki-only PRs will merge on guardrails alone — that is the *correct* behavior here (no build/test needed for docs), and worth stating in the spec so it isn't mistaken for the known paths-gap bug.

### Phase 3 — Automated maintenance on the forge (1 day)

Adapt OpenWiki's update workflow to Forgejo Actions as `.forgejo/workflows/openwiki-update.yml`:

- **Schedule:** weekly, off-peak, mirroring the `infra-image-scan.yml` pattern (e.g., Friday early-AM cron) — the runner is capacity-1 and `app-e2e` runs are ~23–30 min, so avoid contention with push-triggered CI.
- **Run:** `openwiki code --update --print` with `ANTHROPIC_API_KEY` from the **Forgejo Actions secrets store** (the sanctioned place for CI secrets; note this makes the workflow deliberately *non*-keyless, unlike `guardrails.yml` — call that out in the spec).
- **PR creation:** the shipped action opens PRs via GitHub tooling; on the forge, reuse the documented Forgejo API pattern (a scoped `write:repository` PAT like the existing `actions-cd-push` model, `POST /api/v1/repos/jumbleknot/mcm/pulls`). Never auto-merge — a human reviews wiki diffs, and the guardrails run on the PR as usual.
- **Fallback (perfectly acceptable v1):** skip CI automation initially and fold `openwiki --update` into the existing feature-completion checklist ("before marking a feature complete, run the wiki update and include the diff in the PR"). This gets 90% of the freshness benefit with zero new CI surface, and matches how the repo already treats doc updates as part of implementation (constitution: "Relevant documentation must be updated as part of the implementation process").

---

## Part 4 — Should the rest of `docs/` move into `openwiki/`, or be referenced from it?

The question: with `docs/proposals` excluded, would it be better to **migrate** the remaining `docs/` content (architecture, runbooks, ADRs, templates) into native OKF files under `openwiki/`, or keep them in place and **reference** them from the wiki?

**Recommendation: reference now; selectively migrate later; never migrate the runbooks' canonical text.** Reasoning:

**What migration would win.** One knowledge layer instead of two; every doc gains queryable front matter, `index.md` navigation, and `logs.md` change history; no summary-vs-canonical drift because there's only one artifact; OKF files are still plain markdown, so human readability on the forge/GitHub mirror is unchanged.

**What migration would cost — and why it loses right now:**

- **Link breakage at scale.** `CLAUDE.md`, `README.md`, the constitution, project READMEs, and many `specs/NNN` plans carry dozens of relative links into `docs/`. A wholesale move is a large, error-prone churn commit with follow-on fixes in machine-managed instruction files.
- **Constitution conflict.** The Monorepo Directory Structure mandates `docs/` for human-readable documentation. A wholesale move needs a bigger constitutional amendment than adding one directory — and `docs/` would still be needed for whatever doesn't fit the wiki (templates, test data, `.docx`/`.html` artifacts, which are not OKF concepts).
- **Generated and hand-authored content would share one tree.** `openwiki --update` rewrites files in its own directory. The runbooks are precision operator documents (rehearsed cutovers, firewall procedures, CI forensics) where an unsupervised LLM rewrite is a real hazard — exactly the content you *don't* want a generator "maintaining." Keeping hand-authored canon in `docs/` and generated navigation in `openwiki/` gives a clean review rule: everything in `openwiki/` may be regenerated; everything in `docs/` is human-owned.
- **Reversibility.** Reference-first is trivially reversible; a migration that breaks links and amends the constitution is not.

**The pragmatic path:**

1. **Now (feature 043):** wiki references `docs/` via `resource` links, as designed. Every runbook/ADR/architecture doc gets a wiki *concept stub* — front matter (`type: Runbook` / `Decision` / `Architecture`, tags, description), a distilled summary, the load-bearing gotchas, and the link.
2. **Later, once the wiki proves itself in sessions (a follow-on feature):** migrate the doc types where the OKF shape is a strict upgrade and inbound links are few — **ADRs** (`docs/decisions/` → `type: Decision` concepts; ADRs are immutable records, so generator-rewrite risk is nil) and possibly the **architecture overview** (split into per-container concepts, which is a better retrieval shape than one 53 KB file). Runbooks stay canonical in `docs/runbooks/` permanently.
3. **Optional middle path worth piloting:** OKF front matter can be added to `docs/` files *in place* — a bundle is just a directory of markdown, and the `openwiki/` location is an OpenWiki convention, not an OKF requirement. Adding front matter + an `index.md` to `docs/runbooks/` makes the runbooks OKF-queryable with zero moves and zero broken links. If that pilot works well, it delivers most of migration's benefit at almost none of its cost.

---

## Part 5 — Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Generated pages leak the forge host, prod domain, or credential-shaped strings scraped from runbooks | CI guardrails fail; worse, a real leak | `INSTRUCTIONS.md` redaction directives; run `secret-scan.mjs` + `check-topology-scrub.mjs` locally before every wiki commit; human review of all wiki PRs |
| Wiki drifts from or duplicates canonical `docs/` | Two sources of truth; agent confusion | "Navigation layer" principle: summaries + `resource` links, not rewrites; weekly `--update` keeps it current; Part 4's clean ownership rule (generated = `openwiki/`, human-owned = `docs/`) |
| `--update` rewrites hand-authored operator content | Corrupted runbooks | Keep runbooks canonical in `docs/` (Part 4); the generator only ever touches `openwiki/` |
| Init clobbers managed blocks in `CLAUDE.md`/`AGENTS.md` | Nx/SpecKit auto-update breakage | Diff review before commit; re-run `nx` sync if needed |
| Host and container installs drift apart | "Works in container, fails on host" wiki runs | Same pinned version both sides, baked into `toolchain.Dockerfile` and documented in the two setup runbooks |
| Initial generation cost/quality on a large polyglot monorepo | Token spend; shallow or wrong pages | Scope via `INSTRUCTIONS.md` exclusions (incl. `docs/proposals/**`) and priorities; sample-audit pages; iterate the instructions and regenerate sections rather than accepting weak output |
| OKF is v0.1 and young; OpenWiki 0.2 is a fresh release | Spec/tool churn | Low blast radius: the artifact is plain markdown in git — worst case it remains a useful static wiki; version pinned in the image + host install |
| New non-keyless scheduled CI job | Slightly widened CI secret surface | Use the Actions secrets store per existing policy; or defer Phase 3 and run updates locally |

## Part 6 — Bottom line

Adopt it. This repo is close to an ideal candidate: heavy, high-quality, scattered operational knowledge that is measurably compounding (~7.7 KB of new `CLAUDE.md` in a week); four different coding assistants consuming it; and existing infrastructure (Anthropic access in both environments, container egress already open to the right endpoints, self-hosted CI, doc-update culture) that makes both generation and maintenance cheap. The decisions locked in by this revision: **exclude `docs/proposals` from the wiki** (with the two live operator docs relocated to `docs/runbooks/`), **bake OpenWiki into the dev-container toolchain image** with an RTK-style pinned install on the Windows host, and **reference `docs/` rather than migrate it** — with ADR migration and in-place front matter on runbooks as proven follow-ons.

Suggested first step: create `specs/043-openwiki-okf/spec.md` and run Phase 1 on a branch, from the dev container.

---

## Sources

**OpenWiki / OKF:**
- [OpenWiki 0.2 brings OKF to codebase documentation (LangChain blog)](https://www.langchain.com/blog/openwiki-0-2-adds-okf-support)
- [Introducing OpenWiki (LangChain blog)](https://www.langchain.com/blog/introducing-openwiki-an-open-source-agent-for-repo-documentation)
- [langchain-ai/openwiki (GitHub)](https://github.com/langchain-ai/openwiki)
- [How the Open Knowledge Format can improve data sharing (Google Cloud blog)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
- [OKF spec & reference implementations (GoogleCloudPlatform/knowledge-catalog)](https://github.com/GoogleCloudPlatform/knowledge-catalog)
- [Google Cloud introduces OKF (MarkTechPost)](https://www.marktechpost.com/2026/06/16/google-cloud-introduces-open-knowledge-format-okf-a-vendor-neutral-markdown-spec-for-giving-ai-agents-curated-context/)
- [Open Knowledge Format: The Complete 2026 Guide (WitsCode)](https://witscode.com/open-knowledge-format)
- [Brace Sproul announcement (X)](https://x.com/BraceSproul/status/2077799633640919208)

**Repository files reviewed (read-only; rescanned 2026-07-26):**
- [README.md](computer:///E:/Programming/VSCode/MovieCollectionManager/README.md)
- [CLAUDE.md](computer:///E:/Programming/VSCode/MovieCollectionManager/CLAUDE.md)
- [AGENTS.md](computer:///E:/Programming/VSCode/MovieCollectionManager/AGENTS.md)
- [.specify/memory/constitution.md](computer:///E:/Programming/VSCode/MovieCollectionManager/.specify/memory/constitution.md)
- [docs/runbooks/devcontainer.md](computer:///E:/Programming/VSCode/MovieCollectionManager/docs/runbooks/devcontainer.md), [.devcontainer/devcontainer.json](computer:///E:/Programming/VSCode/MovieCollectionManager/.devcontainer/devcontainer.json), [.devcontainer/toolchain.Dockerfile](computer:///E:/Programming/VSCode/MovieCollectionManager/.devcontainer/toolchain.Dockerfile), [.devcontainer/init-firewall.sh](computer:///E:/Programming/VSCode/MovieCollectionManager/.devcontainer/init-firewall.sh)
- [package.json](computer:///E:/Programming/VSCode/MovieCollectionManager/package.json), [nx.json](computer:///E:/Programming/VSCode/MovieCollectionManager/nx.json), [pnpm-workspace.yaml](computer:///E:/Programming/VSCode/MovieCollectionManager/pnpm-workspace.yaml)
- [docs/MCM-Architecture.md](computer:///E:/Programming/VSCode/MovieCollectionManager/docs/MCM-Architecture.md), [docs/runbooks/agent-layer.md](computer:///E:/Programming/VSCode/MovieCollectionManager/docs/runbooks/agent-layer.md)
- Plus: `.claude/settings.json`, `opencode.json`, project READMEs (mc-service, mcm-app, movie-assistant, MCP servers), `api-specs/`, the `specs/` and `docs/` trees, and `.forgejo/workflows/` (excluding node_modules, build outputs, `.git` internals, and all `.env`/credential files, which were not opened)
