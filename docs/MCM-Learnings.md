# MCM learnings: building a production-grade app with an AI coding assistant

*Last refreshed 2026-11-17 at commit `ce3a315c`. First public write-up: [LinkedIn, 2026-07-17](https://www.linkedin.com/posts/stevenjwatson_github-jumbleknotmoviecollectionmanager-activity-7483817416775426048-015T).*

This is the running account of what building MovieCollectionManager with an AI coding assistant has taught: the story so far, the lessons in the order they landed, and the measurements at each point they were taken.

**It is a narrative, not a source of truth.** It states no procedure of its own. Every rule it describes lives somewhere else (the constitution, a runbook, a knowledge page, an ADR), and this document links there. If this document and its source disagree, the source is right and this document has a bug. It is written for people; a coding assistant's instructions are in [AGENTS.md](../AGENTS.md).

| Part | What it holds | How it changes |
| --- | --- | --- |
| [1. The story so far](#part-1-the-story-so-far) | What MCM is, the layers that keep it consistent, how a feature flows, the harness | Rewritten in place when the story changes, like any current-state document |
| [2. Lessons ledger](#part-2-lessons-ledger) | Each lesson, the date it landed, its status and its canonical home | Append-only. A status may change; a lesson is never deleted |
| [3. Measurement log](#part-3-measurement-log) | Scripted counts at each refresh, and the feature timeline | Append-only. An old column is never edited |

[How to update this document](#how-to-update-this-document) is at the end.

---

## Part 1. The story so far

### 1.1 The experiment

MCM (MovieCollectionManager) is a working, multi-user movie-collection app in which Claude Code wrote every line of application code and every test. It began as a nights-and-weekends project to answer one question: **can AI-assisted development carry a real, production-grade project end to end, without the human writing any code, on technology stacks the human has never used?**

The answer so far is yes, with a condition. The human role moved to everything *around* the code: writing specifications, setting principles, reviewing, and building feedback loops. As the July post put it, the role moved from writing code to writing intent, and the better the intent, the better the code got. Part 1 of this document is about those loops.

The repository is public at [github.com/jumbleknot/MovieCollectionManager](https://github.com/jumbleknot/MovieCollectionManager), a push mirror of the self-hosted Forgejo original. Everything described here can be read first-hand.

### 1.2 What MCM is

MCM is a catalog for physical and digital movie collections, shared by multiple users, available on the web and Android from one codebase. Each user owns one or more collections, records media formats and metadata with IMDB/TMDB links, searches and filters their library, and keeps a wishlist.

An **AI assistant**, a small team of cooperating agents built with LangGraph, adds and organises movies, fetches metadata, and imports and exports spreadsheets in response to natural-language requests. Users can bring their own model (a local Ollama or Claude).

#### The pieces and how they talk to each other

```text
Expo/React Native client ──(HttpOnly session cookie)──▶ BFF (Node, Expo Router API routes, Redis sessions)
                                                          ├─▶ Keycloak (OAuth2 + PKCE, roles) ─▶ PostgreSQL
                                                          ├─▶ mc-service (Rust/Axum, "Clean Architecture") ─▶ MongoDB
                                                          └─▶ Agent gateway (Python, LangGraph, AG-UI protocol)
                                                                 └─▶ MCP tool servers: movie ─▶ mc-service · web-api ─▶ TMDB · spreadsheet ─▶ Redis scratch store
Observability & audit: Langfuse + ClickHouse + RustFS, Grafana (otel-lgtm bundle), OpenSearch (append-only audit log), OPA, Unleash
```

Two design ideas recur throughout:

- **BFF (Backend-for-Frontend).** The browser or app never sees an access token. It holds only an opaque cookie; a server-side layer (the BFF) owns the real tokens, refreshes them, and proxies every call. This removes a whole class of token-theft problems from the client.
- **MCP tool servers.** The AI agents do not call the database directly. They call small, scoped tool servers (Model Context Protocol), one each for movies, web APIs and spreadsheets. Each exposes only the operations that agent is allowed to perform.

#### Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React Native, React, Expo SDK, Expo Router, Tamagui design system, CopilotKit (chat UI) + AG-UI client, TypeScript |
| BFF | Expo Router API routes and Express in a Node container, Redis for sessions |
| Backend | Rust (pinned in `rust-toolchain.toml`), Axum web framework, Tokio async runtime, MongoDB. The constitution calls for `medi-rs` command/query separation; the code does not yet use it |
| AI agents | Python managed by `uv`, LangGraph, FastAPI + AG-UI, MCP SDK, Langfuse/OpenTelemetry tracing |
| Identity | Keycloak on PostgreSQL |
| Secrets | Komodo Variables in production (ADR-0001); HashiCorp Vault deployed but dormant |
| Observability and audit | Langfuse + ClickHouse + RustFS, Grafana (otel-lgtm bundle), OpenSearch, OPA (policy), Unleash (feature flags) |
| Monorepo | pnpm workspaces + Nx with plugins for Rust, Expo, Playwright and Python |
| Testing | Jest (unit), Playwright (web end-to-end), Maestro (Android end-to-end), `cargo test`, pytest + Hypothesis |
| CI/CD and security | Forgejo Actions (self-hosted), Renovate, Semgrep, OWASP ZAP, Trivy, cargo-audit / pnpm audit / pip-audit |
| Spec workflow | GitHub Spec Kit (the `specify` CLI), its commands installed as Claude Code skills |
| Dev environment | Dev Container on a Docker Sandbox micro-VM (default); Docker Desktop path kept only for the Android emulator |

Version numbers are deliberately left out. They move every week: between mid-October and mid-November alone the baseline went from Expo SDK 57 to 58, Node 24 to 26, MongoDB 8 to 9 and Rust 1.98 to 1.100. The current versions are in the manifests (`package.json`, `rust-toolchain.toml`, the `pyproject.toml` files, the compose files) and the stack baseline in the [constitution](../.specify/memory/constitution.md).

For the folder layout and how to run and build the app, see the [README](../README.md) and the [local development runbook](runbooks/local-dev.md). Everything goes through Nx, so the assistant, a developer and CI run identical commands.

### 1.3 The system that keeps it consistent: four layers over CI

MCM's answer to an assistant with no memory is not one big prompt. It is four layers, each holding a different kind of knowledge, each loaded at a different moment, and each backed by a check that fails when the layer is ignored or decays.

**The problem.** An AI coding assistant starts every session with no memory of the last one. It is fast, it is literal, and it will satisfy the instruction in front of it by the shortest route, including a route you did not intend: a test that passes because it mocks the thing under test, or a doc task ticked while a second document that names the same thing is left wrong.

| Layer | Holds | Loaded when | Decays how | What stops the decay |
| --- | --- | --- | --- | --- |
| **Constitution** (`.specify/memory/constitution.md`) | Principles that are always true | By every `/speckit-*` command | Rules nobody re-reads | Versioned amendments; a Constitution Check gate in every plan |
| **Spec Kit templates and skills** (`.specify/templates/`, `.claude/skills/speckit-*`) | The *shape* of each feature's spec, plan and task list | When a feature is specified, planned, broken into tasks | A tool upgrade silently overwrites local changes | `scripts/check-speckit-overrides.mjs` in CI |
| **Instruction file** (`AGENTS.md`, which Claude Code reaches through the `CLAUDE.md` shim) | A short list of "gates before you act" plus an index of where knowledge lives | Start of every session, automatically | It grows until it eats the context window | Governance gates that fail on prose beyond the index (G8) and on anything in the shim but the import (G15) |
| **Documentation** (`docs/` and the `openwiki/` knowledge pages) | The "how": runbooks, decisions, gotchas | Just in time, when the task touches the subject | Code changes and the doc is not updated | Fingerprint check (V17), the doc-impact sweep, a quarterly audit |

Underneath all four sits CI, the only layer that cannot be talked out of anything. The recurring lesson in this repository is that **guidance on a page does not keep anything honest; a gate does** (`openwiki/invariants/feature-validation-checklist.md`).

Sections 1.4 to 1.8 describe each layer with its rule *and* the mechanism that enforces it. Sections 1.9 and 1.10 describe CI itself: the harness.

### 1.4 Spec-Driven Development and the constitution

#### The workflow

Spec-Driven Development (SDD) means writing down *what* is wanted and *why* before deciding *how*, and deciding how before writing code. MCM uses GitHub Spec Kit to run this as a fixed sequence of stages, each producing one document that the next stage reads. The repository calls this the SDD lifecycle.

```text
Proposal            docs/proposals/**            free-form idea or PRD; not yet a commitment
   │  /speckit-specify   (creates the feature branch first)
   ▼
spec.md             WHAT and WHY: user stories, acceptance scenarios, requirements. No technology.
   │  /speckit-clarify   (optional: questions about gaps, answers written into the spec)
   │  /speckit-plan
   ▼
plan.md             HOW: stack, libraries, structure. Contains the Constitution Check gate.
   │  /speckit-tasks
   ▼
tasks.md            Ordered tasks grouped by user story. Tests first, in RED/GREEN format.
   │  /speckit-analyze   (optional: read-only consistency check of spec, plan and tasks)
   │  /speckit-implement
   ▼
Code + tests        Then the final validation checklist, then CI.
   │  /speckit-converge  (optional: compares code to spec/plan/tasks, appends tasks for what is unbuilt)
   ▼
tasks.md            A new "Phase N: Convergence" section, if anything is missing; back to /speckit-implement.
```

Three properties make this work with an AI coding assistant:

- **The spec/plan split is a hard separation, not a style preference.** The constitution requires `spec.md` to be technology-agnostic. That stops the assistant from choosing an implementation while it is still supposed to be understanding the requirement, and it gives a stable document to test against when the implementation changes.
- **A proposal is superseded the moment a numbered spec exists.** Proposals are deliberately excluded from the knowledge pages so retrieval is not filled with ideas that the spec later contradicted.
- **Deviations flow back up.** If implementation departs from the plan, the plan and tasks are updated. Departing from the *constitution* is the one case that is not self-service: it needs human approval and a recorded rationale.

**The three optional stages.** The first two are cheap checks placed just before an expensive step; the third is a check placed just after one:

- **`/speckit-clarify`** runs after the spec and before the plan. It scans the spec for underspecified areas (scope, data, user flows, non-functional needs, integrations), asks up to five targeted questions, and writes the answers back into `spec.md` under a Clarifications heading. It is worth running when the spec was written quickly or the feature is unfamiliar ground: an ambiguity resolved here costs one answer, and the same ambiguity found during implementation costs a re-plan. 39 of the 99 specs carry a Clarifications section.
- **`/speckit-analyze`** runs after the tasks and before implementation. It is strictly read-only: it cross-checks `spec.md`, `plan.md` and `tasks.md` for requirements with no task, tasks with no requirement, contradictions and terminology drift, and reports findings by severity. Any conflict with the constitution is automatically CRITICAL, and the fix must be to the spec, plan or tasks, never a reinterpretation of the principle. It leaves no file behind; its value is catching a gap while it is still a line in a document.

- **`/speckit-converge`** runs after implementation. It treats the spec, plan and tasks as the source of intent, with the constitution as governing constraints, and assesses the code against them. Each gap is classified as `missing`, `partial`, `contradicts` or `unrequested`, by severity, with constitution violations always CRITICAL. Its only write is append-only: a new `## Phase N: Convergence` section at the end of `tasks.md`, one task per gap, each traced to its source (`FR-003`, `US1/AC2`, a plan decision, a constitution principle). It never edits existing tasks or touches code; `/speckit-implement` then completes the appended tasks. If nothing is missing it reports "converged" and leaves `tasks.md` alone. It arrived with the Spec Kit upgrade. Out of the box it wrote each gap as a one-line checklist item outside the task format; a registered local edit (section 1.6, row 2c) makes an appended code gap a test and implementation pair in the checkpoint format. No `tasks.md` in the repository yet carries a Convergence phase.

**Why bother.** The spec is the thing a human can review cheaply. Reviewing 2,000 lines of generated Rust for intent is hard; reviewing five user stories with acceptance scenarios is not. The workflow moves human judgment to the point where it is cheapest and has the most leverage.

#### The constitution

`.specify/memory/constitution.md` is a roughly 1,000-line document that every Spec Kit command reads. It is **versioned like software**: ratified 2026-03-08 as v1.0.0, and amended about every ten days since (the measurement log has the version at each refresh). Each amendment has a changelog line saying what lesson prompted it: MAJOR for a changed principle, MINOR for added guidance, PATCH for clarification. Every pull request and code review must verify compliance with it.

Why bother? A chat prompt is forgotten at the end of the session, but a constitution is re-read at the start of the next one. It is how standards survive the AI's lack of memory.

Its principles, in plain terms:

- **AI Assistant Constraints.** Follow the constitution and the plan; ask when something is under-specified; name things by what they *do* (no `FR-123` or `T-45` ticket numbers in code identifiers); specs say *what and why*, plans say *how*; no "vibe coding": read the spec before touching anything.
- **Security.** Every internal endpoint requires a validated OAuth2/OIDC token; the client authenticates via the BFF cookie pattern; authorisation is deny-by-default; errors follow a standard shape (RFC 9457); no secret is ever committed.
- **Test-Driven Development (NON-NEGOTIABLE).** Tests first, verified failing, then implemented. Integration tests must use real databases and services, never mocks. Minimum 70% coverage for new features, in every layer. Section 1.5 covers this in full.
- **Logging and monitoring.** Structured JSON logs, correlation IDs, append-only audit trail with 90-day retention, never log secrets or personal data.
- **Common stack rules.** One package manager (pnpm; npm and yarn are blocked), one task runner (Nx), secrets in files that are never committed, and **RTK** (a tool that compresses command output before it reaches the AI, roughly 80–90% savings) active in every session.
- **Per-layer principles.** Backend: API-first (OpenAPI contracts before code), Docker-native, four-layer Clean Architecture, Rust safety. Frontend: a mandated design system (Tamagui), accessibility to WCAG 2.2 AA, a 2-second time-to-interactive budget with one documented exception. Agents: a strict protocol (AG-UI) between the UI and agents, per-agent tool allowlists, human-in-the-loop gates for writes, prompt-injection guardrails, idempotency keys.
- **Documentation.** The doc-impact sweep is mandatory (added in v2.10.0; section 1.7).

Exceptions are recorded as *bounded* exceptions with an enforcing mechanism, not as loosened rules. The web-bundle budget and the recorded LLM responses for the agent "golden" test tier (v2.4.0) are both examples.

### 1.5 Where TDD plugs into SDD

SDD and TDD are joined at one place, the task list, and the join is a chain of traceable links from an acceptance scenario to the command that proved its test fails and then passes.

**What TDD is.** Test-Driven Development means writing a test, watching it fail (RED), writing the code that makes it pass (GREEN), then tidying up. The failing step is the point: a test you have never seen fail has not been shown to test anything.

The chain:

1. **`spec.md`** gives each user story numbered acceptance scenarios (US1-AC1, US1-AC2, …).
2. **`tasks.md`** contains, for each story, test tasks placed *before* the implementation tasks. Each test task names the **scenarios covered** by ID and carries a **Verify RED** line: the exact command, and the failure expected from it.
3. The **paired implementation task** names the test task as a prerequisite ("T004 verified RED") and carries a **Verify GREEN** line: the same command, and the pass expected. It then re-runs the touched suite as a regression check.
4. The **final validation checklist** runs the full tiers before the feature is called done, and **CI** runs them again where nothing can be skipped quietly.

Feature 101's own task list shows the pattern: T004 writes tests for every failure code of a new gate script with "Expected RED: every test failing with `not implemented`", and T005 implements the gate with "Expected GREEN: 0 failures, 0 skipped". Of the 98 task lists in the repository, 84 contain the literal Verify RED field (86 counting lists that write only "Expected RED").

**Why the explicit commands matter for an AI coding assistant.** "Write tests first" is an instruction the assistant can believe it followed. "Run this command and expect 3 failures with this message" is a claim that is either true in the terminal output or not. The format turns a discipline into evidence.

#### What the repository learned about RED/GREEN the hard way

These are recorded as measured incidents in `openwiki/process/test-authoring-conventions.md` and `openwiki/process/spec-driven-development.md`. They are the part most worth copying, because each one cost a session to discover.

- **A Verify RED showing 0 failures means the test is wrong, not that you are done.** Fix the test before implementing.
- **When the behaviour already exists, use a mutation RED.** For test-only features (046 added authorization tests against already-correct code), a new assertion passes first time. The prescribed method: apply a named edit to the source, watch the test fail, revert. A compile error does not count as RED.
- **Watching a test fail proves it is sensitive, not that it is correct.** A unit test asserted that an option was *requested*; deleting the option made it fail, which felt like proof. But the option replaced a default instead of extending it, and tool calls stopped reaching the client while 1,179 unit tests stayed green. Three end-to-end specs caught it. The follow-up question to ask: *if this assertion held and the feature were still broken, what would that look like?* Prefer asserting an observable outcome over a configuration detail.
- **Suspect the test double.** A double that returned a fresh object on every render accidentally repaired the bug it was meant to expose, so the first RED was not red.
- **When a spec'd test fails, decide by one question: does the spec still describe intended behaviour?** Yes: fix the code. No: fix the spec. Choosing by "which is quicker to edit" is how a spec quietly stops describing the product.
- **A test's label must match what it exercises (Test Type Integrity).** Integration tests may not mock the dependency they integrate with. The constitution names the specific mocking libraries that are banned under `tests/integration/`, because an assistant under pressure to go green will otherwise mock the database. The one sanctioned exception (recorded LLM responses for the agent "golden" tier) needed a constitution amendment, v2.4.0.
- **A skip reads as a pass.** Environment flags (`MCM_REQUIRE_LIVE_STACK=1` and siblings) turn a skipped tier into a failure. One CI job skipped every agent spec for its whole life behind a green required check.
- **Check the instrument.** `node --test <file> --test-name-pattern "x"` silently runs everything, because flags after the script path go to the script. That would turn a Verify RED into "all green" while filtering nothing. This one is promoted to a session gate in `AGENTS.md`.

#### The test tiers

Different tests answer different questions at different costs. Fast tests run on every change; slow ones run less often but still before anything ships.

| Tier | What it exercises | Tools |
| --- | --- | --- |
| **Unit** | A function or component in isolation | Rust inline tests, Jest, pytest |
| **Integration** | Real MongoDB, Keycloak, Redis, no mocks | Jest, pytest, `cargo test`; a skipped integration test is treated as a *failure* in CI (feature 041) |
| **Golden** | The AI agents, replaying recorded LLM responses ("cassettes") so runs are deterministic and free | pytest `-m golden`; a *live-model* golden run gates every deploy |
| **End-to-end** | The whole system through a browser or a phone | Playwright (43 spec files, web) and Maestro (55 flows, Android), against the containerised BFF in CI |

**The agent gate split (feature 056): a lesson about testing AI.** Some agent tests assert things the *model decides*: which word it chose, which tool it ranked first. Two CI runs of identical code produced `failed=0 flaky=0` and then `failed=1 flaky=7`. No amount of retrying fixes a test whose outcome is probabilistic. The fix: every agent end-to-end test must be tagged `@gate` (deterministic, blocks a merge) or `@model-decision` (runs on `main`, publishes counts, never blocks). A static checker fails CI if any agent test carries neither tag, so an unclassified test is an error instead of a silent default.

**Tests of the harness itself.** `scripts/__tests__` holds 110 test files; 43 are "guard" tests that parse the workflow YAML and config files and assert invariants. A lockfile-only PR still runs the web and integration E2E; the Playwright container tag equals the `@playwright/test` version; the Renovate schedule actually intersects its cron. When your pipeline is 4,700 lines of YAML written by an AI, the pipeline needs tests too.

### 1.6 The Spec Kit overrides, and who enforces what

Out of the box, Spec Kit does not do what section 1.5 describes. Its core tasks template says tests are **optional**, and its documentation task is one generic line. MCM changes that, and the single inventory of every change is `docs/runbooks/spec-kit.md`.

The governing idea is **ownership**. Spec Kit owns every file listed in `.specify/integrations/*.manifest.json` (the skills, the scripts, the core templates), and an upgrade with `--force` rewrites them without warning. The project owns everything else under `.specify/`. So a customisation takes one of three forms, in order of preference:

1. A **project-owned file Spec Kit reads** (a template override, the constitution, a hook). Survives every upgrade.
2. A **registered local edit** to a Spec Kit-owned file, only when nothing else can carry the change. The upgrade overwrites it and a gate fails until it is restored.
3. **Never** an edit to a core template.

| # | Override | Where | Why it exists |
| --- | --- | --- | --- |
| 1 | **Doc-impact sweep** task in Phase 1 and **Close-out re-search** task in the final phase of every `tasks.md` | `.specify/templates/overrides/tasks-template.md` (a fork of the core template; Spec Kit checks `overrides/` first) | A study of 83 features found documentation tasks were done 94% of the time (269 of 285). The failure was *discovery*: features update the docs they think of, not the other docs that name what they changed. One agent README stayed wrong for five months. The sweep replaces "remember" with a literal `git grep` for every identifier the feature renames or removes. |
| 2 | **Tests are required, in the Verify RED / Verify GREEN format** | Same override; full format in `docs/templates/feature-test-tasks-template.md` | The core template makes tests optional. The constitution makes them non-negotiable. Without the override the generated task list contradicts the constitution on every feature. |
| 2a | The `/speckit-tasks` skill's own "Tests are OPTIONAL" sentence replaced with "Tests are REQUIRED" | `.claude/skills/speckit-tasks/SKILL.md` (registered local edit) | The assistant reads the skill *and* the template. Fixing only the template left two contradictory instructions in the same context. |
| 2b | The Copilot tasks agent builds from the override, with tests REQUIRED | `.github/agents/speckit.tasks.agent.md` (registered local edit) | Its stock version read the core template directly, so a task list generated through Copilot lacked the sweep and the RED/GREEN format. Closed 2026-11-16 (backlog #1031). |
| 2c | `/speckit-converge` writes an appended code gap as a test and implementation pair in the checkpoint format; a rename or removal adds a doc-impact sweep task | `.claude/skills/speckit-converge/SKILL.md` (registered local edit) | Its stock version appended one-line checklist items outside the task format. Closed 2026-11-16 (backlog #1054). |
| 3 | `/speckit-taskstoissues` files tasks in the self-hosted Forgejo backlog instead of GitHub Issues | `.claude/skills/speckit-taskstoissues/SKILL.md` (registered local edit) | The forge is Forgejo. This edit was once lost in an upgrade and "found only because someone looked", which is what motivated the guard. |
| 4 | The constitution | `.specify/memory/constitution.md` (project-owned) | Every Spec Kit command reads it. |
| 5 | Extension hooks: create the feature branch before `/speckit-specify`; commit hooks registered around every command; rewrite the "read the current plan" pointer in `AGENTS.md` | `.specify/extensions.yml` | The branch hook starts every feature on its own branch. The commit hooks are registered, but auto-commit is switched off in `.specify/extensions/git/git-config.yml`: the `spec(101): … plan(101): … tasks(101): …` trail in git is committed by the session, by convention, and it is what makes the order (spec before code) visible in history. The pointer keeps each session aimed at the active feature. |
| 6 | Version pins (dev container, `init-options.json`, setup runbook) | three files | Everyone, including CI, runs the same Spec Kit. |

**The guard.** `scripts/check-speckit-overrides.mjs` runs in the `guardrails` workflow on every PR. The override's first line records the hash of the core template it was forked from. The gate fails with a named code if:

- the core template has changed since the fork (`core-changed`, with the diff printed);
- the override lost the sweep (`sweep-missing`) or the RED/GREEN sample (`tdd-format-missing`);
- Spec Kit stopped looking in `overrides/` first (`resolution-broken`);
- a registered edit was reverted (`local-edit-reverted`);
- someone edited a Spec Kit-owned file without registering it (`unregistered-edit`).

It was used for real on 2026-11-15 in the 0.11.2 → 0.16.5 upgrade.

**The lesson to carry over:** a fork of a vendor file is a liability unless something tells you when upstream moved. Record the fork point, check it in CI, and never type the hash by hand (the script's `--record` writes it and refuses if the required content is missing).

#### Who enforces what

The same rule often appears in more than one layer. That is deliberate: the constitution states the principle, the template makes the compliant output the default, the instruction file catches the moment of temptation, and CI catches the result.

| Concern | Constitution (principle) | Spec Kit templates and skills (structure) | Instruction file (session gate) | Mechanical backstop |
| --- | --- | --- | --- | --- |
| A spec exists before code | "No Vibe Coding": refer to `spec.md` and `plan.md` before writing code | The SDD workflow itself; the branch hook | "SDD is not optional": no implementation code under `backend/`, `frontend/`, `agents/`, `mcp-servers/`, `infrastructure-as-code/` without a spec → plan → tasks set | None found. This is instruction plus PR review; the `spec(N)`, `plan(N)`, `tasks(N)` commit trail makes violations visible. |
| Spec says what, plan says how | "Technology Agnosticism in Specification" | Separate spec and plan templates | Link to the lifecycle page | Review |
| Plans comply with principles | Governance: every PR verifies compliance; deviations need approval | `plan-template.md` **Constitution Check** gate, re-checked after design; **Complexity Tracking** table for justified violations (77 plans carry the check); optional `/speckit-analyze` treats any constitution conflict as CRITICAL | No gate | Review |
| Tests first | "Test-Driven Development (NON-NEGOTIABLE)" and the "TDD Checkpoint Format" | Tasks override: tests required, Verify RED / Verify GREEN fields, ordering rules | "Check the instrument"; "a tool's no is about the tool" | Guard keeps the format in the template; CI runs every tier. The constitution's 70% coverage minimum is not a CI gate: the only configured threshold (lines 70, in the mcm-app package.json) applies to a coverage script that no workflow runs |
| Tests are what they claim to be | "Test Type Integrity": no mocks in integration tests; one sanctioned exception | No template rule | Skip counts; the agent test tier split | Skip-as-failure flags; a checker that fails unclassified agent tests |
| Docs updated with the change | "Documentation": the doc-impact sweep is mandatory (v2.10.0) | Tasks override carries the sweep and the close-out re-search | "Refresh the wiki page in the same PR as its source" | V17 fingerprint check; quarterly audit |
| Naming, security, stack, task runner, package manager | Dedicated sections (identifiers describe behaviour; BFF cookie auth; Nx for every task; pnpm only; RTK) | Constitution Check in each plan | Short gates for the traps (worktrees, PR branches, API key) | Naming gate, secret scans, `only-allow pnpm`, toolchain-consistency gate |
| The instruction file stays small | No principle | Hook maintains only its own marked region | "Never write a learning into this file" | Governance gates G8 (prose beyond the index fails), G9 (index links resolve), G15 (`CLAUDE.md` stays a shim) |

A useful way to remember the split:

- **Constitution = what must always be true.** Slow-changing and versioned.
- **Templates = what the next artifact looks like.** They make compliance the path of least resistance. The assistant fills in a form that already has a Verify RED field; it does not have to remember to add one.
- **Instruction file = what you must not get wrong in the next ten minutes.** Thirteen gates, each one sentence of rule, one measured incident as the reason, and a link to the full procedure.

### 1.7 The instruction file and documentation: the knowledge layer

#### The instruction file: an index with gates, not a manual

Every coding assistant loads one instruction file at the start of every session. That makes it the most valuable and the most expensive real estate in the repository: every line is paid for in context on every request.

The file has had three lives, and the changes between them are lessons in themselves (Part 2, lesson 4):

1. **A manual (to mid-2026).** `CLAUDE.md` held the "how" and the learnings: commands, gotchas, hard-won lessons. "Prune it regularly" failed. It grew to 592 lines and 72 KB.
2. **An index with gates (from feature 044).** `CLAUDE.md` shrank to about 150 lines: gates, an index of knowledge pages, and a routing rule for new learnings ending in "never into this file". Growth became a CI failure.
3. **One file for every assistant (2026-11-16).** The gates and the index moved to `AGENTS.md`, which Codex and OpenCode read directly. `CLAUDE.md` became a shim holding only an `@AGENTS.md` import, so Claude Code reaches the same file and every assistant loads the instructions exactly once. Before this, assistants other than Claude Code never saw the gates.

`AGENTS.md` has three parts:

1. **"Gates that run before you act."** Rules whose violation is silent or expensive: SDD before implementation; commit from a git worktree because several sessions share the checkout; a PR head must be a real branch; a skipped test is not a pass; a guard that fails because you changed what it protects is updated at the cause, never deleted. Each gate states the cost that taught it ("~$15 of unintended spend in one day", "cost two sessions a day") and links out.
2. **A knowledge index.** One line per knowledge page: title, link, one-sentence description. Pages marked **[canonical]** are the home of their subject.
3. **"Where a new learning goes."** A mechanical routing rule, ending with "never into this file", and never into the `CLAUDE.md` shim either.

Plus machine-managed regions, each rewritten by its own tool and exempt from the prose gate: Nx's guidance, Spec Kit's pointer to the current plan, and the OpenWiki region.

Three governance rules keep it that way: G8 fails on prose beyond the index, G9 fails on an index entry that points nowhere, and G15 fails if `CLAUDE.md` holds anything but the import or loses it.

**Why this shape.** What worked was making growth a CI failure and giving every learning a named home elsewhere. The reason attached to each gate matters too. A bare rule gets rationalised away; a rule with a dated incident does not.

- **Canonical documents** under `docs/`: 20-odd runbooks, four architecture decision records (ADRs), the architecture document, plus per-project READMEs. These are the truth about procedure.
- **Knowledge pages** under `openwiki/` (86 files): short pages for the assistant to read *just in time*. Each is a distilled summary, the load-bearing gotchas, and a link to the authoritative source. The brief (`openwiki/INSTRUCTIONS.md`) is explicit that a page which merely copies its source has failed.
- **Records** (`specs/`, `docs/proposals/`, ADR history, dated incident tables): what was decided *at the time*. Never edited to match the present, and never treated as current state.

#### What the OpenWiki format gives you

OpenWiki is a tool that generates a wiki for AI agents. The pages it writes follow the Open Knowledge Format (OKF): markdown with YAML front matter (`type`, `title`, `description`, `tags`, `resource`, `timestamp`) and an `index.md` per directory. MCM adopted it in feature 043. The format is what turned out to matter:

- **Typed, described pages can be selected instead of grepped.** An assistant picks pages by `type` (Runbook, Gotcha, Invariant, Process, Decision) and reads a one-line description before spending context on the body.
- **The `resource` field classifies every page.** A page with a `resource` is a **derived summary** of that one file (53 pages). A page without one is **authoritative**, the canonical home of its subject, and must be listed in `openwiki/protected.yaml` (24 pages). A gate requires every page to be exactly one of the two.
- **That classification makes "where does this learning go?" decidable.** Derived page: write the learning into the cited source and refresh the summary in the same PR. Authoritative page: write it into the page. No page: add one. Without this rule, learnings went wherever was nearest, which was CLAUDE.md.
- **Complete coverage makes absence meaningful.** Every runbook, ADR and architecture document has at least one page. So "no page" means "no such document", not "not covered yet".
- **Protected passages.** `protected.yaml` fingerprints the load-bearing passages in authoritative pages, so a later rewrite that drops one fails a gate as a removal.
- **The format is lintable.** `check-openwiki-okf.mjs` validates front matter, links and fingerprints. `check-openwiki-governance.mjs` validates write policy (`policy.yaml`: which paths may be written, and by which actor), passage protection and the instruction-file index. Both are offline, keyless, fail-closed, and have no allowlist.
- **Corrections are rewritten in place.** No appended "SUPERSEDED" blocks; git holds the history. A reader (or a model) meets stale text first and acts on it.

#### Why the bot went and the format stayed

The original design (features 043, 044, 078, 082) had the OpenWiki generator, a paid model run in CI, regenerate pages after merges to `main`. It opened one long-lived PR for a human to merge, tracked per-claim `repo://` citations in sidecar files, and re-planned the most stale pages on each run.

ADR-0004 (`docs/decisions/ADR-0004-session-maintained-wiki.md`) records nine successive steps of tuning between July and November 2026, among them maintenance on merge, a cheaper model provider, longer deadlines, retry at lower reasoning effort, drift re-planning, a page cap, and a daily schedule with cooldowns. The measurements that ended it:

- **$167.80 over 106 runs in 30 days**, with 265 page attempts for 39 distinct pages.
- The generator forced pages into every run that nobody asked for: in run 5104 (2026-11-09), 30 forced pages starved the 4 requested ones, and the run landed one page for about $1.44.
- Around 20 pages a week had their source change, so even a perfectly behaved generator had a cost floor.

The decision on 2026-11-10 (feature 098): **the coding session that changes a source refreshes its summary, in the same PR.**

- Each derived page records `resource-sha256`, the hash of its one source file.
- Rule **V17** in the required `okf` check fails a PR whose page no longer matches its source.
- `node scripts/wiki-refresh.mjs` does the bookkeeping: `--stale` lists pages, `--diff` shows what changed in the source since the last record, `--record` writes the new hash. It is offline and free. A `wiki-refresh` skill teaches the procedure.
- The generator survives only as a manual rebuild of operator-named pages.

Why this is better, not just cheaper: the session that edited the runbook has already read it and knows what changed, where a later generator has to rediscover that from nothing. The refresh runs on the subscription, not the API. And the check fires on the PR that caused the staleness, so drift cannot accumulate on `main`. The accepted risk is a session recording a hash without reading the diff, which shows up in review as a fingerprint-only change.

What was deleted: the generator's per-claim evidence files (4.5 MB of sidecars), the schedule, and the scripts for escalation, cooldowns and drift re-planning. A side effect worth noting: a derived page may now cite only a single file that no bot rewrites, because a Renovate PR has no session present to refresh a page.

#### Closing the other half of the loop: doc drift

V17 keeps the summary in step with the document. Nothing mechanical keeps the document in step with the code. Feature 101 (merged 2026-11-15) addresses that in layers (`docs/runbooks/doc-drift.md`):

1. **The doc-impact sweep** in every task list (section 1.6), re-run for the old identifiers at close-out.
2. A per-PR mechanical check: designed, deliberately **not built** until the audit shows layer 1 is insufficient.
3. **A quarterly drift audit**: one session reads the procedure docs against the tree, fixes only what it can prove wrong, logs the rate, and files its own successor as a backlog item. The baseline on 2026-11-14 was 76 proven errors in about 16,800 lines (4.5 per 1,000). The number is the measure of whether the sweep works.

### 1.8 One feature, end to end

Feature 101 (doc-drift prevention) shows how the layers meet in practice.

1. **Proposal.** `docs/proposals/PRD-DocDriftPrevention.md` states the problem with measurements.
2. **Specify.** `/speckit-specify` creates branch `101-doc-drift-prevention` (hook), writes `spec.md`; the session commits it as `spec(101): …`.
3. **Clarify (optional).** `/speckit-clarify` asks up to five questions about gaps in the spec and writes the answers into `spec.md` before any design work depends on them. Feature 101 did not need it, because its proposal had already settled the open questions with measurements.
4. **Plan.** `/speckit-plan` writes `plan.md` with a Constitution Check table: each relevant principle marked pass, strengthened, or noted. Research, data model, contracts and quickstart are produced alongside.
5. **Tasks.** `/speckit-tasks` writes `tasks.md` from the override: T001 is the doc-impact sweep with its search terms and one line per hit; test tasks precede implementation tasks with Verify RED / Verify GREEN.
6. **Analyze (optional).** `/speckit-analyze` reads `spec.md`, `plan.md` and `tasks.md` together and reports requirements with no task, tasks with no requirement, contradictions, and any conflict with the constitution. It edits nothing; findings are fixed in the three documents before implementation starts.
7. **Implement.** `/speckit-implement`, in a git worktree (a session gate; section 1.10). Each test is observed failing, then passing. Optionally, /speckit-converge then checks the code against the three documents and appends a Convergence phase for anything unbuilt; feature 101 did not run it, and no feature has yet.
8. **Documents.** The constitution is amended (v2.9.0 → v2.10.0), a runbook is added, the affected wiki pages are refreshed with `wiki-refresh` in the same PR.
9. **Close-out.** The final validation checklist, including the re-search for old identifiers.
10. **CI.** Guardrails (secret scan, naming, Spec Kit override gate, OKF and governance gates, SAST), then the test tiers. A human merges.

### 1.9 The harness: CI/CD and security scanning

"Harness" means every automated mechanism that catches a mistake before it reaches users and, just as importantly, before the *next* AI session builds on top of it. Each part below explains what a tool is, why you would want it, and how MCM uses it. Counts quoted here are as of the last refresh; Part 3 has the dated figures.

#### CI/CD on self-hosted Forgejo Actions

**What it is.** Continuous Integration (CI) runs checks automatically on every change; Continuous Deployment (CD) ships the result. Forgejo is a self-hostable Git forge (think GitHub, but running on your own server) whose "Actions" are compatible with GitHub Actions workflow files. MCM moved to it in feature 023 to keep the full pipeline, including Android emulator jobs and production deploys, on home-lab hardware.

**Why it matters here.** The AI cannot be trusted to run the full test suite locally every time: it costs tokens and it may skip things. CI is the impartial judge. Every pull request runs the same gates, and nothing merges without them.

**How MCM does it.** Eleven workflows and 25 jobs, on two kinds of runner: ordinary Linux containers, and a single **`kvm` runner**, a machine with hardware virtualisation, for anything that needs Docker or the Android emulator.

| Workflow | When it runs (cron times UTC) | What it does |
| --- | --- | --- |
| `app-ci.yml` | every push to `main`, every PR | Works out which projects changed; runs lint, type-check, unit tests and the web-bundle size budget; compiles Rust with warnings as errors. Then **`app-e2e`** stands up Keycloak, Redis, MongoDB, the Rust service, object storage, the agent gateway and MCP servers, and runs integration suites and Playwright web tests. When mobile paths change or the `mobile-e2e` label is set, it builds an Android APK and drives it with Maestro on an emulator. Finally decides whether a deploy is warranted. |
| `guardrails.yml` | every push to `main`, every PR | The "gate farm": secret scan, naming conventions, wiki structure checks, Spec Kit override gate, agent test-tier classification, SAST + dependency audit, Renovate config validation. Independent jobs, each scoped to one concern. |
| `cd-deploy.yml` | dispatched by app-ci after a push to `main`; also manually | Live-model agent test → build images → Trivy scan → promote digests → signed Komodo webhook → health probe → **auto-rollback** on failure. |
| `wiki-maintain.yml` | manual dispatch only; until 2026-11-10 it also ran after merges to `main` | Rebuilds operator-named wiki pages with the generator. Routine refresh moved to the coding session (section 1.7). |
| `renovate.yml` | nightly 03:00 (security only); Fri 07:00 (everything) | Runs the dependency bot (section 1.10). |
| `infra-image-scan.yml` | Tue and Fri 04:00, plus pushes/PRs touching infrastructure | Twice-weekly CVE sweep of every third-party container image. |
| `devcontainer-image.yml` | Fri 06:00, plus pushes touching the dev-container Dockerfiles | Rebuilds the dev-container image to pick up base-image patches. |
| `lockfile-refresh-check.yml` | Fri 10:00 | Checks that a lockfile-refresh PR actually appeared. |
| `renovate-health.yml` | Fri 11:00 | Checks the bot is alive and effective. |
| `branch-reaper.yml` | daily 02:30 | Deletes remote branches already merged into main that nothing is using. A surviving Renovate branch is reused verbatim, which once opened four empty lockfile PRs. |
| `registry-retention.yml` | Sun 06:00 | Weekly report of what the package-registry retention policy keeps and deletes. The schedule never deletes; that takes an explicit dispatch and a config switch. |

Four design choices worth stealing:

- **Every step is wrapped and timed.** Each `run:` step goes through `scripts/ci-log-step.sh`, which captures the log and enforces a per-step time ceiling generated from the slowest of the last 40 runs (×3, floored at 5 minutes). A hung step fails in minutes, with a message saying which step and why.
- **Every job ends with a failure digest.** Forgejo's API has no "give me the logs" endpoint, so each job posts a redacted summary of what failed as a PR comment or commit status. The AI can read that comment. A separate gate (`check-ci-digest-coverage.mjs`) fails the build if any job forgets the digest step: *a gate that guards the gates*.
- **Self-serve diagnostics.** `ci-status.mjs` lets an AI agent query the state of CI from the command line, so a human never has to copy-paste logs into a chat.
- **Friday choreography (UTC).** 04:00 CVE sweep → 06:00 dev-container rebuild → 07:00 Renovate window → 10:00 lockfile check → 11:00 health digest. The order is deliberate (the sweep must finish before the bot opens PRs) and tests assert it holds under both daylight-saving offsets.

**Pinning.** Every third-party action is pinned to a commit SHA, not a tag, and a gate checks that every Node, pnpm, Nx and Playwright version pin across all workflows and Dockerfiles agrees. "Pinning" means naming an exact, immutable version instead of a label that can move. A workflow that says `actions/checkout@v4` gets whatever the `v4` tag points at *today*, which the publisher (or an attacker who compromises the publisher) can change tomorrow. `actions/checkout@<40-character commit SHA>` gets the same code forever. The same idea applies to container images (`postgres:18@sha256:…`) and toolchains (`rust-toolchain.toml`). Pinning trades convenience for reproducibility and supply-chain safety, and it is why a dependency bot is needed: pinned things never update themselves.

#### SAST and dependency auditing (Semgrep, cargo-audit, pnpm audit, pip-audit)

**What it is.** *Static Application Security Testing* reads your source code looking for dangerous patterns: a secret logged, a SQL string built by concatenation, authorisation checked after the action instead of before. It never runs the program. *Software Composition Analysis* (dependency auditing) checks the libraries you depend on against public vulnerability databases.

**Why it matters here.** The AI writes a lot of code quickly, and it does not know your organisation's specific rules. SAST lets you encode those rules once and check every line forever.

**How MCM does it.**

- **Semgrep** (pinned to an exact version) runs five community rule packs (TypeScript, React, Node, Python and the OWASP Top Ten) plus **five custom rules** written for this project, each with test fixtures: no `console` logging in the BFF, no token logging, auth must precede authz, no tracing of JWT payloads, and no `curl | sh` in CI scripts.
- **Dependency audits** run in the same job: `cargo audit` for Rust, `pnpm audit` for JavaScript, and `pip-audit` for the Python agent and each of the three MCP servers.
- The orchestrator (`scripts/sast-scan.mjs`) **fails closed**: if Semgrep is missing or the advisory database is unreachable, the job fails. If a rule could not run, the gate lists it under "rules that could not run" so a blind spot is visible.
- The gate (`check-sast-findings.mjs`) **blocks on any un-allowlisted High or Critical** finding in application code or runtime dependencies; dev-only dependency findings and Medium/Low issues are warnings.
- **The allowlist is the only baseline.** There is no stored "known issues" snapshot. Every entry records the scanner, the finding ID, where it applies, a written justification, who added it, and, where a fix is expected upstream, an **expiry date**. Suppression happens at the gate; findings stay visible in the report.
- The job runs with no credentials and no path filter, so a newly published advisory about a dependency nobody touched still blocks the next PR.

#### DAST (OWASP ZAP)

**What it is.** *Dynamic Application Security Testing* attacks a *running* application from the outside, the way an attacker would: crawling pages, probing endpoints, injecting payloads, and checking response headers. ZAP (Zed Attack Proxy) is the standard open-source tool.

**Why it matters here.** SAST sees code; DAST sees behaviour. The very first DAST run found missing security headers that no code review had noticed. That became feature 032.

**How MCM does it.**

- ZAP runs as a container attached to the same private Docker network as the app. Nothing is exposed to the host or the internet.
- Two plans: `zap-baseline.yaml` (crawl + passive checks, the default locally) and `zap-full.yaml` (active attacks).
- **Authenticated scanning.** An unauthenticated scan only sees the login page. A small script performs the full OAuth Authorization-Code + PKCE login over HTTP, with no browser, and hands ZAP the three session cookies, so ZAP scans as a real test user. The Rust service is scanned with a bearer token; the agent gateway is scanned passively only; Keycloak is out of scope.
- **Safety interlock.** Active (attacking) mode refuses to run unless an explicit environment flag is set *and* the target is in a list of disposable environments. You cannot accidentally attack production.
- In CI the job resets state, mints fresh per-stack secrets, brings up the stack, runs a full scan, then runs a **leak scan** on ZAP's own reports (grepping for the test password, the test client secret, the Anthropic API key and any JWT), and finally **blocks on any un-allowlisted High** finding. The allowlist has one entry, a timestamp-disclosure false positive in the Expo bundle.

#### Container-image CVE scanning (Trivy)

**What it is.** Your application runs on top of other people's software (PostgreSQL, Keycloak, OpenSearch, Redis) delivered as container images. Those images contain operating-system packages and libraries with their own vulnerabilities (CVEs). Trivy scans an image and lists them, with severity and whether a fix exists.

**Why it matters here.** The AI never touches those images, so no code review will ever catch a vulnerable base image. Only a scheduled scan will.

**How MCM does it.**

- `infra-image-scan.mjs` enumerates every third-party image referenced in the infrastructure folder (the project's own images are scanned at deploy time), scans each with a pinned Trivy, and normalises severities.
- **Blocking = fixable Critical.** A Critical CVE with no upstream fix is a warning, not a failure: you cannot act on it.
- **Allowlist entries can be keyed to image version + digest** (feature 063), so upgrading the image automatically *discharges* the entry. There is no way to forget to remove it. Four of the six entries are keyed this way and carry an expiry date; the other two match a tag only.
- One shared module (`allowlist-expiry.mjs`) handles expiry for both the SAST and image allowlists: an expired entry stops suppressing on every run, and a 14-day early warning runs on the scheduled sweep.
- Scheduled runs normally leave no trace on the repository, so a small script publishes a **commit status** on `main` after each sweep, which the Renovate health job reads.
- **ADR-0002** decided how to handle two CVEs that could only be fixed by *major* upgrades of stateful services (OpenSearch 2→3, then Langfuse 3→4). Each became its own feature. The claim "the new major removes the vulnerable library" was to be proven in CI with Trivy *before* any configuration changed. The OpenSearch audit store was preserved via snapshot/restore, while Langfuse's data was deliberately recreated. The allowlist entry was meant to be **deleted, not re-dated**, once the upgrade landed. In practice OpenSearch 3 did not clear its CVE, so that entry was re-keyed to the 3.x digest and kept.

### 1.10 The harness: Renovate, the other gates, and parallel sessions

#### Renovate: the dependency bot, explained from scratch

**The problem it solves.** A modern application has hundreds of dependencies: npm packages, Rust crates, Python libraries, Docker images, CI actions, the Node and Rust toolchains themselves. Each publishes new versions constantly, some of them security fixes. Keeping up by hand is tedious and error-prone, so most teams fall quietly behind until an upgrade becomes a multi-week project. In an AI-built repo the problem is worse: nobody is reading release notes.

**What Renovate is.** A bot that scans your repository for every declared dependency, checks each against its registry, and opens a pull request for each available update, with the changelog, the diff, and your CI results attached. You review and merge. It can also refresh lockfiles, pin Docker images to immutable digests, group related updates into one PR, and hold back updates you are not ready for. It is open source and runs on GitHub, GitLab, Gitea/Forgejo and others.

**Why run it yourself.** The hosted Renovate app only works with GitHub. MCM's forge is self-hosted Forgejo, so the bot runs as a CI workflow (`renovate.yml`) with a bot account token.

**The configuration (`renovate.json`).** It is 120 KB, which sounds absurd until you open it: most of the bytes are `description` fields recording *measured incidents*: what broke, when, and why the rule exists. It is a changelog disguised as a config. The substantive parts:

- **Presets:** `config:recommended` (sane defaults), `docker:pinDigests` (replace floating image tags with immutable `@sha256` digests), `:dependencyDashboard`, `:semanticCommits`.
- **The Dependency Dashboard.** Renovate maintains one issue in the repository and rewrites its body on every run. It is the bot's control panel and status page in one. It lists every update it knows about, grouped by why it has *not* been opened as a PR yet: *Pending Approval*, *Awaiting Schedule*, *Rate-Limited*, *Pending Status Checks*. It also lists open PRs and a "repository problems" section. Each line has a checkbox; ticking it is the one sanctioned way to override the bot. The issue is never edited by hand, and the health job reads its "repository problems" section every week.
- **Schedule:** a single Friday-morning window (`* 2-4 * * 5`, New York time), with limits of 7 open PRs and 6 new PRs per hour. Security updates are *exempt* from the schedule and arrive from a nightly 03:00 UTC run.
- **Cooling-off:** `minimumReleaseAge: 3 days` globally (1 day for security fixes). The bot ignores a release until it has been public long enough for obvious breakage to surface.
- **Lockfile maintenance:** on. Your `package.json` (or `Cargo.toml`, or `pyproject.toml`) declares what you want in *ranges*: "axios, any 1.x". A **lockfile** (`pnpm-lock.yaml`, `Cargo.lock`, `uv.lock`) records what you actually *got* the last time you installed, including the exact version of every library axios itself pulled in. Every later install reproduces the lockfile exactly; that is the point of it. The catch: when a library deep in that tree publishes a security fix that your ranges already allow, nothing happens, because the lockfile still says the old version. Renovate's lockfile-maintenance PR regenerates the lockfile so everything moves to the newest version the ranges permit. Feature 058 discovered the bot had been proposing nothing for exactly this reason.
- **44 package rules** organised into **21 named groups** so related updates land as one PR each: Docker base images (highest priority), digest pins, CI actions, Rust crates, Python packages, JavaScript patch/minor, JavaScript majors ("review individually"), the Nx monorepo tools, Playwright, Tamagui (pinned exactly), CopilotKit, Langfuse, the pnpm/uv/Rust toolchain pins, and several explicitly **held** majors (Babel, TypeScript, async-storage).
- **Hard holds.** Expo, React Native and React are *disabled* for the bot entirely: an Expo SDK upgrade touches everything and is done as a numbered feature (005, 081) using Expo's own upgrade tooling. The JDK is held at 17; the Python image below 3.15; Babel and async-storage majors are held because the Expo SDK's presets pin them, and TypeScript because typescript-eslint's peer range does. **A hold is never just a version ceiling.** Every held rule carries a written justification in the config itself: the measurement that motivated it, a backlog item, and a *re-check rule* saying what to look at to decide when the hold can be lifted. A hold without that record would be indistinguishable from a forgotten one.
- **Dashboard approval** is required for major versions of stateful services (Postgres, MongoDB, Redis, ClickHouse, OpenSearch, Langfuse, Vault) and for the CopilotKit and Cargo 0.x-breaking groups. In MCM that tick is not a casual click. It happens when a numbered feature has been written for the upgrade (ADR-0002's process), and the runbook requires naming which stack the image runs in and how that stack is tested before approving, because the end-to-end suite does not start the observability stack, so a green CI run says nothing about a database migration.
- **`automerge: false` everywhere.** The bot proposes, CI judges, a human merges.
- **9 custom "regex managers."** Renovate natively understands `package.json`, `Cargo.toml`, Dockerfiles and so on, but not a version number buried in a shell script or a YAML workflow. A regex manager teaches it: *this string in this file is the Trivy version; track it against Trivy's GitHub releases.* MCM uses them to keep pins in lockstep that would otherwise drift: the Nx version in `nx.json` and the npm `nx` package; the Playwright container tag in CI and the `@playwright/test` package; Trivy in three workflows; the Maestro CLI; the Rust version in the dev-container toolchain Dockerfile; `SEMGREP_PIN` in the SAST script; `cargo-audit`; `uv` across four workflows and a Dockerfile; the wiki generator.

**How a run executes.** One job: set up Node, install pnpm at the exact `packageManager` version with `scripts/install-pnpm.sh` (Node no longer bundles corepack), install rustup and `uv` so Cargo and Python lockfiles can regenerate, validate the config with `renovate-config-validator --strict`, then run a pinned Renovate pointed at the Forgejo API with the bot token. The Node step has history: the job once failed nightly with `Unsupported node environment`, a red that people had stopped reading. One setting, `RENOVATE_DOCKER_MAX_PAGES=10`, exists because Docker Hub returns 403 past page 10 of a tag listing, which otherwise marked every image update "pending" forever. Manual runs default to **dry-run** and post a commit status saying so.

**Three channels, three cadences.**

1. **Security**: vulnerability alerts backed by the OSV database; exempt from the schedule; land from the nightly run, labelled `security`.
2. **Lockfile refresh**: Friday window, top priority, one PR each for pnpm, Cargo and uv.
3. **Routine**: Friday window, budgeted. With one run per week, the "6 PRs per hour" limit *is* the weekly throughput, so priorities decide which six appear: lockfiles first, then Docker base images, then digest pins.

**How it interacts with CI.** A Renovate PR is an ordinary PR: the full guardrails and app-ci (and image scan) run on it. A guard test ensures a lockfile-only PR cannot skip the end-to-end suite. Another gate blocks a half-updated security override, where a minimum version is declared in two places and only one moved.

**The health loop: the part most teams skip.** A bot that silently stops working is worse than no bot: you believe you are covered. Feature 057 found that MCM's bot had been broken in four independent ways, none of which anyone was acting on: running on the wrong Node version; a schedule window that never intersected its cron trigger; override "floors" the bot could not bump; and allowlist entries that expired with no warning. 057 fixed those; the health loop makes the next such failure visible:

- `renovate-health.mjs` runs every Friday at 11:00 UTC, reads the Dependency Dashboard's "repository problems" section, classifies every `renovate/*` branch (empty PR / stale / active), reads the weekly CVE-sweep verdict, and **always** comments on a tracking issue, one line when healthy. *Silence means the job died.*
- `check-lockfile-refresh.mjs` runs at 10:00 UTC, derives the window from `renovate.json`, and verifies a lockfile-maintenance PR appeared *inside* it without anyone nudging the dashboard.
- `renovate-workflow.guard.test.mjs` holds **about 150 tests**: the cron intersects the window under both daylight-saving offsets, the Node pin matches the guardrails job, `dockerMaxPages ≤ 10`, the CVE sweep is ordered before the window, groups are ordered correctly, held majors are still held.

**The lineage.** 057 restored the security loop and added a 14-day expiry warning. 058 turned on lockfile maintenance and closed the "lockfile PRs skip E2E" gap. 063 pinned infrastructure images by version + digest so CVE allowlist entries discharge themselves. 081 is a programme of ten upgrade stages, most of them held majors, in a safe order (CI actions → pnpm → Nx → Expo 57 → Tamagui → Jest/Babel/TypeScript → Express → CopilotKit → datastore images → backend libraries).

#### Secret scanning and the other gates

Secrets leak in three different ways, and each needs a different detector.

- `secret-scan.mjs` looks for the *shape* of credentials in tracked files (Anthropic API keys, TMDB keys, the project's own dev-credential placeholders) and insists the recorded LLM cassettes carry no auth headers. Its self-test plants a synthetic key and confirms it is caught.
- `check-no-inline-secrets.mjs` enforces that every secret-shaped key in a Compose file is a `${VAR}` (or `${VAR:?message}`) reference. A `${VAR:-default}` fails: a default value *is* an inline secret.
- `check-no-argv-secrets.mjs` forbids passing secrets on the Maestro command line, where they would appear in `ps` output and CI logs; they must travel via environment variables.

The remaining gates each check one invariant: resource naming conventions; every production service has `restart: always`; prod and CI do not share host ports; the dev and CI Keycloak realms agree; client code never imports BFF server code; no private tailnet hostnames anywhere in the tree; the wiki's structure and governance; the Spec Kit overrides; the web bundle size budget.

**Most gates have a `--selftest` mode that CI runs before the real scan**, so a gate that has silently stopped detecting anything fails loudly. Four of the 22 check scripts have none: resource naming, lockfile refresh, dependency downgrade and pnpm version.

#### Running several coding-agent sessions at once: git worktrees

**The problem.** Once the dev container existed, it became natural to open more than one Claude Code session against it: one implementing a feature, another investigating a CI failure, a third drafting a spec. On 2026-09-18 five sessions were running at the same time, all with `/workspaces/mcm` as their working directory. They share the filesystem, the Docker daemon and the pnpm store, which is fine. They also share **the git index and the checked-out branch**, which is not. A `git checkout -b`, `git add -A`, `git stash` or `git rebase` in that directory changes what every other session is looking at, mid-edit. The failure is silent and lands on the *other* agent: it sees files it did not write, a branch it did not create, or a commit that swept up its half-finished work.

**What a worktree is.** Git normally gives you one working directory per clone. `git worktree add` attaches a *second* working directory to the same repository (same history, same remotes, same object store) checked out on its own branch, with its own index. Two worktrees can stage and commit independently and never see each other's uncommitted changes. It is the lightweight alternative to cloning the repo twice.

**The rule MCM adopted.** It is a standing gate in `AGENTS.md`: *never commit or switch branches in `/workspaces/mcm` when another session may be active, and assume one is.* Every session that will change anything starts with:

```bash
git fetch -q origin main
git worktree add -b <branch> /home/coder/worktrees/<slug> origin/main
ln -sfn /workspaces/mcm/node_modules /home/coder/worktrees/<slug>/node_modules
```

and ends, once the branch has merged, with `git worktree remove … && git worktree prune`. Reads (`git fetch`, `git log`, `ci-status`, anything against the forge API such as opening or merging a PR) are safe from the shared checkout; only operations that move `HEAD` or touch the index need a worktree.

**What it cost to learn.** The runbook (`docs/runbooks/devcontainer.md`) records each trap as a measured incident, because each one consumed a session before it was understood:

- The worktree must live under `/home/coder/…`, not `/workspaces/.worktrees/…`. `/workspaces` itself is not writable, and the error is a bare `Permission denied` that reads like a git problem.
- The `node_modules` symlink is enough for `node --test` and the gate scripts, but **every `pnpm nx` target refuses to run** in a worktree that only has a symlink (`ERR_PNPM_UNSAFE_MODULES_DIR`). Two plausible workarounds were tried and documented as failures. The only fix is a real `pnpm install` inside the worktree (~4 minutes), and the runbook says to *decide from the diff* whether the change is reachable only through an Nx target before spending those minutes.
- That symlink was once committed by accident, because `.gitignore` said `node_modules/` and a trailing slash matches only a directory. CI received a symlink where it needed a directory and six required jobs died at once. The ignore pattern lost its slash, and the advice became: check `git status --porcelain`, not `git diff`, before committing from a worktree.
- A fresh worktree lacks gitignored artefacts that some gates *read* instead of generating, so a gate can throw in a way that reads as a code failure when the real cause is a missing input.
- Nx can hand back a *stale* failure: a cached result naming a path that no longer exists. If a failure's message does not match the state on disk, re-run with `--skip-nx-cache` before diagnosing.
- A Docker `-v` mount of a worktree path fails *quietly*. Only `/workspaces/mcm` is bind-mounted from the Docker host; the worktree lives in the container's own overlay, which the daemon cannot see. The mount yields a near-empty directory (2 entries where the worktree had 31), so a containerised Playwright run collects zero tests and looks like a code problem.
- A worktree **does not survive a container rebuild**, while `git worktree list` still records it as `prunable`. Push the branch before anything risky.

**Why it belongs here.** None of this is specific to AI. Worktrees have been in git since 2015 and the traps above would bite a human just the same. What is new is the *scale* of concurrency: a single developer can now run five sessions in parallel, each as productive as a junior engineer with no memory of the others, and the shared checkout becomes the one place where they can silently damage each other's work. The worktree rule is the cheapest possible isolation, seconds to set up.

### 1.11 Replicating this, and where it is soft

#### In another repository

In the order that gives the most benefit earliest:

1. **Install Spec Kit and write a small constitution.** Start with the handful of principles you would reject a PR over. Version it and log why each amendment happened. Do not try to write 1,000 lines on day one; MCM's grew one lesson at a time.
2. **Make tests required in the tasks template, with RED/GREEN evidence fields.** Do it as an override in `.specify/templates/overrides/`, not by editing the core template. Check whether the tasks skill itself says tests are optional, and fix that too.
3. **Guard your overrides.** Record the fork point, check it in CI, and write down the upgrade procedure. Without this the first Spec Kit upgrade undoes step 2 silently.
4. **Keep the instruction file to gates and an index.** Give every learning a home somewhere else and state the routing rule in the file. Add a check that fails when prose appears. With more than one coding assistant, make one file the source and the others shims that import it.
5. **Adopt the page format before any generator.** Front matter with a type, a description and a single `resource`; one subject per page; a per-directory index; a list of which pages are canonical. You can write these by hand or with the assistant in-session. MCM's experience says the format and the gates are the value, and unattended generation is optional at best.
6. **Fingerprint derived pages and block stale ones in CI.** This is a few dozen lines of script and removes the whole class of "the summary is out of date".
7. **Add the doc-impact sweep to the tasks template.** It is a grep, and it found the errors that five months of ticked doc tasks did not.
8. **Put the security scanners in as blocking gates with expiring allowlists.** SAST and dependency audit on every PR, DAST against a disposable stack, a scheduled image CVE sweep. Fail closed when a scanner cannot run.
9. **Run a dependency bot, and give it a health check.** Pin everything, let the bot propose, let CI judge, keep a human on the merge button, and make the bot's silence an alarm.
10. **Add an audit that measures drift and files its successor.** Without a number you cannot tell whether steps 6 and 7 work.
11. **Turn each incident into a gate, not a paragraph.** When something bites, ask what check would have failed, and write that check with a self-test.

#### Limits and open gaps

Stated plainly, because a reader copying this should know where it is soft:

- **"A spec must exist before code" is not mechanically enforced.** It is a constitution principle and a session gate, backed by review and the commit trail. No CI check for it was found.
- **RED-before-GREEN ordering is evidenced, not verified.** The format requires the commands and expected output; nothing replays them. A session could record a RED it did not observe.
- **`/speckit-constitution` checks the core tasks template, not the override,** when validating an amendment. The runbook says to check the override by hand.
- **The doc-impact sweep finds renamed identifiers, not changed behaviour.** Semantic drift is left to the quarterly audit; the per-PR mechanical layer is unbuilt.
- **Only the tasks template fork is guarded.** A new override of another template needs the gate extended in the same PR.
- **V17 proves a page was refreshed, not that the refresh is right.**
- **A green CI run says nothing about the observability stack.** The end-to-end suite does not start it, which is why major upgrades of stateful services go through a numbered feature and an ADR.
- **Some gates still have no self-test** (resource naming, lockfile refresh, dependency downgrade, pnpm version).
- **The counts are static.** A line count, a file count or a pattern match says how much there is, not how good it is.
- **The 70% coverage minimum is a principle, not a gate.** The only configured threshold is `coverageThreshold` (lines 70) in `frontend/mcm-app/package.json`, which applies only to `test:coverage`, and no workflow runs that script.

---

## Part 2. Lessons ledger

One line per lesson. **Landed** is the date the lesson was first written down, not the date of the incident behind it. **Status** is the only field that changes after a line is written. A reversed lesson stays in the ledger: the reversal is usually the more useful half.

### 2026-07-17: the first eight, at 40 features

| # | Lesson as first written | Status at last refresh | Canonical home |
| --- | --- | --- | --- |
| 1 | **New stacks are no longer the barrier.** React Native, Expo, Rust, LangGraph, Forgejo and Komodo were all new. The AI handles syntax; the human must learn the concepts well enough to review, question and steer. | **Stands, extended (2026-10).** The barrier moved to *operating* the stacks. Upgrading OpenSearch and Langfuse across major versions needed an ADR, a CI-proven hypothesis and a per-store data plan. | [ADR-0002](decisions/ADR-0002-stateful-major-upgrades.md) |
| 2 | **Spec-Driven Development is the backbone.** Every feature flows spec → plan → tasks → implementation. Writing *what* before *how* keeps the agent from wandering. | **Stands, extended (2026-11).** Spec Kit itself needed overrides, and the overrides needed a guard (lesson 17). The hardest specs are the remediation clusters, where the spec is a hypothesis about a flaky system. | [SDD lifecycle](../openwiki/process/spec-driven-development.md), [Spec Kit runbook](runbooks/spec-kit.md) |
| 3 | **A constitution matters more than any prompt.** A roughly 1,000-line, versioned document of non-negotiable principles, amended about 20 times as lessons landed. It is the difference between an agent that follows your standards and one that reinvents them every session. | **Stands.** It now grows mostly by *bounded exceptions with an enforcing script*, not by new prose rules. | [Constitution](../.specify/memory/constitution.md) |
| 4 | **`CLAUDE.md` is where the "how" and the learnings live**: commands, gotchas, hard-won lessons. Prune it and push detail to linked runbooks, because every line costs context window on every request. | **Reversed.** Pruning failed; the file grew to 592 lines. From feature 044 it became an index with gates, and "never write a learning into this file" became a CI failure. On 2026-11-16 the gates and index moved to `AGENTS.md` and `CLAUDE.md` became a shim (lesson 18). | [AGENTS.md](../AGENTS.md), [where a learning goes](../openwiki/INSTRUCTIONS.md) |
| 5 | **Documentation is the interface, not a by-product.** Stale docs mislead the agent; refined docs compound. | **Stands, revised twice.** 2026-11-10: the page *format* proved more valuable than the paid generator that first produced it; the coding session now refreshes a summary in the same PR as its source. 2026-11-15: the doc-impact sweep became mandatory. | [ADR-0004](decisions/ADR-0004-session-maintained-wiki.md), [doc-drift runbook](runbooks/doc-drift.md) |
| 6 | **Dev Containers make the environment part of the repo**: an identical, isolated toolchain on any machine, with the AI assistant sealed off from the host. | **Stands, revised (2026-08-15, feature 060).** The first isolation had holes (sibling containers, secrets baked into image layers). The Docker engine moved into a micro-VM with network policy enforced outside it. | [Sandbox runbook](runbooks/devcontainer-sandbox.md) |
| 7 | **Security-first and TDD are enforced, not encouraged**: BFF token custody, deny-by-default authorization, zero secrets in git, and SAST/DAST/CVE scanning as blocking CI gates. Tests are verified failing before implementation, with a documented testing strategy the agent must follow, or it will "fix" the app inside the test. | **Stands, extended (2026-10).** Enforcement needs *expiry* (an allowlist that never expires is just suppression) and *evidence* (lesson 15). **Caveat found 2026-11-16:** the constitution's 70% coverage minimum is not a CI gate. | [SAST](runbooks/sast-scanning.md), [DAST](runbooks/dast-scanning.md), [image scanning](runbooks/infra-image-scanning.md), [test task format](templates/feature-test-tasks-template.md) |
| 8 | **Token economy is an engineering discipline**: RTK to compress command output (about 89% savings at the time), fresh-session handoffs with structured docs instead of grinding long contexts, and running the full suite in CI instead of locally. | **Stands, extended (2026-10 and 2026-11).** It reached from the context window to the bill: LLM cost reduction, probabilistic tests moved off the merge gate, and a wiki refresh that went from $167.80 in 30 days on the API to zero marginal cost in the session. | [Constitution](../.specify/memory/constitution.md), [ADR-0004](decisions/ADR-0004-session-maintained-wiki.md) |

### 2026-10-21: five more, at 79 features

| # | Lesson as first written | Status at last refresh | Canonical home |
| --- | --- | --- | --- |
| 9 | **Model-decision assertions cannot gate a merge.** If a test's outcome depends on what an LLM chose, retrying is not a fix; classify it and run it out of band. | **Stands.** | [Testing tiers](../openwiki/invariants/testing-tiers.md) |
| 10 | **Harnesses need harnesses.** A gate that checks every job has a failure digest; guard tests that parse the pipeline; a health job whose silence is the alarm; self-tests before every scan. | **Stands.** Four gate scripts still have no self-test. | [CI diagnostics runbook](runbooks/ci-diagnostics.md) |
| 11 | **Make upgrades dischargeable.** Pin images by version + digest so a CVE entry disappears with the upgrade; aim to delete entries, not re-date them; turn "needs a major" into a spec with an ADR. | **Stands, with one honest miss.** OpenSearch 3 did not clear its CVE, so that entry was re-keyed to the new digest and kept. | [ADR-0002](decisions/ADR-0002-stateful-major-upgrades.md), [image scanning](runbooks/infra-image-scanning.md) |
| 12 | **A dependency bot is a system, not a bot.** Schedule ∩ cron, Node engine, Docker Hub paging, stale lockfiles, override floors, expiry cliffs: each failed at some point, mostly silently, and each now has a test. | **Stands.** | [Renovate runbook](runbooks/renovate.md) |
| 13 | **Parallel agent sessions need isolation the tools do not give you by default.** Several sessions in one container multiply throughput and share one git index. Commit from a worktree, never from the shared checkout. | **Stands.** | [Dev container runbook](runbooks/devcontainer.md) |

### 2026-11-15: four more, at 99 features

| # | Lesson as first written | Status at last refresh | Canonical home |
| --- | --- | --- | --- |
| 14 | **Guidance on a page does not keep anything honest; a gate does.** When something bites, ask what check would have failed, and write that check with a self-test. | **Stands.** | [Feature validation checklist](../openwiki/invariants/feature-validation-checklist.md) |
| 15 | **Turn disciplines into evidence.** A Verify RED line with a command and an expected failure is either true in the terminal or not. A ticked box is not evidence. | **Stands.** Evidenced, not verified: nothing replays the commands. | [Test task format](templates/feature-test-tasks-template.md) |
| 16 | **Watching a test fail proves it is sensitive, not that it is correct.** Ask what it would look like if the assertion held and the feature were still broken. | **Stands.** | [Test authoring conventions](../openwiki/process/test-authoring-conventions.md) |
| 17 | **A fork of a vendor file is a liability unless something tells you when upstream moved.** Record the fork point and check it in CI. | **Stands, exercised twice.** The guard carried the Spec Kit 0.11.2 → 0.16.5 upgrade on 2026-11-15. On 2026-11-16 it was extended to the Copilot tasks agent and `/speckit-converge`, closing two known gaps. | [Spec Kit runbook](runbooks/spec-kit.md) |

### 2026-11-16: one more

| # | Lesson as first written | Status at last refresh | Canonical home |
| --- | --- | --- | --- |
| 18 | **One instruction file for every assistant; the others are shims.** With the gates in `CLAUDE.md`, only Claude Code ever saw them. Moving them to `AGENTS.md` and reducing `CLAUDE.md` to an import means every assistant loads the same instructions exactly once. | **New.** | [AGENTS.md](../AGENTS.md), [governance gate](../scripts/check-openwiki-governance.mjs) (G15) |

---

## Part 3. Measurement log

Each column is one refresh. From 2026-11-17 on, a column is the output of [`scripts/count-repo-metrics.mjs`](../scripts/count-repo-metrics.mjs), pasted unchanged, and is dated by the commit it counted. The script reads the files committed at that commit, so an earlier commit can be counted later with `--rev`: the 2026-07-18 and 2026-10-22 columns were back-filled that way, each beside the hand count it re-measures.

| Measure | 2026-07-17 | 2026-07-18 | 2026-10-21 | 2026-10-22 | 2026-11-17 |
| --- | --- | --- | --- | --- | --- |
| Method | Author's count in the LinkedIn post | `scripts/count-repo-metrics.mjs --rev e4be5ae8`, back-filled 2026-11-17 | One-off count of the working tree | `scripts/count-repo-metrics.mjs --rev 1f0e2cfd`, back-filled 2026-11-17 | `scripts/count-repo-metrics.mjs` |
| Commit | not recorded | `e4be5ae8` | not recorded | `1f0e2cfd` | `ce3a315c` |
| Features | 40 | 37 (numbered to 040) | 79 (numbered to 082) | 79 (numbered to 082) | 99 (numbered to 101; 098 used twice) |
| Commits | 900+ | 1,023 | 3,282 | 3,284 | 3,961 |
| Production code | ~49k lines of application code | 54,924 lines in 426 files: 42k application, 13k CI/gate scripts and shell | 88,301 lines in 554 files: 55k application, 33k CI/gate scripts and shell | 92,425 lines in 577 files: 56k application, 37k CI/gate scripts and shell | 96,572 lines in 602 files: 58k application, 39k CI/gate scripts and shell |
| Test code | ~55k lines | 57,586 lines in 419 files | 119,189 lines in 667 files | 115,559 lines in 614 files | 126,516 lines in 666 files |
| Test cases (static) | not counted | 2,624 | about 5,300 | 5,310 | 5,725 |
| Documentation (markdown) | ~67k lines | 68,833 lines in 516 files | about 163,000 lines in 858 files | 171,186 lines in 909 files | 191,073 lines in 1,019 files |
| Test lines per code line | not counted | 1.05 | 1.35 | 1.25 | 1.31 |
| Documentation lines per code line | not counted | 1.25 | 1.85 | 1.85 | 1.98 |
| Constitution | ~1,000 lines, ~20 amendments | 1,008 lines, v2.3.0, 18 amendments | 1,020 lines, v2.6.0, 21 amendments | 1,020 lines, v2.6.0, 21 amendments | 1,024 lines, v2.10.0, 25 amendments |
| Instruction file | `CLAUDE.md`: size not recorded | `CLAUDE.md`: 543 lines, no Gates section | `CLAUDE.md`: 153 lines, 12 gates | `CLAUDE.md`: 153 lines, 12 gates | `AGENTS.md`: 180 lines, 13 gates |
| Knowledge pages | none | 0 files, 0 derived summaries | 81 files | 81 files, 50 derived summaries | 86 files, 53 derived summaries |
| ADRs / runbooks | not counted | 1 / 11 | 2 / 22 | 2 / 22 | 4 / 24 |
| CI workflows / jobs | not counted | 6 / 16 | 9 / 21 | 9 / 21 | 11 / 25 |
| Gate scripts (`check-*`) | not counted | 11 | 19 | 19 | 22 |
| Script tests (guard tests) | not counted | 6 (2) | 85 (33) | 85 (33) | 110 (43) |
| Task lists with Verify RED | not counted | 26 of 36 (27 counting "Expected RED") | not counted | 66 of 78 (67 counting "Expected RED") | 84 of 98 (86 counting "Expected RED") |
| Allowlist entries (SAST / DAST / image) | not counted | 5 / 1 / 13 | 9 / 1 / 5 | 9 / 1 / 5 | 8 / 1 / 6 |
| Renovate rules / managers / groups | not counted | 9 / 0 / 5 | 43 / 10 / 23 | 43 / 10 / 23 | 44 / 9 / 21 |

Reading the log:

- **Compare scripted columns with scripted columns.** The two October columns describe almost the same tree (two commits apart), yet the hand count found 4.5% less production code, 3% more test code and 5% less documentation than the script. That method gap is as large as a month's growth: by hand, production code grew 9% from October to November; by the script it grew 4.5%. The July post's figures were rounder still: "40 features" was the highest number (37 folders existed), and its ~49k lines of application code sits between the script's 42k application and 55k total. The hand columns stay as they were written, as the record of what was reported at the time.
- **Every figure is a static count**: lines, files or pattern matches over the files committed at the named commit. "Test cases" counts test declarations, not tests executed.
- **The proportions are the point.** Tests and documentation each outweigh the code, and both ratios have risen at every scripted refresh: tests from 1.05 (July) to 1.25 (October) to 1.31 lines per line of code, documentation from 1.25 to 1.85 to 1.98. Over the same four months production code grew 76%.
- **Feature folders and feature numbers differ.** 98 numbers are in use from 001 to 101 (016, 024 and 036 were never used), and 098 was given to two features, so there are 99 folders.

### Feature timeline

The first 79 features took roughly five and a half months (first spec 2026-05-02, feature 082 on 2026-10-10): one every two days on average. Twenty more followed in the next five weeks.

| Era | Features | When |
| --- | --- | --- |
| **Core product** | 001 user login, 002 manage movie collections | May |
| **Test hardening and cleanup** | 003 test hardening, 004 real-dependency BFF tests, 005 Expo 55→56, 006 flakiness, 007 E2E against a containerised BFF, 008 maintainability, 009 full-repo review remediation, 010 Expo Router cleanup, 011 access-control foundation | late May – early June |
| **AI agents** | 012 multi-agent MVP, 013 post-agent fixes (including the switch to BFF cookies, constitution v2.0.0), 014 spreadsheet import/export, 018 per-user agent config | June |
| **Design system** | 015 apply the "MCM Cinema" design system, 017 consistency pass | mid-June |
| **Docker, production, home-lab, CI** | 019–020 naming conventions, 021 externalise secrets, 022 public-hostname auth, **023 self-hosted Forgejo CI/CD** (leaving GitHub Actions), 025 observability/audit/Vault, 026 production data-tier auth (ADR-0001), 027 keep secrets off the command line, 028/030 survive server reboots, 029 port isolation between prod and CI | late June – early July |
| **Security scanning** | **031 DAST (ZAP)**, 032 security headers (the first thing DAST found), **033 SAST + dependency audit (Semgrep)**, 034 baseline hardening, **035 container-image CVE scanning (Trivy)** | 8–11 July |
| **Dev container** | 037 containerised dev environment, 038 full toolchain in-container, 039 reproducible stacks, later **060 Docker Sandbox** (replacing Docker-in-Docker) | July; 15 Aug |
| **CI enforcement and diagnostics** | 041 integration tests enforced in CI, 042 self-serve CI diagnostics, 051 diagnostics gap closure, 061 Playwright image-pin gate | July – Aug |
| **Knowledge layer** | **043 OpenWiki**, 044 automate it and slim `CLAUDE.md`, 078 cheaper generation, 082 drift re-planning, **098 session-maintained wiki** (bot retired), **101 doc-drift prevention** | 26 July → 15 Nov |
| **Authorisation tests and assistant fixes** | 040 admin registration and agent fixes, 045–046 authz test suites, 047 assistant enhancements, 048 test-harness remediation, 049 agent-driven issue tracking in Forgejo, 050 search-cancel fix, 059 assistant add fidelity | mid-July – Aug |
| **Reliability clusters** | 052 E2E worker contention, 053 dropped queued turns, 054 app-E2E reliability, 055 gateway livelock, **056 agent gate split**, 064 turn delivery, 065 provider error surfacing | Aug – Sep |
| **Dependency loops and pins** | **057 dependency-security loop**, **058 dependency-refresh loop**, 063 image version + digest pins, 067 Python toolchain grouping | Aug – Sep |
| **Major upgrades and migrations** | 066 CopilotKit 1.70, 068 MCP SDK 2.x, 069–070 object store built from source / non-root, 071 OpenSearch 3, 072 Langfuse 4, 080 object-store move to RustFS, **081 sequenced major-dependency upgrades** | Sep – Oct |
| **Product and cost** | 062 settings split, 073 scheduled backups, 074 not-found page, 075 LLM cost phase 1, 076 account deletion, 077 web bundle diet, 079 error sanitiser | Aug – Oct |
| **Hardening and follow-through** | 083 backup consent and session isolation, 084 silent-failure visibility, 085 BFF auth fail-closed, 086 dev memory bounds, 087 Expo SDK 58, 088–094 test guards, Keycloak scopes, service-account roles and token-cache fixes, 095 formatter gates, 096 unused-code cleanup, 097 review follow-ups, 098–099 filter UI fixes (the other 098 is the session-maintained wiki, under Knowledge layer), 100 wiki telemetry and drift fixes | Oct – Nov |

The shape of the journey: two product features, then nine features of test and structural hardening before the agents arrived. After the agents, the balance tipped permanently toward infrastructure. That is not a failure of focus. It is what "production-grade" costs when the code is written by something that cannot remember yesterday, and it is what lets later product features land in days on a codebase that has changed under them for months.

---

## How to update this document

1. **A learning goes to its canonical home first.** The routing rule is in [AGENTS.md](../AGENTS.md) under "Where a new learning goes". This document gets a ledger line only when the learning changes the story, and the line links to that home.
2. **Ledger (Part 2): append.** Add a line under a new dated heading. To record that a lesson changed, edit its *Status* cell and say when. Never edit the lesson text or delete a line.
3. **Log (Part 3): append a column.** Run `node scripts/count-repo-metrics.mjs` on `main` and add its column to the table. Never edit an earlier column. Add a row to the feature timeline when an era closes.
4. **Story (Part 1): rewrite in place.** No "superseded" notes; git holds the history. If a passage starts to explain how to do something, replace it with a link to the runbook that owns it.
5. **Refresh the first line**: the date and commit of the newest log column.

**When.** At each quarterly drift audit, as a step of its procedure ([doc-drift runbook](runbooks/doc-drift.md#the-quarterly-drift-audit-layer-3)), and whenever a ledger status changes.

**How the doc-impact sweep should treat it.** Part 1 describes current state, so a renamed identifier is fixed there like anywhere else. Parts 2 and 3 are records of what was true at the time, so their dated entries are left alone.

## Where things live

- **Principles:** [constitution](../.specify/memory/constitution.md)
- **Session gates and the knowledge index:** [AGENTS.md](../AGENTS.md), reached by Claude Code through the [CLAUDE.md](../CLAUDE.md) shim
- **Architecture:** [MCM-Architecture.md](MCM-Architecture.md), [README](../README.md)
- **Specs, plans and task lists:** [specs/](../specs)
- **Spec Kit customisation:** [Spec Kit runbook](runbooks/spec-kit.md), [override guard](../scripts/check-speckit-overrides.mjs), [test task format](templates/feature-test-tasks-template.md)
- **Process pages:** [SDD lifecycle](../openwiki/process/spec-driven-development.md), [test authoring conventions](../openwiki/process/test-authoring-conventions.md), [testing tiers](../openwiki/invariants/testing-tiers.md), [feature validation checklist](../openwiki/invariants/feature-validation-checklist.md)
- **Knowledge pages:** [brief](../openwiki/INSTRUCTIONS.md), [write policy](../openwiki/policy.yaml), [protected passages](../openwiki/protected.yaml), [wiki maintenance runbook](runbooks/wiki-maintenance.md), [doc-drift runbook](runbooks/doc-drift.md)
- **Decisions:** [ADR-0001](decisions/ADR-0001-prod-secrets-management.md), [ADR-0002](decisions/ADR-0002-stateful-major-upgrades.md), [ADR-0003](decisions/ADR-0003-claims-and-fingerprints.md), [ADR-0004](decisions/ADR-0004-session-maintained-wiki.md)
- **CI/CD and security:** [workflows](../.forgejo/workflows), [Renovate config](../renovate.json), runbooks for [Renovate](runbooks/renovate.md), [SAST](runbooks/sast-scanning.md), [DAST](runbooks/dast-scanning.md), [image scanning](runbooks/infra-image-scanning.md), [end-to-end testing](runbooks/e2e-testing.md), [CI diagnostics](runbooks/ci-diagnostics.md)
- **Dev environment and parallel sessions:** [dev container runbook](runbooks/devcontainer.md), [sandbox runbook](runbooks/devcontainer-sandbox.md)
- **Public mirror:** [github.com/jumbleknot/MovieCollectionManager](https://github.com/jumbleknot/MovieCollectionManager)
