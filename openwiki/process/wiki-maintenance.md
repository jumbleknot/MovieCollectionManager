---
type: Process
title: OpenWiki bundle generation and maintenance
description: How this openwiki/ knowledge bundle is generated, updated, and gated — the wiki-update and okf-lint Nx targets, the manual (non-scheduled) freshness model, and what the conformance gate actually enforces.
resource: infrastructure-as-code/project.json
tags: [openwiki, okf, documentation, ci]
timestamp: 2026-07-26T20:11:56+00:00
---

# OpenWiki bundle generation and maintenance

This wiki (feature `043-openwiki-okf`) is generated and refreshed by
`pnpm nx wiki-update infrastructure-as-code`, which runs `openwiki code --update --print` with a
required telemetry opt-out and a raised Node heap size baked into the Nx target's environment — the
bare CLI omits both and reliably OOMs on this repo. `pnpm nx okf-lint infrastructure-as-code` then
runs the repository conformance gate (`scripts/check-openwiki-okf.mjs`) over the bundle.

Scope and redaction rules for generation are hand-authored in `openwiki/INSTRUCTIONS.md`, which the
tool reads on every run but never rewrites.

## Gotchas

- **There is no scheduled maintenance job.** Freshness comes entirely from folding
  `pnpm nx wiki-update infrastructure-as-code` into the existing feature-completion checklist — every
  feature is expected to refresh the wiki (a no-op refresh is valid) and then pass `okf-lint` before
  being considered complete. This was a deliberate scope decision (phases 0–2 only of the adoption
  plan): no scheduled job, no new CI credential.
- **Always invoke through the Nx target, never the bare `openwiki` CLI.** See
  [Nx as the task runner](/openwiki/invariants/nx-task-runner.md) — the target sets
  `OPENWIKI_TELEMETRY_DISABLED=1` (the tool reports usage telemetry to a third-party host by default,
  which the dev container's egress allowlist would block but the Windows host would not) and raises
  `NODE_OPTIONS` heap size to avoid the OOM.
- **The conformance gate is fail-closed with no opt-out.** An absent, empty, or partially-written
  bundle is a violation, not a vacuous pass — there is no skip flag. This mirrors the same
  fail-closed posture other repository gates use (see
  [Secrets management](/openwiki/invariants/secrets-management.md)) and was a deliberate choice: a
  gate that passes when its subject is missing is exactly the failure mode that let an entire test
  tier rot silently for a month before a different feature caught it.
- **The gate is offline and keyless by design.** Repository-relative `resource` links are resolved
  against the working tree and fail the gate when the target is missing; external links are only
  checked for well-formedness, never fetched — so the always-on guardrails job cannot fail because a
  third-party host happens to be down.
- **Drift detection is report-only, never blocking.** If a concept's cited source changed after the
  concept's own `timestamp`, the gate lists it as a warning but does not fail the build — regenerating
  a concept is a manual, model-cost step, so a blocking drift check would gate every unrelated
  documentation edit on a paid run.
- **`docs/proposals/**` is deliberately excluded from the bundle** — see
  [Spec-driven development](/openwiki/process/spec-driven-development.md) for why, and where the one
  process concept documenting that lifecycle lives instead.
- **This page and its siblings are themselves generated content** — do not hand-edit generated
  concept pages outside an OpenWiki run unless explicitly asked; prefer updating the source
  documentation or code and letting the next `wiki-update` regenerate the affected pages.

Full CLI contract and the conformance gate's rule set: `specs/043-openwiki-okf/contracts/` and
`specs/043-openwiki-okf/data-model.md`; day-to-day invocation notes live in
`docs/runbooks/devcontainer.md` and the corrections note in `CLAUDE.md`'s OpenWiki section.
