---
type: Decision
title: The governing constitution
description: The repository's ratified, versioned constitution — currently v2.8.0, ratified 2026-03-08 and last amended 2026-11-07, its Expo SDK 58 amendment approved by the operator on 2026-11-08 — the core principles every spec and plan must comply with, the amendment process and its same-pull-request rule, the per-feature Constitution Check gate, and the bundle-budget gate that enforces its sole accepted exception.
resource: .specify/memory/constitution.md
tags: [governance, security, tdd, constitution]
verified:
  - by: openwiki/0.7.1
    at: 2026-11-08T02:21:41.463Z
---

# The governing constitution

`.specify/memory/constitution.md` is the repository's single ratified source of core, supposedly
immutable principles — security, authentication/authorization boundaries, session management, TDD,
AI-assistant behavioral constraints, and per-stack technology baselines — governing Frontend Apps,
Backend Services, and AI Agents alike. It is versioned (semver-style, with a change log at the top
of the file) and has been amended more than twenty times as the system matured, from initial
ratification through incremental clarifications like the client auth model rewrite and the Tamagui
design-system mandate.

The file currently reads **v2.8.0**: its footer says `**Version**: 2.8.0 | **Ratified**: 2026-03-08
| **Last Amended**: 2026-11-07`, and the version-history entry carrying the `[CURRENT]` marker is the
one dated 2026-11-07. That marker is the authoritative "latest amendment" signal — check it rather
than inferring the version from any summary, this page included.

Amendments follow the file's own **Governance** section: a proposal documenting rationale, impact on
existing code and a migration plan; review and formal approval; a version bump (MAJOR for a principle
change, MINOR for a guidance addition, PATCH for a clarification); and alignment of existing code
within one release cycle. The same section states that the document supersedes all other practices
and conventions, and that every pull request and code review must verify compliance — a violation
flagged in review requires justification or a code change before merge. The bump level is
informative, not decorative: v2.0.0 superseded the previous client auth model outright, while the
recent MINOR bumps add a principle area or a scoped exception, or move a version-named stack
baseline, without redefining anything.

Governance's "formal approval" is human approval here, and the operational form of the rule — the
amendment lands **in the same pull request as the change it authorises**, never silently afterwards —
is written down in the features that needed it: feature 081 states it as **FR-015**, feature 087 as
**FR-024**.

```mermaid
flowchart TD
  A["Proposed change that touches the constitution"] --> B{"Principle change, guidance addition, or clarification?"}
  B -->|"Principle change"| C["MAJOR bump"]
  B -->|"Guidance addition"| D["MINOR bump"]
  B -->|"Clarification"| E["PATCH bump"]
  C --> F["Proposal: rationale, impact on existing code, migration plan"]
  D --> F
  E --> F
  F --> G["Review and formal approval by a human"]
  G --> H["Amend the file in the same pull request as the change it authorises"]
  H --> I["Align existing code within one release cycle"]
```

How a constitution amendment moves from proposal to ratified version.

## The three most recent amendments

All three are MINOR and stack-guidance-only, which makes them the clearest examples of the rule that
moving a version the document names is an amendment, and changing anything else about a line is not.

**v2.6.0** advanced the frontend stack baseline from Expo SDK 56 to Expo SDK 57 (with React Native
0.86 and React 19.2). **v2.7.0** advanced the document-database baseline to
`mongodb/mongodb-community-server:9.0-ubi9` (MongoDB 9.0 on Red Hat UBI 9) — and had to record that
the image the document had named until then, `8.2.6-ubuntu2204-slim`, was stale: `8.0.8-ubi9` is what
actually ran.

**v2.8.0** (2026-11-07) is feature 087's amendment, and it is the one worth reading in full, because
two of its three lines are not version numbers:

