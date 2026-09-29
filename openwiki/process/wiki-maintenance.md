---
type: Process
title: OpenWiki bundle generation and maintenance
description: How this openwiki/ knowledge bundle is generated, refreshed and gated — the wiki-update and okf-lint Nx targets (with wiki-plan / wiki-maintain / okf-governance around them), the non-scheduled freshness model, and what the conformance gate actually enforces and refuses to enforce.
resource: infrastructure-as-code/project.json
tags: [openwiki, okf, documentation, ci]
sources:
  - id: openwiki-source-7e1c4d46c53be9bf32311e06
    resource: repo://.devcontainer/toolchain.Dockerfile
  - id: openwiki-source-fd77a504cc309a02ead6fecf
    resource: repo://.forgejo/workflows/guardrails.yml
  - id: openwiki-source-36295b95c290f53e6f6e79a7
    resource: repo://.forgejo/workflows/wiki-maintain.yml
  - id: openwiki-source-c231cd090281b3129aaf6167
    resource: repo://docs/runbooks/wiki-maintenance.md
  - id: openwiki-source-5731c4a4c76f88db8cc6fb40
    resource: repo://infrastructure-as-code/project.json
  - id: openwiki-source-ef3e1dc36da7e40bc6a337f5
    resource: repo://scripts/__tests__/wiki-maintain.guard.test.mjs
  - id: openwiki-source-98792bbc9621de1ad3e22856
    resource: repo://scripts/check-openwiki-governance.mjs
  - id: openwiki-source-ccaf212e2940e782eb0de272
    resource: repo://scripts/check-openwiki-okf.mjs
  - id: openwiki-source-d6ba69382020a933bb1c9de0
    resource: repo://scripts/openwiki-stamp.mjs
  - id: openwiki-source-f7de3a4f5f1323dd23a0c681
    resource: repo://scripts/wiki-generate.mjs
  - id: openwiki-source-e3418ba4f663de6f0edbcde6
    resource: repo://scripts/wiki-maintain.mjs
  - id: openwiki-source-e328f529714691b0e8346a1c
    resource: repo://specs/043-openwiki-okf/contracts/check-openwiki-okf-cli.md
  - id: openwiki-source-8591439162d997daf59a1ac6
    resource: repo://specs/043-openwiki-okf/data-model.md
  - id: openwiki-source-219168cc26e2918922e603f9
    resource: repo://specs/043-openwiki-okf/spec.md
  - id: openwiki-source-d84a0e2ffc6b200e673e575c
    resource: repo://specs/044-openwiki-automation-migration/data-model.md
  - id: openwiki-source-636b4e73e33915c86a84ab68
    resource: repo://specs/044-openwiki-automation-migration/spec.md
generated: { by: "openwiki/0.6.0", at: "2026-09-29T10:29:14.990Z" }
---

# OpenWiki bundle generation and maintenance

This wiki (feature `043-openwiki-okf`) is generated and refreshed by
`pnpm nx wiki-update infrastructure-as-code`, whose command is `node scripts/wiki-generate.mjs` — a
launcher that resolves the provider, maps its credential at the point of use, and then spawns
`openwiki code --update --print` with a required telemetry opt-out and a raised Node heap size baked
into the Nx target's environment; the bare CLI omits both and reliably OOMs on this repo.
`pnpm nx okf-lint infrastructure-as-code` then runs the repository conformance gate
(`scripts/check-openwiki-okf.mjs`) over the bundle.

Around that pair sit three more targets on the same project. `pnpm nx wiki-plan infrastructure-as-code`
is offline, keyless and free: it decomposes the documentation changes since the last recorded run into
bounded slices (at most 8 pages, one bundle area each) and prints them, so a paid run is reviewable
before it happens. `pnpm nx wiki-maintain infrastructure-as-code` is the paid execution path. `pnpm nx
okf-governance infrastructure-as-code` runs the second, newer gate
(`scripts/check-openwiki-governance.mjs`) over the regeneration policy, the protection fingerprints and
the index. The operator runbook for all of it is `docs/runbooks/wiki-maintenance.md`; this page is the
summary of what the machinery guarantees and where it is easy to be misled.

