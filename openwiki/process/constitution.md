---
type: Decision
title: The governing constitution
description: The repository's ratified, versioned constitution — the immutable core principles for frontend, backend, and AI-agent development that every spec and plan must comply with, and the one class of change that requires human approval to violate.
resource: .specify/memory/constitution.md
tags: [governance, security, tdd, constitution]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-29T10:29:14.990Z
sources:
  - id: openwiki-source-bff475d8fa855e3592cfedc2
    resource: repo://.specify/memory/constitution.md
  - id: openwiki-source-baa6cf05f830f1fa193ef74c
    resource: repo://docs/templates/feature-test-tasks-template.md
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-3a1de6aca3cad41ffa6cd873
    resource: repo://scripts/check-web-bundle-budget.mjs
  - id: openwiki-source-4388ebe240b6b1a6c540d5c5
    resource: repo://specs/005-expo-sdk-56-upgrade/plan.md
generated: { by: "openwiki/0.6.0", at: "2026-09-29T10:29:14.990Z" }
---

# The governing constitution

`.specify/memory/constitution.md` is the repository's single ratified source of core, supposedly
immutable principles — security, authentication/authorization boundaries, session management, TDD,
AI-assistant behavioral constraints, and per-stack technology baselines — governing Frontend Apps,
Backend Services, and AI Agents alike. It is versioned (semver-style, with a change log at the top
of the file) and has been amended over a dozen times as the system matured, from initial ratification
through incremental clarifications like the client auth model rewrite and the Tamagui design-system
mandate.

The file currently reads **v2.5.0**, ratified 2026-03-08 and last amended 2026-09-26. The changelog
entry marked `[CURRENT]` is the authoritative "latest amendment" signal — check it rather than
inferring the version from any summary, this page included. Amendments follow the file's own
**Governance** section: a proposal documenting rationale, impact and a migration plan; review and
formal approval; a version bump (MAJOR for a principle change, MINOR for a guidance addition, PATCH
for a clarification); and alignment of existing code within one release cycle. The bump level is
informative, not decorative — v2.0.0 superseded the previous client auth model outright, while most
MINOR bumps add a principle area or a scoped exception without redefining anything.

Notable principle areas: AI Assistant Constraints (behavior-descriptive identifiers, no vibe coding,
comments only for non-obvious rationale); Security (classification, PKCE-only auth via the BFF
pattern, IdP boundary for MFA/Conditional Access, deny-by-default authorization, server-side session
storage); and stack-specific standards layered on top for each of the three development surfaces.

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
- **An "accepted exception" is bounded and scoped, never a quiet repeal.** v2.5.0 records exactly one
  for the mcm-app web client's cold load, whose measured Slow-3G time-to-interactive cannot meet the
  2-second figure on a React-Native-Web + Tamagui stack. It is capped by a committed entry-chunk byte
  budget enforced by `scripts/check-web-bundle-budget.mjs`, it covers residual framework weight only
  (the same principle's lazy-loading clause stays in force and is CI-enforced), and it applies to that
  one client's cold load and nothing else — every other page and app still carries the 2-second rule.
  Growth past the budget is a failure, not a further exception; raising the budget is a deliberate act.
- **The document carries more than principles — it also carries stack baselines and the directory
  tree**, so a "principle doesn't apply to me" reading is usually wrong: the per-stack sections bind
  language, framework, data-access library, container image, and even naming convention. Where a
  project legitimately cannot comply, the route is an amendment (or a scoped, bounded exception like
  the one above), not a local convention.

Full text, every principle, and the complete version history:
[`.specify/memory/constitution.md`](../../.specify/memory/constitution.md). For how the principles
are enforced per stack, see [Testing tiers and what gates a merge](../invariants/testing-tiers.md)
and [Secrets management](../invariants/secrets-management.md).