- the **framework baseline** moved — Expo SDK 57 → 58, React Native 0.86 → 0.88, React 19.2 → 19.3;
- the **Backend-for-Frontend** line was rewritten. `app.json`'s web output moved from
  `"output": "server"` to `"output": "static"` with `apiRoutes: true` on the `expo-router` plugin, so
  pages stay prerendered at build time while the API routes keep running in the same Node process.
  The old text was not wrong when it was written; it became wrong *on SDK 58*, where the literal
  `"output": "server"` means per-request rendering — a different runtime from the one the app was
  built and tested on. [`frontend/mcm-app/app.json`](../../frontend/mcm-app/app.json) now carries the
  amended arrangement (`"output": "static"`, and `{ "apiRoutes": true, "asyncRoutes": { "web": false } }`
  on the plugin), and the web README explains why `asyncRoutes.web` is written out explicitly rather
  than left to the SDK 58 default of on;
- the **BFF container's Node line** was corrected from a stale `node:24.14.1-alpine3.23` to
  `node:24.22.1-alpine3.23`, which is what all three stages of
  [`frontend/mcm-app/Dockerfile`](../../frontend/mcm-app/Dockerfile) actually build on. That third
  line was added at the operator's request rather than being in the original proposal, and it is
  recorded as such.

The amendment was approved by the operator on **2026-11-08**, recorded in the evidence table of
[`specs/087-expo-sdk-58/tasks.md`](../../specs/087-expo-sdk-58/tasks.md) (`T048`, now done), and
landed in the same pull request as the SDK move — the same-PR rule, honoured. No principle was
redefined, which is why it is a MINOR.

Amendments are drafted rather than hand-edited. The Spec Kit constitution command
([`.github/agents/speckit.constitution.agent.md`](../../.github/agents/speckit.constitution.agent.md),
and the equivalent skill at
[`.claude/skills/speckit-constitution/SKILL.md`](../../.claude/skills/speckit-constitution/SKILL.md))
loads the existing constitution, applies the same MAJOR/MINOR/PATCH rule (MAJOR for a removal or
redefinition of a principle or governance rule, MINOR for a new section or materially expanded
guidance, PATCH for clarifications), and carries a consistency-propagation checklist that pushes the
change back into the dependent templates —
[`.specify/templates/plan-template.md`](../../.specify/templates/plan-template.md) and its spec and
tasks siblings. A principle amended without those following is a tooling failure, not just a
documentation one.

## The tag-versus-digest distinction

The document-database line shows the difference between a *tag* and a *digest*. The constitution
names the tag (`9.0-ubi9`); every compose reference pins that same tag by digest, currently
`9.0-ubi9@sha256:3d40c6fa…` — a UBI 9.8 rebuild of the same mongod 9.0.4. The pinned digest has been
re-resolved twice since v2.7.0 was ratified with no further constitution change: the 2026-10-24
production cutover ran `sha256:2cb58a8d…`, and the 2026-11-01 move to `sha256:3d40c6fa…` was a
same-version rebuild that shipped a fixed `ca-certificates` and so discharged the
`CVE-2026-114406` allowlist entry. Refreshing a digest inside a named tag is ordinary image
maintenance; moving the named tag is the amendment.

## The Constitution Check gate

Compliance is operationalized per feature rather than left to review. Every `plan.md` carries a
**Constitution Check** gate — the wording in
[`.specify/templates/plan-template.md`](../../.specify/templates/plan-template.md) is *"GATE: Must
pass before Phase 0 research. Re-check after Phase 1 design."* — where each principle gets a row with
a status and how it is satisfied. That gate is what turns "every spec and plan must comply" into a
per-principle artefact a reviewer can check.

Feature 081's plan is one worked example: the Expo SDK line and the document-database image line are
marked **AMENDMENT REQUIRED**, each naming the story that amends it, while the Tamagui line is marked
PASS because the constitution names that library but no version of it. Feature 087's plan uses the
same gate and shows the harder case — *both* the framework-baseline row and the BFF output-mode row
are **AMENDMENT REQUIRED** under the same v2.8.0 amendment, the second because its literal text would
mean per-request rendering on the new SDK — with a second, post-design pass appended under the same
heading.

