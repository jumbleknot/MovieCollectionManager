---
type: Decision
title: The governing constitution
description: The repository's ratified, versioned constitution — currently v2.7.0, ratified 2026-03-08 and last amended 2026-10-20, with a v2.8.0 amendment (framework baseline plus the BFF output line) planned in feature 087 — the core principles for frontend, backend, and AI-agent development that every spec and plan must comply with, the one class of change that requires human approval to violate, and the `bundle-budget` gate that enforces its sole accepted exception.
resource: .specify/memory/constitution.md
tags: [governance, security, tdd, constitution]
sources:
  - id: openwiki-source-fddbbd0ed8c6150575261296
    resource: repo://.claude/skills/speckit-constitution/SKILL.md
  - id: openwiki-source-30724a7ef510bcfb76113f02
    resource: repo://.github/agents/speckit.constitution.agent.md
  - id: openwiki-source-bff475d8fa855e3592cfedc2
    resource: repo://.specify/memory/constitution.md
  - id: openwiki-source-40c6c36ebb2091923abbb4bf
    resource: repo://.specify/templates/plan-template.md
  - id: openwiki-source-d54b05966a54dbfbb9eb63bc
    resource: repo://backend/mc-service/Cargo.toml
  - id: openwiki-source-541e2287bdfb42c605c78f3f
    resource: repo://docs/MCM-Architecture.md
  - id: openwiki-source-27d785edc3cec2c27da82832
    resource: repo://docs/proposals/MCM-Expo-SDK-58-Approach.md
  - id: openwiki-source-a679e2e5a49381a72df446c5
    resource: repo://docs/runbooks/prod-data-tier-auth.md
  - id: openwiki-source-baa6cf05f830f1fa193ef74c
    resource: repo://docs/templates/feature-test-tasks-template.md
  - id: openwiki-source-30d3dc827bae5c1cb657fa31
    resource: repo://frontend/mcm-app/app.json
  - id: openwiki-source-82e76cb56a030095b60d27cd
    resource: repo://frontend/mcm-app/babel.config.js
  - id: openwiki-source-e9bcd4372a4632d555b861a6
    resource: repo://frontend/mcm-app/package.json
  - id: openwiki-source-1e9aa3ee99b35bd10ee52a6d
    resource: repo://frontend/mcm-app/project.json
  - id: openwiki-source-75c613635390ab18cc167ec1
    resource: repo://frontend/mcm-app/README.md
  - id: openwiki-source-8786d69652acad0c5349ef83
    resource: repo://frontend/mcm-app/tests/e2e/web/perf.spec.ts
  - id: openwiki-source-bbf78f164062a1cfdec73a0a
    resource: repo://frontend/mcm-app/web-security-headers.js
  - id: openwiki-source-03de7146fd7e33f2e3019d9d
    resource: repo://infrastructure-as-code/docker/bff/compose.prod.yaml
  - id: openwiki-source-4042a47526d6016cff835628
    resource: repo://infrastructure-as-code/docker/mc-service/compose.yaml
  - id: openwiki-source-f7e16ba323424b9790bca8b9
    resource: repo://packages/design-system/package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-3444864363efed8e40307b33
    resource: repo://scripts/__tests__/check-web-bundle-budget.test.mjs
  - id: openwiki-source-e1b32ed173a0f6b508f94a03
    resource: repo://scripts/__tests__/tamagui-version-lockstep.guard.test.mjs
  - id: openwiki-source-a3e2c14b6305b3709de7fcd4
    resource: repo://scripts/check-no-server-imports.mjs
  - id: openwiki-source-3a1de6aca3cad41ffa6cd873
    resource: repo://scripts/check-web-bundle-budget.mjs
  - id: openwiki-source-4708763005c35901b04f5740
    resource: repo://security/infra-images/allowlist.yaml
  - id: openwiki-source-4388ebe240b6b1a6c540d5c5
    resource: repo://specs/005-expo-sdk-56-upgrade/plan.md
  - id: openwiki-source-db3aa5ac2ffb577a529916ad
    resource: repo://specs/081-major-dependency-upgrades/plan.md
  - id: openwiki-source-2ffebe6972c17fbcc2a83423
    resource: repo://specs/081-major-dependency-upgrades/research.md
  - id: openwiki-source-f64018476db6cdad83959624
    resource: repo://specs/081-major-dependency-upgrades/spec.md
  - id: openwiki-source-2e26935bed37e1316dc175a0
    resource: repo://specs/081-major-dependency-upgrades/tasks.md
  - id: openwiki-source-16870c3ee3399a868ae59956
    resource: repo://specs/087-expo-sdk-58/contracts/web-gates.md
  - id: openwiki-source-ce98b17d342993a61a79a926
    resource: repo://specs/087-expo-sdk-58/plan.md
  - id: openwiki-source-cbc86a7a3a87453e949a2389
    resource: repo://specs/087-expo-sdk-58/spec.md
  - id: openwiki-source-93b6202dca9e48a643d50488
    resource: repo://specs/087-expo-sdk-58/tasks.md
