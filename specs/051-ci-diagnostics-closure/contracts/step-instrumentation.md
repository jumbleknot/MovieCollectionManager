# Contract — step instrumentation coverage

**Governs**: FR-005, FR-006, FR-007, FR-008, FR-009 ·
**Enforcer**: `scripts/check-ci-digest-coverage.mjs` (runs in `guardrails / naming`)

## The rule this replaces

Today the gate asks, per **job**: does it publish a digest, and does it have **at least one** wrapped
step? One is enough. `guardrails / naming` passes with 2 of 16 steps wrapped — and neither of the two
is a gate. The job is fully compliant and completely undiagnosable.

## The rule

For every job in `.forgejo/workflows/`:

1. The job publishes a failure digest (unchanged).
2. **Every `run:` step is either wrapped with `scripts/ci-log-step.sh` or carries an explicit
   exemption marker with a stated reason.**

## Exemption markers — there are TWO, and they are not interchangeable

`check-ci-digest-coverage.mjs` enforces two independent rules and reads a **separate marker for
each**. Conflating them would silently disable one of the two gates, so they are specified here
explicitly:

| Marker | Opts out of | Meaning |
| --- | --- | --- |
| `# ci-digest-exempt: <reason>` | the **digest** rule | This job does not publish a failure digest at all |
| `# ci-log-step-exempt: <reason>` | the **capture** rule | This job has no step whose output is worth capturing |

Only the second is extended from job level to step level by this feature. The first is untouched and
must remain job-scoped — a *step* cannot opt a job out of publishing a digest.

Both already reject a marker with no reason (`…-exempt:` followed by nothing), and both must continue
to. The reason is the point: it is what a future reader needs to judge whether the exemption is still
valid.

**Test obligation**: the per-step work must assert the two markers stay independent — a
`ci-log-step-exempt` marker must not satisfy the digest rule, and a `ci-digest-exempt` marker must not
satisfy the capture rule.

### Legitimate exemptions, from the current tree

| Shape | Reason |
| --- | --- |
| Steps that run before `actions/checkout` | `scripts/ci-log-step.sh` does not exist on disk yet |
| The digest step itself | Wrapping the reporter in the thing it reports on is circular |
| `uses:`-only steps | No `run:` command, so no output to capture |

### Not a legitimate exemption

"It is only a setup step." `pnpm install --frozen-lockfile` failing on a lockfile mismatch, and
`apt-get install` failing on a mirror, are both recurring CI failure modes whose one-line cause is
exactly what this feature exists to surface.

## Measured starting point

48 of 83 `run:` steps across 14 containerized jobs are currently uninstrumented. The worst three:

| Job | `run:` steps | wrapped | unwrapped |
| --- | ---: | ---: | ---: |
| `guardrails / naming` | 16 | 2 | 13 |
| `guardrails / sast` | 11 | 1 | 9 |
| `wiki-maintain / maintain` | 11 | 2 | 8 |

## Prerequisite — the parser must be able to see the markers

The exemption mechanism this contract depends on **does not currently work on a carriage-return
checkout**: `parseExemptions` splits on `\n` and its marker pattern cannot match a line ending in
`\r`, so every exemption is invisible and correctly-exempt jobs report as uncovered. That is PRD §1.3
and research R8a. Story 7 fixes it, and Story 7 therefore runs **before** this contract is
implemented — a stricter per-step rule built on a reader that cannot see exemptions would be
unfixable by the very mechanism it offers as the escape hatch.

## Implementation constraints

1. **No new dependencies.** The gate runs in `guardrails / naming` via
   `node --test scripts/__tests__/*.test.mjs` before any install step, and `js-yaml` is not present in
   the repository's `node_modules` (verified). Parsing stays line-oriented, as it already is.
2. **The gate ships with the wrapping it requires.** A stricter gate landing ahead of the steps it
   governs fails the very build that introduces it.
3. **Self-test first.** The gate must prove its fail path and its exemption path before running the
   real scan — the pattern every other gate in `guardrails / naming` already follows.

## Redaction re-check

Instrumenting 48 more steps widens what is captured and therefore what may be published. Before this
lands, `redactForPublication` coverage is re-checked against the newly wrapped steps — particularly
the SAST, infra-image-scan and wiki-maintain steps, which handle tokens and third-party output. This
is an explicit task, not an assumption that existing redaction generalises.

## Acceptance evidence

- The gate fails on a tree with a deliberately unwrapped, unexempted `run:` step, and names the job
  and step.
- The gate passes on the finished tree.
- A deliberately failed step in a previously-unwrapped position yields its own output in the digest —
  by result, not by the gate's exit status.
