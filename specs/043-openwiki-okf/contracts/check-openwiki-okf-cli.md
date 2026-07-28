# Contract: `scripts/check-openwiki-okf.mjs`

**Feature**: 043-openwiki-okf · **Date**: 2026-07-26

The gate's command-line contract. Fixed before implementation so the fixture tests can assert against
it (TDD). Shape follows the nine existing `scripts/check-*.mjs` gates — deviating would break operator
muscle memory and the `ci-log-step.sh` conventions.

---

## Invocation

```bash
node scripts/check-openwiki-okf.mjs [--selftest] [--bundle <path>] [--json]
```

| Argument | Default | Meaning |
|---|---|---|
| *(none)* | — | Validate the real bundle at `openwiki/`. The normal CI and local invocation. |
| `--selftest` | — | Prove the gate's own detection logic against built-in synthetic cases, then exit. Does **not** read the real bundle. Run this **first**, per house rules. |
| `--bundle <path>` | `openwiki` | Validate an alternate bundle root. Exists so fixture tests can point the real CLI at a temp directory — it is a test affordance, **not** an opt-out for CI. |
| `--json` | off | Emit machine-readable findings on stdout instead of the human summary. |
| `--check-coverage` | off | Additionally report canonical documents that no concept cites (rule V14), as **warnings** — never findings. Opt-in so the always-on CI gate keeps its existing behaviour; the feature-completion staleness check enables it. |

There is **no** `--skip`, `--allow-missing`, or allowlist flag. FR-014a requires fail-closed with no
opt-out, and FR-012 forbids allowlisting generated content — an allowlist file would be the mechanism
for exactly what the spec prohibits.

---

## Exit codes

Matches the established convention (`check-ci-digest-coverage.mjs`, `check-dast-findings.mjs`):

| Code | Meaning |
|---|---|
| `0` | Clean — bundle conformant, or `--selftest` passed. **Drift warnings (V12) still exit 0.** |
| `1` | Violation found, or `--selftest` failed (the gate's own detection is broken). |
| `2` | Bad arguments, or input that cannot be processed at all. |

A missing or empty bundle is exit **1**, not 2 — it is a violation of FR-001, not a usage error.

---

## Output

### Human summary (default)

On success, one line matching the house voice:

```text
[openwiki-okf] ✅ 47 concepts conformant across 9 directories.
```

With drift present — still exit 0:

```text
[openwiki-okf] ⚠️  2 concepts may be stale (source changed after the concept's timestamp):
  openwiki/ci/diagnostics.md ← docs/runbooks/ci-diagnostics.md
  openwiki/testing/e2e.md    ← docs/runbooks/e2e-testing.md
[openwiki-okf] ✅ 47 concepts conformant across 9 directories.
```

On failure, every finding is named with its file and rule, then a count. **All findings are reported
in one run** — the gate must not stop at the first, or fixing a generated bundle becomes an N-run loop:

```text
[openwiki-okf] ✗ openwiki/agents/gateway.md — missing required field `type` (V2)
[openwiki-okf] ✗ openwiki/ci/index.md — concept not listed: openwiki/ci/forge.md (V9)
[openwiki-okf] ✗ openwiki/deploy/komodo.md — resource does not resolve: docs/runbooks/gone.md (V6)
[openwiki-okf] ✗ 3 conformance violations.
```

On a missing bundle:

```text
[openwiki-okf] ✗ no bundle at openwiki/ — the bundle is a required artifact (V10).
```

### `--json`

```json
{
  "bundleRoot": "openwiki",
  "conceptCount": 47,
  "directoryCount": 9,
  "findings": [
    { "rule": "V2", "file": "openwiki/agents/gateway.md", "message": "missing required field `type`" }
  ],
  "warnings": [
    { "rule": "V12", "file": "openwiki/ci/diagnostics.md", "source": "docs/runbooks/ci-diagnostics.md" }
  ]
}
```

`findings` drive the exit code; `warnings` never do. Warnings carry a `rule` of `V12` (drift) or
`V14` (uncited canonical document), so a caller can act on them separately.

**This warning set is the FR-028 regeneration trigger.** It costs no model call and completes in
~0.2 s, which is what makes gating every feature on it free.

---

## Guarantees

1. **No network access, ever.** External `resource` values are shape-checked only (V7). The gate must
   pass with networking fully unavailable — this is what keeps the `guardrails` job keyless and immune
   to third-party outages, and it is directly testable by running with no route.
2. **No writes.** Read-only over the working tree. It reports; it never repairs. Repair is a change to
   `openwiki/INSTRUCTIONS.md` plus regeneration.
3. **Deterministic.** Same tree ⇒ same output and exit code. Findings are sorted by file path so diffs
   between runs are meaningful.
4. **Self-contained.** Only Node builtins plus `yaml` (already a root dependency). No new dependency,
   nothing added to any lockfile.

---

## `--selftest` obligation

`--selftest` must exercise **every** rule V1–V13 from `data-model.md` against synthetic in-memory or
temp-dir cases, and fail (exit 1) if any rule stops detecting its case. This is what makes the gate
trustworthy after later edits: a refactor that silently disables a check turns the selftest red.

It must also assert the two rules most likely to be broken by a well-meaning change:

- `INSTRUCTIONS.md` stays exempt (V11) — the most likely self-inflicted failure.
- Drift (V12) warns without affecting the exit code — the most likely accidental escalation.