Notable principle areas: AI Assistant Constraints (behavior-descriptive identifiers, no vibe coding,
comments only for non-obvious rationale); Security (classification, PKCE-only auth via the BFF
pattern, IdP boundary for MFA/Conditional Access, deny-by-default authorization, server-side session
storage); and stack-specific standards layered on top for each of the three development surfaces.

Beyond principles, the document carries the monorepo **directory tree** and the **architecture
diagrams** — the two C4 container diagrams (the multi-frontend/multi-service layout, and the additive
AI-agents layer) plus the three auth-flow sequence diagrams (login, backend resource access, agent
auth). Those diagrams are the canonical picture of BFF token custody and of the RFC 8693 run-scoped
subject-token exchange and downscoped backend token, which makes the constitution a design reference
as well as a rulebook. The tree carries approved deviations as well as rules — `openwiki/` is listed
there as the generator-owned, OKF-formatted knowledge wiki, deliberately kept outside the human-owned
`docs/` so that "everything under `openwiki/` may be regenerated by a tool, everything under `docs/`
is human-owned" stays enforceable. The document is a derived summary target, not a copy: read the
source for the diagrams, the principle text and the version history.

## How the sole accepted exception is actually enforced

One clause of the document is enforced by a machine as well as by review. The v2.5.0 accepted
exception to the 2-second performance rule is bounded by a committed **2,000,000-byte** budget that
[`scripts/check-web-bundle-budget.mjs`](../../scripts/check-web-bundle-budget.mjs) enforces over the
exported web bundle through the `bundle-budget` Nx target on every affected change. Feature 087 moved
what that number measures: it now applies to the **cold-load total** — the sum of every script the
worst page loads, read from the exported HTML — because a split bundle can fit chunk by chunk and
still be too big to load, where before it capped the `entry-*` chunk alone. On the SDK 57 baseline the
cold-load total measured 1,892,065 B against the 2,000,000 B ceiling, on the worst of 17 exported
pages; feature 087's evidence table records 1,926,163 B (96.3%, 73,837 B spare) on the SDK 58 export,
so the remaining headroom is under one ordinary feature.

The constitution's own text has not caught up, and this is worth stating plainly rather than
smoothing over: the exception clause still reads as a committed maximum **on the web entry chunk**
and still cites the historical 1,762,630-byte figure, and feature 087's v2.8.0 amendment lists the
framework baseline, the BFF output line and the BFF Node line — not this clause. So the gate is
*stricter* than the line that authorises it, and a reader who wants to know what is enforced must
read [`scripts/check-web-bundle-budget.mjs`](../../scripts/check-web-bundle-budget.mjs) and
[`frontend/mcm-app/project.json`](../../frontend/mcm-app/project.json), not the principle's exception
text.

That gate is also what keeps the exception bounded rather than a repeal: alongside the byte ceiling
it fails a deferred assistant-runtime package that reappears in the entry chunk, any server-only
module in any client chunk, and any inline script the content-security-policy allowlist would block.

```mermaid
flowchart TD
  A["expo export --platform web --source-maps"] --> B["read the exported HTML plus every chunk source map"]
  B --> C{"cold-load total of the worst page within budget"}
  B --> D{"deferred assistant packages absent from the entry chunk"}
  B --> E{"server-only modules absent from every client chunk"}
  B --> F{"inline scripts on the CSP allowlist"}
  C -->|"no"| G["FAIL exit 1, naming the page, bytes and overage"]
  D -->|"no"| G
  E -->|"no"| G
  F -->|"no"| G
  C -->|"yes"| I["OK exit 0"]
  D -->|"yes"| I
  E -->|"yes"| I
  F -->|"yes"| I
```

What the `bundle-budget` gate reads and what each of its four assertions reports.

