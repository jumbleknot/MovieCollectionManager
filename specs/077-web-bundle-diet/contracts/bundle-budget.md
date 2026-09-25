# Contract — `scripts/check-web-bundle-budget.mjs`

The gate that stops the cold-load path growing back (FR-012, SC-001, SC-004, SC-006).

## Invocation

```
node scripts/check-web-bundle-budget.mjs [--dist <dir>] [--budget <bytes>] [--json]
node scripts/check-web-bundle-budget.mjs --selftest
node scripts/check-web-bundle-budget.mjs --help
```

Arguments are parsed through `scripts/lib/argv-contract.mjs`. An unrecognised flag **raises**
and exits 2; it never leaves the default action running. `--help` prints usage and exits 0
without scanning.

| Flag | Default | Meaning |
|---|---|---|
| `--dist <dir>` | `frontend/mcm-app/dist` | Root of an `expo export` output (the directory containing `client/`). |
| `--budget <bytes>` | `2400000` | Maximum permitted entry-chunk size. The default is the committed budget; the flag exists for the selftest and for local what-if runs. |
| `--json` | off | Emit the report as JSON on stdout instead of human text. |
| `--selftest` | — | Prove the fail and clean paths against synthetic fixtures. Runs no real export. |

## Inputs it reads

- `<dist>/client/_expo/static/js/web/entry-*.js` — exactly one must match. Zero matches and
  more than one match are both **failures**, not warnings: zero means the export shape changed
  or never ran, and more than one means the entry chunk was split in a way this gate no longer
  understands. Either way the number it would report is not the number it claims to report.
- `<dist>/client/_expo/static/js/web/entry-*.js.map` — used for the zero-modules assertion.
  If absent (an export without `--source-maps`), the size check still runs and the
  zero-modules assertion is reported as **skipped**, and the skip is printed on its own line.
  A silent skip here would be the whole gate quietly proving nothing.

## Assertions

1. **Size**: entry chunk size ≤ budget.
2. **Zero modules**: none of `text-encoding`, `web-streams-polyfill`, `zod`, `graphql`,
   `@copilotkit/`, `@ag-ui/`, `luxon`, `src/bff-server/` contributes any module to the entry
   chunk's source map `sources`.

Assertion 2 exists because assertion 1 alone is satisfiable by a change that re-imports the
assistant runtime at the root while some other code shrinks. The byte budget measures the
symptom; the module list measures the cause.

## Output

Human form, on success:

```
web entry chunk: 1,831,422 B / 2,400,000 B budget (76.3%, 568,578 B spare)
deferred-package check: 8/8 absent from the entry chunk
OK
```

On a size failure:

```
web entry chunk: 2,551,004 B / 2,400,000 B budget — OVER BY 151,004 B (106.3%)
  the cold-load path grew. What entered it:
    zod  640 KB  (was absent)
FAIL
```

The overage and the newly-present packages are both named, because "the bundle got bigger" is
not actionable and "`zod` came back" is.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every assertion passed, or `--selftest` passed. |
| 1 | An assertion failed, an expected input was missing/ambiguous, or `--selftest` found the gate broken. |
| 2 | Bad arguments. |

## Nx target

```
bundle-budget:  node scripts/check-web-bundle-budget.mjs --dist frontend/mcm-app/dist
  dependsOn:    ["export-server"]
  inputs:       the export's outputs
```

Cached by nx, and reached in CI through the `affected` job's target list, so it runs when and
only when `mcm-app` is affected.

## Raising the budget

The budget is a committed number, not a moving average. Raising it is a deliberate act that
belongs in a pull request of its own or is justified in the PR that needs it, with the
measured before/after quoted. A gate that is relaxed whenever it fires is not a gate — the
same reasoning the repository applies to every other guard it owns.