generated: { by: "openwiki/0.7.1", at: "2026-11-02T10:14:55.121Z" }
verified:
  - by: openwiki/0.7.1
    at: 2026-11-07T19:02:58.048Z
---

# The governing constitution

`.specify/memory/constitution.md` is the repository's single ratified source of core, supposedly
immutable principles — security, authentication/authorization boundaries, session management, TDD,
AI-assistant behavioral constraints, and per-stack technology baselines — governing Frontend Apps,
Backend Services, and AI Agents alike. It is versioned (semver-style, with a change log at the top
of the file) and has been amended more than twenty times as the system matured, from initial
ratification through incremental clarifications like the client auth model rewrite and the Tamagui
design-system mandate.

The file currently reads **v2.7.0**, ratified 2026-03-08 and last amended 2026-10-20. The changelog
entry marked `[CURRENT]` is the authoritative "latest amendment" signal — check it rather than
inferring the version from any summary, this page included. Amendments follow the file's own
**Governance** section: a proposal documenting rationale, impact and a migration plan; review and
formal approval; a version bump (MAJOR for a principle change, MINOR for a guidance addition, PATCH
for a clarification); and alignment of existing code within one release cycle. The bump level is
informative, not decorative — v2.0.0 superseded the previous client auth model outright, while the
recent MINOR bumps add a principle area or a scoped exception, or move a version-named stack
baseline, without redefining anything.

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

The two most recent *ratified* amendments are the purest examples of the MINOR kind. **v2.6.0**
advanced the frontend stack baseline from Expo SDK 56 to Expo SDK 57 (with React Native 0.86 and
React 19.2).
**v2.7.0** advanced the document-database baseline to
`mongodb/mongodb-community-server:9.0-ubi9` (MongoDB 9.0 on Red Hat UBI 9) — and had to record
that the image the document had named until then, `8.2.6-ubuntu2204-slim`, was stale: `8.0.8-ubi9`
is what actually ran. Neither redefines a principle, and the same-PR rule governs both: a version
the document names is amended in the change that moves it, with human approval, never silently
afterwards. Feature 081 writes that requirement down as **FR-015** — where the constitution names a
version the feature changes (the platform SDK and native runtime, the document-database image), the
amendment must land in the same pull request as the change it authorises, with human approval.

The next amendment in flight shows that the line an upgrade breaks is not always the version-named
one. Feature 087 (Expo SDK 58) carries **FR-024**: the constitution must be amended to **v2.8.0** in
the same pull request as the version move, with human approval, advancing the framework baseline
(SDK 57 → 58, React Native 0.86 → 0.88, React 19.2 → 19.3) *and* rewriting the
**Backend-for-Frontend** line. That line's current text — `app.json` web output set to server,
`"output": "server"` — would, read literally on SDK 58, mean per-request rendering instead of the
prerendered pages plus API routes the feature requires; the proposal calls it out as the amendment
line that is easy to miss. The amendment is still an open task (`T048` of
[`specs/087-expo-sdk-58/tasks.md`](../../specs/087-expo-sdk-58/tasks.md)), so as of this writing the
file still reads v2.7.0 and [`frontend/mcm-app/app.json`](../../frontend/mcm-app/app.json) still says
`"output": "server"` — treat v2.8.0 as planned, not current.

The document-database line also shows the difference between a *tag* and a *digest*. The constitution
names the tag (`9.0-ubi9`); every compose reference pins that same tag by digest, currently
`9.0-ubi9@sha256:3d40c6fa…` — a UBI 9.8 rebuild of the same mongod 9.0.4. The pinned digest has been
re-resolved twice since v2.7.0 was ratified with no further constitution change: the 2026-10-24
production cutover ran `sha256:2cb58a8d…`, and the 2026-11-01 move to `sha256:3d40c6fa…` was a
same-version rebuild that shipped a fixed `ca-certificates` and so discharged the
`CVE-2026-114406` allowlist entry. Refreshing a digest inside a named tag is ordinary image
maintenance; moving the named tag is the amendment.

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