Two lists in the gate are where the principle's lazy-loading clause and the server-only boundary are
actually expressed, so both are extension points a change may need to touch. `DEFERRED_PACKAGES`
names the assistant runtime's packages — `zod`, `graphql`, `@copilotkit/`, `@ag-ui/`, `rxjs`,
`@bufbuild/protobuf` and the React Native polyfills — which must stay out of the entry chunk;
`SERVER_ONLY` names `src/bff-server/` and `luxon`. The escape hatch beside them, `SERVER_ONLY_EXEMPT`,
is **empty by design**: item #566 moved the only entry (the browser's axios transport to the BFF,
which had been sitting under a server-named directory) to the Utils-Layer, so `src/bff-server/` now
means server-only without exception. The mechanism is kept rather than deleted because a future
genuine case is likely, but it is deliberately two-sided: a future entry there must be paired with a
`@client-safe: <reason>` marker in the module itself, which
[`scripts/check-no-server-imports.mjs`](../../scripts/check-no-server-imports.mjs) reads — one without
the other is an unexplained hole in whichever gate lacks it.

Three details decide whether the gate is trustworthy. Its inline-script allowlist is the very
`INLINE_SCRIPT_HASHES` list the CSP is built from in
[`frontend/mcm-app/web-security-headers.js`](../../frontend/mcm-app/web-security-headers.js), read
through `createRequire` so the two cannot disagree: the gate hashes a new inline script exactly as
the browser would, fails it offline, and prints the hash the reviewed list would need rather than
granting permission to add it. The Nx target runs the gate with `--require-maps`, so an export that
stopped emitting source maps fails loudly instead of silently narrowing the check to the byte budget
alone. And the web performance E2E keeps its own transferred-JS ceiling in step with the same byte
figure, so the two gates cannot disagree about what "too big" means. The gate is itself guarded:
`--selftest` proves the fail and clean paths on synthetic trees, and
[`scripts/__tests__/check-web-bundle-budget.test.mjs`](../../scripts/__tests__/check-web-bundle-budget.test.mjs)
covers the cases where a plausible gate reports clean and should not — no entry chunk, two entry
chunks, a deferred package back in the entry chunk, server code in the deferred chunk, a missing
source map, and the split-bundle and inline-script cases feature 087 added.

## Gotchas

- **A spec or plan may deviate from itself and self-correct; a deviation from the constitution
  requires explicit human approval and documented rationale.** This is the one asymmetry in the
  [spec-driven-development lifecycle](./spec-driven-development.md) — an AI assistant
  encountering an apparent conflict between a task and the constitution must stop and ask, not
  silently pick one.
- **"No Vibe Coding" is a named, load-bearing constraint**: the assistant must consult the current
  `plan.md`/`spec.md` before writing code — deviations require documentation and approval, mirroring
  the constitution's own amendment discipline.
- **The IdP boundary is a hard trust line, not a suggestion.** The constitution requires the
  application to treat a validated JWT as proof the identity provider already evaluated Conditional
  Access and MFA — the application must never re-implement or re-check those, only validate token
  signature/claims. This boundary is the constitutional basis for the enforcement split described in
  [Authentication and authorization chain](../invariants/auth-chain.md).
