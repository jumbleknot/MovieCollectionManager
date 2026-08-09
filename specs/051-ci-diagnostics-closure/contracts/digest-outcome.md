# Contract — the digest outcome signal

**Governs**: FR-010, FR-011, FR-012, FR-013, FR-014, FR-015 ·
**Producer**: `scripts/ci-failure-digest.mjs` · **Consumer**: `scripts/ci-status.mjs failure`

## The problem this contract fixes

The digest step is `if: always()` + `continue-on-error: true`, and the script ends in an
unconditional `exit 0`. Those three together are correct — a broken digest must never fail a build —
but they also erase the difference between *nothing to report* and *the reporter is broken*. The
reader is then told "no digest was published" in both cases, and believes the first.

## Outcome vocabulary

Three states, mirroring the `absent` field the digest already uses to distinguish "looked and found
nothing" from "did not look".

| Outcome | Condition | What the reader must be told |
| --- | --- | --- |
| `not-needed` | job status is success, or the run was cancelled/superseded | No digest was needed for this run |
| `published` | a digest reached its channel | Where it is, plus the bundle reference |
| `failed` | publication was attempted and did not succeed | **That the digest ran and failed**, with the sub-reason |

`failed` sub-reasons, because each implies a different next action:

| Sub-reason | Meaning | Reader's next action |
| --- | --- | --- |
| `failed:no-credential` | no usable token was available | Check whether this run had secrets at all — the 2026-08-01 case |
| `failed:forbidden` | a token was present but lacked scope | Grant the scope the existing hint already names |
| `failed:transport` | network, timeout, unexpected status | Retry or inspect the forge |

## Producer obligations

1. **The outcome MUST be discoverable without job logs.** The forge exposes no job stdout, so writing
   the outcome to stdout alone reproduces the original bug in a new place. It must be published
   through a channel the API can read.
2. **`exit 0` is unconditional and stays that way.** The outcome signal is a side effect. A digest
   that fails to record its own failure still exits 0.
3. **The signal itself must not need the credential that just failed** — otherwise
   `failed:no-credential` can never be reported, which is the state that matters most.
4. **Redaction applies to the signal** exactly as it applies to the digest body.

## Consumer obligations

`ci-status.mjs failure` MUST render the three outcomes distinctly. Specifically it must never emit
the "no digest was published" wording for a `failed` outcome — that string is reserved for
`not-needed` and for the genuinely-absent case.

## Credential fallback (Story 4)

| `CI_DIGEST_TOKEN` | Behaviour |
| --- | --- |
| present | Unchanged. Existing channel selection: PR comment on `pull_request`, commit status otherwise, plus the generic-package bundle |
| absent | Fall back to the run's automatically-provisioned token and publish a **commit status** carrying the failing step's name and a short excerpt, plus the `failed:no-credential` outcome |

**Unresolved and load-bearing** — see research R7. It is not yet established that the auto token is
populated on a secretless run, nor that it can write the statuses endpoint. Until a CI probe answers
that, this half of the contract is provisional. If the probe returns negative, the fallback becomes:
publish nothing, but make `failed:no-credential` unmistakable through whatever channel does survive,
and renegotiate SC-004 with the operator rather than quietly weakening it.

## Size limits

A commit status description is short. The fallback carries the failing step's **name** and a
**truncated** excerpt plus a pointer — enough to name the fault, not to replay the build. Truncation
must be safe: never split a redaction boundary, and never fail the publication because the content
was too long.

## Acceptance evidence

- A deliberately broken digest step produces a report naming it **broken**, not absent (SC-003).
- With the purpose-scoped credential unset, a failing job still surfaces the failing step's identity
  (SC-004).
- A digest failure leaves the job's own pass/fail outcome unchanged — proven by a unit test that
  forces the failure and asserts the exit code is still 0 (FR-012).