Compliance is operationalized per feature rather than left to review. Every `plan.md` carries a
**Constitution Check** gate — the wording in
[`.specify/templates/plan-template.md`](../../.specify/templates/plan-template.md) is *"GATE: Must
pass before Phase 0 research. Re-check after Phase 1 design."* — where each principle gets a row with
a status and how it is satisfied. Feature 081's plan is a worked example: the Expo SDK line and the
document-database image line are marked **AMENDMENT REQUIRED**, each naming the story that amends
it, while the Tamagui line is marked PASS because the constitution names that library but no version
of it. That gate is what turns "every spec and plan must comply" into a per-principle artefact a
reviewer can check.

Notable principle areas: AI Assistant Constraints (behavior-descriptive identifiers, no vibe coding,
comments only for non-obvious rationale); Security (classification, PKCE-only auth via the BFF
pattern, IdP boundary for MFA/Conditional Access, deny-by-default authorization, server-side session
storage); and stack-specific standards layered on top for each of the three development surfaces.

Beyond principles, the document carries the monorepo **directory tree** and the **architecture
diagrams** — the C4 container diagrams for the multi-frontend/multi-service layout and the additive
AI-agents layer, plus the three auth-flow sequence diagrams (login, backend resource access, agent
auth). Those diagrams are the canonical picture of BFF token custody and of the RFC 8693 agent token
exchange, which makes the constitution a design reference as well as a rulebook. The tree carries
approved deviations as well as rules — `openwiki/` is listed there as the generator-owned,
OKF-formatted knowledge wiki, deliberately kept outside the human-owned `docs/` so that "everything
under `openwiki/` may be regenerated by a tool, everything under `docs/` is human-owned" stays
enforceable. The document is a derived summary target, not a copy: read the source for the diagrams,
the principle text and the version history.

## How the sole accepted exception is actually enforced

One clause of the document is enforced by a machine as well as by review. The v2.5.0 accepted
exception to the 2-second performance rule is bounded by a committed **2,000,000-byte** budget that
[`scripts/check-web-bundle-budget.mjs`](../../scripts/check-web-bundle-budget.mjs) enforces over the
exported web bundle through the `bundle-budget` Nx target on every affected change. Feature 087 moved
what that number measures: it now applies to the **cold-load total** — the sum of every script the
worst page loads, read from the exported HTML — because a split bundle can fit chunk by chunk and
still be too big to load, where before it capped the `entry-*` chunk alone. On the SDK 57 baseline the
cold-load total measured 1,892,065 B against the 2,000,000 B ceiling, on the worst of 17 exported
pages. The constitution's own text still describes an entry-chunk maximum, and feature 087's pending
v2.8.0 amendment lists only the framework baseline and the BFF output line, so the gate is stricter
than the line that authorises it. That gate is what keeps the exception bounded rather than a repeal:
alongside the byte ceiling it fails a deferred assistant-runtime package that reappears in the entry
chunk, any server-only module in any client chunk, and any inline script the content-security-policy
allowlist would block.

Two lists in the gate are where the principle's lazy-loading clause and the server-only boundary are
actually expressed, so both are extension points a change may need to touch. `DEFERRED_PACKAGES` names
the assistant runtime's packages — `zod`, `graphql`, `@copilotkit/`, `@ag-ui/`, `rxjs`,
`@bufbuild/protobuf` and the React Native polyfills — which must stay out of the entry chunk;
`SERVER_ONLY` names `src/bff-server/` and `luxon`. The escape hatch beside them, `SERVER_ONLY_EXEMPT`,
is **empty by design**: item #566 moved the only entry (the browser's axios transport to the BFF,
which had been sitting under a server-named directory) to the Utils-Layer, so `src/bff-server/` now
means server-only without exception. The mechanism is kept rather than deleted because a future genuine
case is likely, but it is deliberately two-sided: a future entry there must be paired with a
`@client-safe: <reason>` marker in the module itself, which
[`scripts/check-no-server-imports.mjs`](../../scripts/check-no-server-imports.mjs) reads — one without
the other is an unexplained hole in whichever gate lacks it.

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

Three details decide whether the gate is trustworthy. Its inline-script allowlist is the very
`INLINE_SCRIPT_HASHES` list the CSP is built from in
[`frontend/mcm-app/web-security-headers.js`](../../frontend/mcm-app/web-security-headers.js), read
through `createRequire` so the two cannot disagree: the gate hashes a new inline script exactly as the
browser would, fails it offline, and prints the hash the reviewed list would need rather than granting
permission to add it. The Nx target runs the gate with `--require-maps`, so an export that stopped
emitting source maps fails loudly instead of silently narrowing the check to the byte budget alone.
And the web performance E2E keeps its own transferred-JS ceiling in step with the same byte figure, so
the two gates cannot disagree about what "too big" means. The gate is itself guarded: `--selftest`
proves the fail and clean paths on synthetic trees, and
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
  remember it; do not rely on a cached mental model of an old version.