- **"Behavior-Descriptive Identifiers" bans requirement IDs (FR-###, SC-###, T-###) from code
  identifiers** — they belong in a traceability comment, not a file/function/type name — because a
  reader should understand an artifact's purpose from its name alone. The one explicit exception is
  the traceability comment itself, which records provenance a reader can't derive from the code.
- **Constitution changes are rare and deliberate** — the version history at the top of the file is the
  fastest way to see what changed and why before assuming a principle still reads the way you
  remember it; do not rely on a cached mental model of an old version. The `[CURRENT]` marker on that
  history block is the version signal; a page (or a task list, or a plan) that names an older version
  is describing the past.
- **An "accepted exception" is bounded and scoped, never a quiet repeal.** v2.5.0 recorded exactly one
  for the mcm-app web client's cold load, whose measured Slow-3G time-to-interactive cannot meet the
  2-second figure on a React-Native-Web + Tamagui stack, and it stands unchanged through v2.8.0 —
  those amendments touch stack guidance only. It is capped by a committed 2,000,000-byte budget — the
  entry chunk that clause cites measured 1,762,630 B when the exception was recorded, 1,891,678 B on
  the SDK 57 baseline, and the cold-load total the gate now measures was 1,892,065 B there and
  1,926,163 B on the SDK 58 export — so the headroom is roughly one ordinary feature, and shrinking.
  It covers residual framework weight only (the same principle's lazy-loading clause stays in force
  and is CI-enforced), and it applies to that one client's cold load and nothing else — every other
  page and app still carries the 2-second rule. Growth past the budget is a failure, not a further
  exception; raising the budget is a deliberate act. The gate that enforces all of this is described
  above.
- **The byte ceiling measures the cold-load total, not the entry chunk — and the constitution's own
  wording and figures have not caught up.** The exception clause still reads as a maximum on the web
  entry chunk, but feature 087 repointed `--budget` at the sum of every script the worst exported page
  loads, because a split bundle can fit chunk by chunk and still be too big to load; and the v2.8.0
  amendment it landed covers the framework baseline, the BFF output line and the BFF Node line, not
  this clause. The clause's byte figures are historical too: the entry chunk it cites at 1,762,630
  bytes measured 1,891,678 B on the SDK 57 baseline. When you need to know what the gate actually
  enforces, read
  [`scripts/check-web-bundle-budget.mjs`](../../scripts/check-web-bundle-budget.mjs) and
  [`frontend/mcm-app/project.json`](../../frontend/mcm-app/project.json), not the principle's
  exception text.
- **A line can break for a reason that is neither a version number nor a library.** The
  **Backend-for-Frontend** line described a *mechanism* — `app.json` web output set to server,
  `"output": "server"` — and that mechanism changed meaning on Expo SDK 58, where the literal text
  would mean per-request rendering rather than prerendered pages plus API routes. Feature 087's
  **FR-024** therefore amended both the framework baseline and this line in the same pull request as
  the SDK move (target and result **v2.8.0**). An upgrade plan must sweep the whole stack section, not
  just the lines whose text contains a version number.
- **A version the constitution names can itself be stale, so the named line is not proof of what
  runs.** v2.7.0 had to record that the document-database image it had named since before
  (`8.2.6-ubuntu2204-slim`) was never the image the stacks ran — `8.0.8-ubi9` was — before advancing
  the line to `9.0-ubi9`. v2.8.0 did the same thing one level down: the BFF API line had been naming
  `node:24.14.1-alpine3.23` while the image built on `24.22.1`. And the correction was partial — the
  Frontend stack's own `JavaScript Runtime` line still reads `Node.js Latest LTS (v24.14.1)`, whereas
  the repository's enforced requirement is the `engines.node` floor in the root manifest (`>=22.13`,
  read by [`scripts/check-toolchain-consistency.mjs`](../../scripts/check-toolchain-consistency.mjs)
  against every workflow and Dockerfile pin), CI pins 24.19.0 and the BFF image 24.22.1. Compare a
  version-named line against the manifest, the compose files and the lockfile before treating it as
  the deployed truth; the changelog entry is where a correction of that kind gets recorded.
- **A tag-named line and a digest-pinned deployment are not the same claim.** The constitution names
  `mongodb/mongodb-community-server:9.0-ubi9`; the compose files pin that tag to a digest that is
  re-resolved whenever upstream rebuilds the image (twice since v2.7.0 — the production cutover ran
  `sha256:2cb58a8d…`, the current pin is `sha256:3d40c6fa…`, both the same mongod 9.0.4). A digest
  refresh is image maintenance and needs no amendment; only a change to the named tag does — and a
  same-version rebuild can still change what the gate sees, since the `3d40c6fa…` UBI 9.8 rebuild
  shipped a fixed `ca-certificates` and discharged the `CVE-2026-114406` allowlist entry. Read the
  compose file, not just the constitution line, when you need to know the exact bytes that run.
