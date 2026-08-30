# Implementation Plan: Infra-image version pins

**Branch**: `063-infra-image-version-pins` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/063-infra-image-version-pins/spec.md`

## Summary

Replace eight floating third-party image references with version tags that resolve to the **identical
digests already running**, then configure Renovate so updates to them are classified and grouped
correctly, and re-key the suppressions that are currently un-dischargeable. The migration is
notational: CI proves it by running the same images it ran before.

## Technical Context

**Language/Version**: JSON/YAML configuration plus Node 24 guard tests (`node:test`). No application
code changes.

**Primary Dependencies**: Renovate 44 (`npx renovate@44`, pinned to major in
`.forgejo/workflows/renovate.yml`); Docker Compose file format; Trivy via the infra-image scan.

**Storage**: N/A.

**Testing**: `scripts/__tests__/renovate-workflow.guard.test.mjs` (resolved package-rule behaviour),
`scripts/__tests__/infra-image-scan.test.mjs` (reference enumeration and floating classification),
`node scripts/check-infra-image-findings.mjs` (the CVE gate), `infra-image-scan / infra-image-scan` in CI.

**Target Platform**: Forgejo Actions on the single self-hosted runner; local Docker Compose stacks.

**Project Type**: Infrastructure/configuration change within the existing monorepo.

**Performance Goals**: N/A — no runtime behaviour changes.

**Constraints**: Content-neutral (FR-002). Must not extend the floating-tag classifier merely to
quieten its output (spec edge cases, research R4). Paired references must move together (FR-005).

**Scale/Scope**: 8 image references across 6 compose files, 1 Renovate config, 1 allowlist, 2 guard
test files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Assessment |
|---|---|---|
| **AI Assistant Constraints** | Yes | Change is scoped to the spec; no unrelated refactoring. |
| **Security (NON-NEGOTIABLE)** | **Yes — the point of the feature** | Improves posture: makes suppressions dischargeable (FR-007) and restores risk classification on updates (FR-003). Content-neutral, so it introduces no new image. No secrets touched; all images are public. |
| **Test-Driven Development (NON-NEGOTIABLE)** | Yes | Every behaviour change gets a RED-first guard assertion. `tasks.md` must carry Verify RED / Verify GREEN per the mandated checkpoint format. |
| **Test Type Integrity** | Yes | These are unit tests over configuration resolution — no external dependency is mocked, because none is called. Digest equivalence (SC-002) is verified against the **real** registry, not a fixture. |
| **Docker-Native Operations** | Yes | Compose files remain the local development contract; only the image reference form changes. |
| **Logging & Monitoring** | No | No runtime code paths. |
| **Backend/Frontend/Agent principles** | No | No application code. |

**Gate result: PASS.** No violations, so Complexity Tracking is omitted.

**Post-Phase-1 re-check: PASS.** The design adds no new component, introduces no new dependency, and
its one judgement call (research R4 — decline to widen the classifier) *strengthens* rather than
weakens a security check.

## Project Structure

### Documentation (this feature)

```text
specs/063-infra-image-version-pins/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── renovate-rules.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
infrastructure-as-code/docker/
├── keycloak/compose.yaml            # axllent/mailpit
├── bff/compose.yaml                 # (caddy — already versioned, untouched)
├── observability/compose.yaml       # otel-lgtm, opa:latest, unleash, curl, minio ×2
└── observability/compose.prod.yaml  # otel-lgtm, opa:latest-debug, unleash, curl, minio ×2

renovate.json                        # package rules + regex versioning for the date-tagged family
security/infra-images/allowlist.yaml # re-key floating suppressions (otel-lgtm, minio ×2)

scripts/
├── infra-image-scan.mjs             # NOT modified — see research R4
└── __tests__/
    ├── renovate-workflow.guard.test.mjs   # resolved group + update type per image
    └── infra-image-scan.test.mjs          # declared-exception count
```

**Structure Decision**: No new directories. The change edits existing compose files, the Renovate
configuration, the CVE allowlist, and the two guard suites that already own these invariants. The
scanner itself is deliberately **not** modified (research R4).

## Phase 2 approach (for `/speckit-tasks`)

Ordered so that each step is independently verifiable and a failure is unambiguous:

1. **Guard tests first (RED).** Assert the resolved group and update type per image, the paired-move
   requirement for `openpolicyagent/opa`, and the declared-exception count. These fail against today's
   configuration, which is what makes them tests rather than descriptions.
2. **Renovate configuration.** Package rules, `regex` versioning for the date-tagged family, and
   variant-tag exclusion. Turns the above GREEN without touching a compose file.
3. **Compose references.** The eight substitutions from research R1, applied per image family so a
   digest mismatch names one image rather than eight.
4. **Allowlist re-keying.** Version-key the suppressions that can be; record the reason for any that
   cannot.
5. **Verification.** Digest equivalence before/after (SC-002), then the full infra-image scan.

**Risk to sequence deliberately**: step 3 is the only step that can change what runs. Keeping it after
the configuration work means an unexpected CI failure at step 3 is attributable to the substitution
itself, not to rule changes made in the same commit.