- **An "accepted exception" is bounded and scoped, never a quiet repeal.** v2.5.0 recorded exactly one
  for the mcm-app web client's cold load, whose measured Slow-3G time-to-interactive cannot meet the
  2-second figure on a React-Native-Web + Tamagui stack, and it stands unchanged through v2.7.0 —
  those amendments touch stack guidance only. It is capped by a committed 2,000,000-byte budget — the
  entry chunk that clause cites measured 1,762,630 B when the exception was recorded, 1,891,678 B on
  the SDK 57 baseline, and the cold-load total the gate now measures is 1,892,065 B, so the headroom
  is roughly one ordinary feature rather than generous. It covers residual framework weight only (the
  same principle's lazy-loading clause stays in force and is CI-enforced), and it applies to that one
  client's cold load and nothing else — every other page and app still carries the 2-second rule.
  Growth past the budget is a failure, not a further exception; raising the budget is a deliberate
  act. The gate that enforces all of this is described above.
- **The byte ceiling now measures the cold-load total, not the entry chunk — and the constitution's own
  wording and figures have not caught up.** The exception clause still reads as a maximum on the web
  entry chunk, but feature 087 repointed `--budget` at the sum of every script the worst exported page
  loads, because a split bundle can fit chunk by chunk and still be too big to load; and the pending
  v2.8.0 amendment covers only the framework baseline and the BFF output line. The clause's byte
  figures are historical too: the entry chunk it cites at 1,762,630 bytes measured 1,891,678 B on the
  SDK 57 baseline. When you need to know what the gate actually enforces, read
  [`scripts/check-web-bundle-budget.mjs`](../../scripts/check-web-bundle-budget.mjs) and
  [`frontend/mcm-app/project.json`](../../frontend/mcm-app/project.json), not the principle's
  exception text.
- **The document carries more than principles — it also carries stack baselines, the directory tree
  and the architecture diagrams**, so a "principle doesn't apply to me" reading is usually wrong: the
  per-stack sections bind language, framework, data-access library, container image, and even naming
  convention. Where a project legitimately cannot comply, the route is an amendment (or a scoped,
  bounded exception like the one above), not a local convention. See the per-surface pages —
  [Expo/React Native universal app](../projects/expo-app.md),
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
  compiler is wired and `frontend/mcm-app/babel.config.js` runs no Tamagui plugin. A constitutional
  line can be wrong about *behaviour* as well as about a version; check the config, not only the
  version numbers.
- **A version the constitution names can itself be stale, so the named line is not proof of what
  runs.** v2.7.0 had to record that the document-database image it had named since before
  (`8.2.6-ubuntu2204-slim`) was never the image the stacks ran — `8.0.8-ubi9` was — before advancing
  the line to `9.0-ubi9`. Compare a version-named line against the compose files and the lockfile
  before treating it as the deployed truth; the changelog entry is where a correction of that kind
  gets recorded.
- **A tag-named line and a digest-pinned deployment are not the same claim.** The constitution names
  `mongodb/mongodb-community-server:9.0-ubi9`; the compose files pin that tag to a digest that is
  re-resolved whenever upstream rebuilds the image (twice since v2.7.0 — the production cutover ran
  `sha256:2cb58a8d…`, the current pin is `sha256:3d40c6fa…`, both the same mongod 9.0.4). A digest
  refresh is image maintenance and needs no amendment; only a change to the named tag does — and a
  same-version rebuild can still change what the gate sees, since the `3d40c6fa…` UBI 9.8 rebuild
  shipped a fixed `ca-certificates` and discharged the `CVE-2026-114406` allowlist entry. Read the
  compose file, not just the constitution line, when you need to know the exact bytes that run.
- **A line can break for a reason that is neither a version nor a library.** The
  **Backend-for-Frontend** line describes a *mechanism* — `app.json` web output set to server,
  `"output": "server"` — and that mechanism changes meaning on Expo SDK 58, where the literal text
  would mean per-request rendering rather than prerendered pages plus API routes. Feature 087's
  **FR-024** therefore amends both the framework baseline and this line in the same pull request as
  the SDK move (target **v2.8.0**). Until that PR merges, the file still reads v2.7.0 and
  [`frontend/mcm-app/app.json`](../../frontend/mcm-app/app.json) still says `"output": "server"`. An
  upgrade plan must sweep the whole stack section, not just the lines whose text contains a version
  number.
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