- **The document carries more than principles — it also carries stack baselines, the directory tree
  and the architecture diagrams**, so a "principle doesn't apply to me" reading is usually wrong: the
  per-stack sections bind language, framework, data-access library, container image, and even naming
  convention. Where a project legitimately cannot comply, the route is an amendment (or a scoped,
  bounded exception like the one above), not a local convention. See the per-surface pages —
  [Expo/React Native universal app](../projects/expo-app.md), [the BFF](../projects/bff.md),
  [mc-service](../projects/mc-service.md), [Agent Gateway](../projects/agent-gateway.md) — and the
  [repository layout](../projects/repository.md) it prescribes.
- **Only a stack element named *with a version* forces an amendment when it moves.** The frontend
  stack section names Tamagui and `@mcm/design-system` as the UI/styling engine but pins no version
  for it, so a Tamagui major is not a constitutional change; the version-named lines — the Expo SDK
  and native runtime, the database and runtime images, the toolchain — are. Read the line before
  assuming an amendment is required, and before assuming it is not. "No version named" does not mean
  "no version discipline" either: feature 081 pinned Tamagui to one exact version across both
  workspace manifests and added
  [`scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`](../../scripts/__tests__/tamagui-version-lockstep.guard.test.mjs),
  which fails on a range, on the two manifests disagreeing, on a second resolved `@tamagui/core` or
  `@tamagui/web`, on a leftover v2 Babel plugin reference, and on a Renovate rule that would let the
  bot propose only half of the set — the constraint the constitution declines to state is still
  enforced, just somewhere else.
- **An unversioned line can still carry a behavioural claim, and that claim can be false without the
  line being version-stale.** The same "UI / Design System" line says Tamagui is "wired runtime-only
  by default (the Tamagui babel/metro compiler plugins are optional optimisations)" — which was
  inaccurate from feature 015 onward, because that feature enabled `@tamagui/babel-plugin`. Feature
  081 US10 restored the line's accuracy *by code*, not by amendment: Tamagui 3 removed that Babel
  plugin, and its replacement, `@tamagui/metro-plugin` 3.0.x, was measured to lower some web modules
  to static class names **without emitting their CSS** (lost gaps, widths, radii) while saving no
  bytes — 1,881,353 B with it versus 1,881,066 B without, against the 2,000,000 B budget. So no
  compiler is wired and [`frontend/mcm-app/babel.config.js`](../../frontend/mcm-app/babel.config.js)
  runs no Tamagui plugin. A constitutional line can be wrong about *behaviour* as well as about a
  version; check the config, not only the version numbers.
- **A named library can be aspirational — the amendment history is not a description of the running
  system.** The Backend Services stack section requires `medi-rs` to route commands, queries and
  events from the API layer to the application-layer handler, but `backend/mc-service` ships no
  mediator crate: `router::build()` constructs one handler per operation over the repository traits
  and packs them into `AppState`, so dispatch is a plain method call on that struct. The divergence
  is recorded in [`docs/MCM-Architecture.md`](../../docs/MCM-Architecture.md) as a tracked backlog
  item, not as an amendment — so a stack line can be out of step with the shipped code while the
  version history reads as current. Read the manifest and the router before treating a named library
  as present; see [mc-service](../projects/mc-service.md) for the shipped dispatch shape.

Full text, every principle, and the complete version history:
[`.specify/memory/constitution.md`](../../.specify/memory/constitution.md); the amendment procedure
is the document's [Governance section](../../.specify/memory/constitution.md#governance). For how the
principles are enforced per stack, see
[Testing tiers and what gates a merge](../invariants/testing-tiers.md) and
[Secrets management](../invariants/secrets-management.md); for the web client the exception applies
to, see [Expo/React Native universal app](../projects/expo-app.md).