Scope and redaction rules for generation are hand-authored in `openwiki/INSTRUCTIONS.md`, which the
tool reads on every run but never rewrites. Two sibling files beside it are in the same position —
`openwiki/policy.yaml` (the per-path regeneration policy) and `openwiki/protected.yaml` (the protection
manifest) — and all three are declared `never-written`, because a process must not be able to rewrite
the file that constrains it.

## Gotchas

- **There is no scheduled maintenance job — freshness is event-driven, not periodic.** On a feature
  branch it comes from folding `pnpm nx wiki-update infrastructure-as-code` into the existing
  feature-completion checklist — every feature is expected to refresh the wiki (a no-op refresh is
  valid) and then pass `okf-lint` before being considered complete; see the
  [feature validation checklist](../invariants/feature-validation-checklist.md). On `main` it comes
  from `.forgejo/workflows/wiki-maintain.yml` (feature 044), which is **merge-triggered**: a push to
  `main` starts a run once `main` has been quiet for about fifteen minutes. Neither path has a
  `schedule:` trigger — no scheduled job, by design. (Feature 043's original scope also added no CI
  credential; that no longer holds: the workflow carries its own keys, `ANTHROPIC_API_WIKI_MAINTAIN`
  and `FIREWORKS_API_WIKI_MAINTAIN`.) The workflow is also **never a required context**, so a paid
  and occasionally slow documentation job cannot gate an unrelated merge.
