---
type: Decision
title: The governing constitution
description: The repository's ratified, versioned constitution — the immutable core principles for frontend, backend, and AI-agent development that every spec and plan must comply with, and the one class of change that requires human approval to violate.
resource: .specify/memory/constitution.md
tags: [governance, security, tdd, constitution]
timestamp: 2026-07-26T20:11:56+00:00
---

# The governing constitution

`.specify/memory/constitution.md` is the repository's single ratified source of core, supposedly
immutable principles — security, authentication/authorization boundaries, session management, TDD,
AI-assistant behavioral constraints, and per-stack technology baselines — governing Frontend Apps,
Backend Services, and AI Agents alike. It is versioned (semver-style, with a change log at the top
of the file) and has been amended over a dozen times as the system matured, from initial ratification
through incremental clarifications like the client auth model rewrite and the Tamagui design-system
mandate.

Notable principle areas: AI Assistant Constraints (behavior-descriptive identifiers, no vibe coding,
comments only for non-obvious rationale); Security (classification, PKCE-only auth via the BFF
pattern, IdP boundary for MFA/Conditional Access, deny-by-default authorization, server-side session
storage); and stack-specific standards layered on top for each of the three development surfaces.

## Gotchas

- **A spec or plan may deviate from itself and self-correct; a deviation from the constitution
  requires explicit human approval and documented rationale.** This is the one asymmetry in the
  [spec-driven-development lifecycle](/openwiki/process/spec-driven-development.md) — an AI assistant
  encountering an apparent conflict between a task and the constitution must stop and ask, not
  silently pick one.
- **"No Vibe Coding" is a named, load-bearing constraint**: the assistant must consult the current
  `plan.md`/`spec.md` before writing code — deviations require documentation and approval, mirroring
  the constitution's own amendment discipline.
- **The IdP boundary is a hard trust line, not a suggestion.** The constitution requires the
  application to treat a validated JWT as proof the identity provider already evaluated Conditional
  Access and MFA — the application must never re-implement or re-check those, only validate token
  signature/claims. This boundary is the constitutional basis for the enforcement split described in
  [Authentication and authorization chain](/openwiki/invariants/auth-chain.md).
- **"Behavior-Descriptive Identifiers" bans requirement IDs (FR-###, SC-###, T-###) from code
  identifiers** — they belong in a traceability comment, not a file/function/type name — because a
  reader should understand an artifact's purpose from its name alone. The one explicit exception is
  the traceability comment itself, which records provenance a reader can't derive from the code.
- **Constitution changes are rare and deliberate** — the version history at the top of the file is the
  fastest way to see what changed and why before assuming a principle still reads the way you
  remember it; do not rely on a cached mental model of an old version.

Full text, every principle, and the complete version history: `.specify/memory/constitution.md`.
