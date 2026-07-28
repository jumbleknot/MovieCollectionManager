---
type: Process
title: OpenWiki bundle generation and maintenance
description: How this openwiki/ knowledge bundle is generated, updated, and gated — the wiki-update and okf-lint Nx targets, the drift/uncited-triggered (not per-feature) freshness model, and what the conformance gate actually enforces.
resource: infrastructure-as-code/project.json
tags: [openwiki, okf, documentation, ci]
timestamp: 2026-07-28T01:56:50+00:00
---

# OpenWiki bundle generation and maintenance

This wiki (feature `043-openwiki-okf`) is generated and refreshed by
`pnpm nx wiki-update infrastructure-as-code`, which runs `openwiki code --update --print` with a
required telemetry opt-out and a raised Node heap size baked into the Nx target's environment — the
bare CLI omits both and reliably OOMs on this repo. `pnpm nx okf-lint infrastructure-as-code` runs the
repository conformance gate (`scripts/check-openwiki-okf.mjs`) over the bundle; the same script's
`--check-coverage` flag is the free trigger that decides whether `wiki-update` needs to run at all
(see below).

Scope and redaction rules for generation are hand-authored in `openwiki/INSTRUCTIONS.md`, which the
tool reads on every run but never rewrites.

## Gotchas

- **There is no scheduled maintenance job, and regeneration is no longer unconditional per feature.**
  The feature-completion checklist runs `pnpm nx okf-lint infrastructure-as-code -- --check-coverage`
  first — a ~0.2 s check with no model call — and only runs `wiki-update` (a paid model run) if that
  reports drifted concepts or uncited canonical documents. This replaced an earlier "refresh every
  feature, a no-op is valid" rule: `.last-update.json` only advances when wiki content actually
  changes, so an unconditional run that finds nothing to document leaves a stale marker and the next
  run pays full model cost again, indefinitely. `--check-coverage` compares **committed** history, so
  uncommitted work is invisible to it and must be committed first. This was still a deliberate scope
  decision (phases 0–2 only of the adoption plan): no scheduled job, no new CI credential.
- **Coverage checking has two independent report-only signals, not one.** V12 drift compares a
  concept against its cited source's mtime, but a *newly added* runbook or ADR has no concept yet to
  compare against, so drift alone can never catch it. V14 (`--check-coverage`, opt-in) closes that gap
  by listing canonical documents under `docs/runbooks/`, `docs/decisions/`, and the architecture docs
  that no concept cites yet. Both are warnings only — neither fails the build — for the same reason:
  regenerating a concept is a manual, paid step, so a blocking check would gate every unrelated commit
  on a model run.
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
- **`docs/proposals/**` is deliberately excluded from the bundle** — see
  [Spec-driven development](/openwiki/process/spec-driven-development.md) for why, and where the one
  process concept documenting that lifecycle lives instead.
- **This page and its siblings are themselves generated content** — do not hand-edit generated
  concept pages outside an OpenWiki run unless explicitly asked; prefer updating the source
  documentation or code and letting the next `wiki-update` regenerate the affected pages.

Full CLI contract and the conformance gate's rule set: `specs/043-openwiki-okf/contracts/` and
`specs/043-openwiki-okf/data-model.md`; day-to-day invocation notes live in
`docs/runbooks/devcontainer.md` and the corrections note in `CLAUDE.md`'s OpenWiki section.
