# AGENTS.md — the instruction file for every coding assistant

## Gates that run before you act

- **Never set `ANTHROPIC_API_KEY` on the host, in the dev container or in the Sandbox VM — AI coding runs on the MAX subscription** — Claude Code silently prefers that variable over a subscription login and bills per token (~$15 in one unnoticed day). The key is carried as `MCM_ANTHROPIC_API_KEY` and mapped to `ANTHROPIC_API_KEY` only at the point of use (agent gateway, wiki maintenance, containerized E2E); CI is unaffected — [mechanism, consumers, host migration](docs/runbooks/devcontainer.md)
- **SDD is not optional for implementation** — code under `backend/`, `frontend/`, `agents/`, `mcp-servers/` or `infrastructure-as-code/` needs an existing `specs/NNN-*/` spec → plan → tasks set; write it first, or stop and ask. Proposals (`docs/proposals/**`) and knowledge/index edits are exempt — [the lifecycle](openwiki/process/spec-driven-development.md)
- **Other agents share this dev container — commit from a WORKTREE, never from `/workspaces/mcm`** — a `git checkout -b`, `git add -A` or `git stash` there rewrites another session's work. `git worktree add -b <branch> /home/coder/worktrees/<slug> origin/main` (`/workspaces` is not writable); a symlinked `node_modules` serves `node --test` and gate scripts only, while any `pnpm nx` target needs a real `CI=true pnpm install --frozen-lockfile` in the worktree. It does not survive a rebuild — push first. Forge-API work needs no worktree — [procedure, traps, cleanup](docs/runbooks/devcontainer.md)
- **A PR's head MUST be a real branch — never an AGit push** — `git push origin HEAD:<branch>`, then `node scripts/forge-pr.mjs open` (also `merge <N> --expect-head <sha>`, `dispatch`); never hand-type a `git credential fill` recipe. An AGit (`refs/for/main`) head runs with NO Actions secrets, which surfaces as nx's `Misconfigured remote cache endpoint` — [the invariant, the script, the fallback](docs/runbooks/ci-diagnostics.md)
- **A tool's "no" is about the tool, not your question — check before claiming anything verified OR impossible** — a skipped test exits 0 and reads as a pass (watch the SKIP COUNT; `MCM_REQUIRE_LIVE_STACK=1`, `E2E_REQUIRE_AGENT_STACK=1`, `MCM_REQUIRE_LIVE_MODEL=1` make skips fail), and a failing `nx e2e` is about that target, not E2E — Playwright runs here in its official image — [flags, image recipe](docs/runbooks/e2e-testing.md)
- **"It can't run in this environment" needs the same proof as "it passes"** — a credential-driven skip is almost always a missing *file*, not a missing capability (38 errors once traced to one absent gitignored `.env.local`). Name the missing input and check whether a generator or documented command supplies it before retiring a tier to CI — [detect → resolve](docs/runbooks/local-dev.md)
- **Before believing a result, check the INSTRUMENT — an argument a tool does not recognise is often ignored silently, or acted on** — `node --test <file> --test-name-pattern x` runs EVERYTHING (node's flags go before the path); Playwright's `--grep-invert` does nothing here; a `--help` or mistyped `--dry-run` once deployed, posted and deleted for real; a forge empty list or 404 often means the wrong token or id, not "nothing published" — [instrument traps](docs/runbooks/e2e-testing.md), [forge traps](docs/runbooks/ci-diagnostics.md)
- **The agent E2E suite is SPLIT: model-decision assertions do not block a merge** — a gate that fails half the time on identical code is not gating. Every agent test carries `@gate` or `@model-decision`, selected by `E2E_TIER` in `playwright.config.ts` (not `--grep-invert`); an unclassified test FAILS. The model tier still runs, non-blocking, on every `main` push and dispatch — [the rule, the classification](openwiki/invariants/testing-tiers.md)
- **Changing a file that is an `openwiki/` page's `resource` means refreshing that page IN THE SAME PR** — the required `okf` check (V17) fails otherwise: `node scripts/wiki-refresh.mjs --stale`, then per page `--diff`, edit only what it invalidates, `--record`; never hand-type a hash — [the skill](.claude/skills/wiki-refresh/SKILL.md), [the duty](docs/runbooks/wiki-maintenance.md#refresh)
- **Run the test tiers your DIFF touches, not the ones you remember** — derive test, lint, typecheck and integration targets from what changed; a tier you did not think of is a tier that did not run — [the tiers](openwiki/invariants/testing-tiers.md)
- **A guard that fails because you changed what it protects gets UPDATED at the cause, never deleted** — make it assert the new premise so it still fails if that regresses; a guard removed for being inconvenient is the regression it was written to catch — [where each is enforced](openwiki/invariants/testing-tiers.md)
- **Renovate's silence is not idleness** — routine work runs only in the Friday window (`* 2-4 * * 5`), not the nightly cron; a channel missing its lockfile toolchain fails silently for ever; a forced dispatch defaults to `dryRun: true`, so confirm a live run from branch heads moving, never from a green run — [schedule, dashboard, silent failures](docs/runbooks/renovate.md)
- **When the whole CI board goes red, suspect the INSTALL before the code** — `okf` and `sast` failing beside `affected` is the tell (e.g. a supply-chain policy rejecting a just-published transitive that a lockfile regeneration dragged in); don't read all six digests — [the two causes, superseded vs live](docs/runbooks/ci-diagnostics.md)

## Start here

- **This is the ONE instruction file** — Codex and OpenCode read it directly, Copilot beside the [CLAUDE.md](CLAUDE.md) shim, Claude Code through that shim's `@AGENTS.md` import — [G15](scripts/check-openwiki-governance.mjs)
- [openwiki/quickstart.md](openwiki/quickstart.md) — what this repository is and how the knowledge bundle is organized
- [openwiki/INSTRUCTIONS.md](openwiki/INSTRUCTIONS.md) — the generation brief: scope, exclusions, redaction, **where a new learning goes**
- [docs/runbooks/wiki-maintenance.md](docs/runbooks/wiki-maintenance.md) — same-PR page refresh, and manual rebuilds
- [openwiki/policy.yaml](openwiki/policy.yaml) — which paths may be rewritten, when, by which actor
- [openwiki/protected.yaml](openwiki/protected.yaml) — the canonical concepts and their fingerprinted passages

## Where a new learning goes

- A concept citing a `resource` is a **derived summary** → write it into the cited source **and refresh the concept in the same PR** — [the rule](openwiki/INSTRUCTIONS.md)
- A concept marked **[canonical]** below has no upstream document → write the learning **into the concept** — [the canonical list](openwiki/protected.yaml)
- No concept covers the subject → **add one**, writing detail into the subject's canonical document where it has one — [how to](openwiki/INSTRUCTIONS.md)
- **Never** into this file: it is an index, and [the governance gate](scripts/check-openwiki-governance.mjs) fails on prose beyond the index and the managed regions (G8) and on a line or file over its size budget (G16) — a gate keeps the rule and its trap; the story goes in the linked doc
- **Never** into [CLAUDE.md](CLAUDE.md) either: it is a shim, so content there reaches Claude alone, and a copy of this file there loads it twice (G15)

## Knowledge index

### Projects

- [Agent Gateway (LangGraph)](openwiki/projects/agent-gateway.md) — the supervisor graph behind the assistant, reachable only from the BFF
- [BFF (Backend-for-Frontend)](openwiki/projects/bff.md) — sessions/auth, proxy to mc-service, inside the mcm-app process
- [CI/CD pipeline (Forgejo Actions)](openwiki/projects/ci-cd-pipeline.md) **[canonical]** — guardrails, app-ci, cd-deploy
- [MCM Cinema design system](openwiki/projects/design-system.md) — MD3 tokens and the Tamagui component library
- [Expo/React Native universal app](openwiki/projects/expo-app.md)
- [Infrastructure-as-code stacks (local Compose + production Komodo)](openwiki/projects/infrastructure-stacks.md)
- [mc-service (Rust/Axum movie-collection service)](openwiki/projects/mc-service.md)
- [The three scoped MCP servers](openwiki/projects/mcp-servers.md) — movie-mcp, web-api-mcp (TMDB), and the third

### Architecture

- [AI Agents layer architecture](openwiki/architecture/agent-layer.md) — call chain, token custody, per-user config
- [mc-service domain data model](openwiki/architecture/data-model.md) **[canonical]**
- [System overview (MCM)](openwiki/architecture/system-overview.md)

### Invariants

- [Authentication and authorization chain](openwiki/invariants/auth-chain.md) **[canonical]**
- [Final validation checklist](openwiki/invariants/feature-validation-checklist.md) **[canonical]** — incl. the web E2E regression even for backend-only changes
- [Logging and audit conventions](openwiki/invariants/logging-and-audit.md) **[canonical]** — incl. the never-log list
- [Model-provider environment scoping](openwiki/invariants/model-provider-scoping.md) **[canonical]** — Ollama dev/test, Claude golden/prod
- [Nx as the universal task runner](openwiki/invariants/nx-task-runner.md) **[canonical]**
- [Package-manager enforcement (pnpm only)](openwiki/invariants/package-manager-enforcement.md) **[canonical]**
- [Published-port reservation convention](openwiki/invariants/published-port-reservation.md) — 19000-19099 for prod admin/UI ports
- [RTK (Rust Token Killer) token compression](openwiki/invariants/rtk-token-compression.md) **[canonical]**
- [Secrets management posture](openwiki/invariants/secrets-management.md)
- [Testing tiers and what gates a merge](openwiki/invariants/testing-tiers.md) **[canonical]**

### Gotchas

- [SSRF guard must check the canonicalized IP, not the hostname string](openwiki/gotchas/agent-config-ssrf-guard.md) **[canonical]**
- [Cascade delete is a MongoDB transaction — replica set required](openwiki/gotchas/cascade-delete-and-replica-set.md) **[canonical]**
- [Docker internal DNS — BFF reaches Keycloak by service name, never localhost](openwiki/gotchas/docker-internal-dns.md) **[canonical]**
- [.env files — no inline comments on value lines](openwiki/gotchas/env-file-inline-comments.md) **[canonical]**
- [Expo Router server export and agent-transport traps](openwiki/gotchas/expo-router-and-transport-traps.md)
- [Directory-based collection routing in Expo Router](openwiki/gotchas/expo-router-collection-routing.md) **[canonical]**
- [External ID links open via a scheme-guarded openUrl helper](openwiki/gotchas/external-id-url-opening.md) — and a second, unguarded copy
- [Service account vs admin credentials — Keycloak Admin API calls](openwiki/gotchas/keycloak-service-account.md)
- [Compound keyset pagination for movie lists](openwiki/gotchas/keyset-pagination.md) **[canonical]**
- [mc-service musl-conditional vendored OpenSSL](openwiki/gotchas/mc-service-musl-openssl.md) **[canonical]**
- [MongoDB collation uniqueness and the language_override trap](openwiki/gotchas/mongodb-indexes-and-uniqueness.md) **[canonical]**
- [OTel span exception recording can leak a credential in the URL](openwiki/gotchas/otel-span-exception-leak.md)
- [Playwright testID mapping — React Native Web renders testID as data-testid](openwiki/gotchas/playwright-testid-mapping.md)
- [mc-service errors are RFC 9457 Problem Details, never a stack trace](openwiki/gotchas/rfc-9457-problem-details.md)
- [Role enforcement is a layer, not a per-handler check — at every tier](openwiki/gotchas/role-enforcement-is-a-layer.md) **[canonical]**
- [cargo fmt formats the WHOLE crate — a per-file argument does not scope it](openwiki/gotchas/rust-formatting-scope.md) **[canonical]**
- [Session ID vs JWT — Redis session lifecycle and concurrent-session eviction](openwiki/gotchas/session-lifecycle-and-eviction.md)

### Runbooks

- [Android emulator & APK builds (mobile E2E)](openwiki/runbooks/android-emulator.md) — where to run mobile flows
- [The agent-driven backlog (Forgejo Issues)](openwiki/runbooks/backlog.md) — `scripts/backlog.mjs`
- [CI self-serve diagnostics](openwiki/runbooks/ci-diagnostics.md) — `ci-status.mjs`, superseded vs failed
- [DAST scanning (OWASP ZAP)](openwiki/runbooks/dast-scanning.md)
- [Developer environment setup (host toolchain)](openwiki/runbooks/dev-environment-setup.md)
- [Claude Code token usage capture](openwiki/runbooks/dev-usage.md) — hooks → `scripts/cc-usage.mjs` → `prod-dev-usage`; `doctor`
- [Containerized dev environment](openwiki/runbooks/devcontainer.md) — DinD path, kept only for the Android emulator; the Sandbox microVM manual is [devcontainer-sandbox.md](docs/runbooks/devcontainer-sandbox.md)
- [Doc drift: the doc-impact sweep and the quarterly audit](openwiki/runbooks/doc-drift.md)
- [E2E testing (BFF container modes & flakiness diagnosis)](openwiki/runbooks/e2e-testing.md)
- [Infra-image CVE scanning](openwiki/runbooks/infra-image-scanning.md)
- [Local dev infrastructure & environment variables](openwiki/runbooks/local-dev.md)
- [Phase 15 operator checklist (bring the full app live)](openwiki/runbooks/phase-15-operator-checklist.md)
- [Prod control tower (observability / audit / dormant Vault)](openwiki/runbooks/prod-control-tower.md)
- [Production data-tier authentication (MongoDB SCRAM) and the 8.0.8 → 9.0 upgrade](openwiki/runbooks/prod-data-tier-auth.md)
- [Prod reboot resilience](openwiki/runbooks/prod-reboot-resilience.md)
- [SAST & SCA static scanning](openwiki/runbooks/sast-scanning.md)
- [Homelab server setup (CI/CD + production host)](openwiki/runbooks/server-setup.md)
- [Spec Kit: this repository's customisations, and upgrading it](openwiki/runbooks/spec-kit.md)

### Process

- [The governing constitution](openwiki/process/constitution.md)
- [Feature branch test scope](openwiki/process/feature-test-scope.md) **[canonical]** — which suites a touched story runs
- [PR batching — split only when a failure would be ambiguous](openwiki/process/pull-request-batching.md) **[canonical]**
- [Proposal → spec → plan → tasks → implementation lifecycle](openwiki/process/spec-driven-development.md) **[canonical]**
- [Test authoring conventions — Rust test placement and the RED/GREEN task template](openwiki/process/test-authoring-conventions.md) **[canonical]**
- [OpenWiki bundle generation and maintenance](openwiki/process/wiki-maintenance.md)

### Decision records

- [ADR-0001: Production secrets-management standard](openwiki/decisions/adr-0001-prod-secrets-management.md) — Komodo Variables, not Vault
- [ADR-0004: Wiki summaries are maintained by the coding session](openwiki/decisions/adr-0004-session-maintained-wiki.md)

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/101-doc-drift-prevention/plan.md`
<!-- SPECKIT END -->

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

Use the repository's documented maintenance process to refresh generated pages after source changes. Check its configuration and completed runs before relying on automatic updates. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

<!-- The block above is maintained by the OpenWiki tool and rewritten on every run; the section below lives outside it, so it survives regeneration. -->

## Knowledge wiki (OKF) — repository-specific notes

- **Query `openwiki/` before a broad text search** — concepts carry YAML front matter and each directory has an `index.md`; a concept is a summary, so follow its `resource` for authoritative detail — [how the bundle is organized](openwiki/quickstart.md)
- **Coverage is complete** — every runbook, ADR and architecture document has a concept citing it, so a missing concept means a missing document — [the brief](openwiki/INSTRUCTIONS.md)
- **Three of the OpenWiki block's defaults are wrong here** (corrected outside it, since a rebuild rewrites it): sessions DO hand-edit summaries, in the same PR as the source; there is NO scheduled refresh — `.forgejo/workflows/wiki-maintain.yml` (Forgejo, not GitHub) runs on manual dispatch for the named `pages` and opens one PR, never auto-merged; and the generator runs only through its Nx target, never the bare `openwiki` CLI, which OOMs — [ADR-0004](docs/decisions/ADR-0004-session-maintained-wiki.md), [the runbook](docs/runbooks/wiki-maintenance.md)
- **A page rejected by a gate is fixed in the page or the brief, never by an allowlist entry** — `pnpm nx okf-lint infrastructure-as-code`, `pnpm nx okf-governance infrastructure-as-code` and the leak scan all hold — [the brief](openwiki/INSTRUCTIONS.md)