- **Always invoke through the Nx target, never the bare `openwiki` CLI.** See
  [Nx as the task runner](../invariants/nx-task-runner.md) — the target sets
  `OPENWIKI_TELEMETRY_DISABLED=1` (the tool reports usage telemetry to a third-party host by default,
  which the dev container's egress allowlist would block but the Windows host would not) and raises
  `NODE_OPTIONS` heap size to avoid the OOM. `DO_NOT_TRACK=1` is set beside it, and one further
  variable is load-bearing rather than cosmetic: `OPENWIKI_MAX_OUTPUT_TOKENS=16384`. A per-turn output
  cap that is unset or too small truncates a turn *before* it opens a tool call, which is exactly the
  model loop's stop condition — the run then exits 0 having written nothing
  (`scripts/__tests__/wiki-maintain.guard.test.mjs` fails an unset or too-small cap, a model id the
  generator's own resolver does not match, and any id that would land on the old 4096 fallback).
  `scripts/wiki-generate.mjs` refuses to start without that cap, so a direct script invocation is not a
  way around it either, and a run message must travel in `WIKI_RUN_MESSAGE` rather than `nx --args`,
  which strips its quoting and leaves the run unscoped. For the same reason the target runs
  `--update`, never `--init`.
- **The conformance gate is fail-closed with no opt-out.** An absent, empty, or partially-written
  bundle is a violation, not a vacuous pass — there is no skip flag. This mirrors the same
  fail-closed posture other repository gates use (see
  [Secrets management](../invariants/secrets-management.md)) and was a deliberate choice: a
  gate that passes when its subject is missing is exactly the failure mode that let an entire test
  tier rot silently for a month before a different feature caught it.
- **The gate is offline and keyless by design.** Repository-relative `resource` links are resolved
  against the working tree and fail the gate when the target is missing; external links are only
  checked for well-formedness, never fetched — so the always-on guardrails job cannot fail because a
  third-party host happens to be down. `okf-governance` has the identical posture, and both run as
  steps of the same always-on `okf` CI job, each preceded by its own `--selftest` so a rule that
  silently stopped detecting its case turns the build red.
- **Drift detection is report-only, never blocking.** If a concept's cited source changed after the
  concept's stamp — the newest of `generated.at`, `verified.at` and `timestamp`
  (`scripts/openwiki-stamp.mjs`) — the gate lists it as a warning but does not fail the build — regenerating
  a concept is a manual, model-cost step, so a blocking drift check would gate every unrelated
  documentation edit on a paid run. Two consequences worth knowing: drift is not an input to the
  planner, so nothing re-plans a concept once the run-record marker has passed its source change; and
  a concept that cites a source but carries no usable stamp is counted and printed rather than
  silently dropped, because drift coverage that shrinks quietly still prints as conformant.
- **`docs/proposals/**` is deliberately excluded from the bundle** — see
  [Spec-driven development](./spec-driven-development.md) for why, and where the one
  process concept documenting that lifecycle lives instead.
- **This page and its siblings are themselves generated content** — do not hand-edit generated
  concept pages outside an OpenWiki run unless explicitly asked; prefer updating the source
  documentation or code and letting the next `wiki-update` regenerate the affected pages. Hand-editing
  a derived summary is how a concept starts becoming a drifting copy of its source.
- **A durable learning goes to the canonical home of its subject.** Find the concept covering the
  subject, then read its front matter: **carrying a `resource`** means it is a derived summary, and the
  learning belongs in the cited source (runbook, decision record, architecture document); **no
  `resource`** means it is authoritative — listed under `authoritative:` in `openwiki/protected.yaml` —
  and the learning belongs **in the concept itself**. `openwiki/INSTRUCTIONS.md` §7 is the full rule,
  and `okf-governance` enforces the classification in both directions: a concept that is neither a
  resolving derived summary nor a listed authoritative one fails the gate. Nothing here changes
  `CLAUDE.md`, which is an index into the bundle and is gated against re-growth.
- **The generator's own account of a run is never trusted.** `wiki-maintain` verifies each slice by the
  pages that actually landed in the working tree, by bundle conformance and by whether policy permitted
  every written path — never by the generator's exit status, which was measured at exit 0 after twelve
  minutes of paid work that wrote a single `index.md`. Its own exit codes follow from that: `1` is a
  slice that failed verification, `2` is bad usage or a missing credential, and **`3` means the run
  stopped at its page or wall-clock budget with work carried forward — it is not a failure.** The
  numbers behind those budgets live as constants in `scripts/wiki-maintain.mjs`, not in prose: change
  one and a guard test fails offline because it derives the CI job's timeout from the same constants.
- **Neither budget is a monetary bound.** OpenWiki reports no token or cost figure of its own; a run's
  usage is captured by a tap and recorded, but nothing enforces a spend ceiling, and the wall-clock
  budget exists to bound occupancy of the shared CI runner. Do not describe these as cost controls.
- **Mermaid diagrams degrade silently without their parser.** From OpenWiki 0.5.0 diagrams are embedded
  by default and every fence is validated after a run; the real `mermaid` parser and `jsdom` are
  optional peer dependencies, and without them a diagram that fails the strict check is rewritten in
  place into a plain `text` fence while the run still exits 0 and every gate still passes. Both are
  installed beside the generator in the toolchain image *and* in the wiki workflow, and a guard test
  asserts the two lists match — if only one environment has the parser, the two disagree about what a
  valid diagram is and the one that writes the bundle wins.
- **Rejected content is fixed in the brief, never allowlisted.** If a page trips the conformance gate,
  the governance gate or a leak scan, the surface that changes is `openwiki/INSTRUCTIONS.md`, followed
  by a regeneration. The gates deliberately have no skip flag and no allowlist, because an allowlisted
  leak stays leaked. Legitimately changing a fingerprinted passage means updating the text **and** its
  fingerprint in the same change: `node scripts/check-openwiki-governance.mjs --fingerprint
  openwiki/<area>/<page>.md "<heading>"`.

Full CLI contract and the conformance gate's rule set: `specs/043-openwiki-okf/contracts/` and
`specs/043-openwiki-okf/data-model.md` (rules V1–V15, the last two added for item #491 after `resource`
verification alone proved insufficient); the maintenance machinery's contract is
`specs/044-openwiki-automation-migration/contracts/`. Day-to-day
invocation notes live in `docs/runbooks/devcontainer.md`, the operator runbook is
`docs/runbooks/wiki-maintenance.md`, and the corrections note is in `CLAUDE.md`'s OpenWiki section.
