# Contract: `scripts/check-speckit-overrides.mjs`

```text
node scripts/check-speckit-overrides.mjs             # scan (read-only)
node scripts/check-speckit-overrides.mjs --record    # rewrite the fork-point header from the core template
node scripts/check-speckit-overrides.mjs --selftest  # prove each failure code is detected
node scripts/check-speckit-overrides.mjs --help      # usage; does nothing else
```

Arguments are parsed by `scripts/lib/argv-contract.mjs`. An unknown flag or a positional exits 2
with usage and **does nothing**. `--help` is checked first. The flags are mutually exclusive.

| Mode | Exit 0 | Exit 1 | Exit 2 |
|---|---|---|---|
| scan | every invariant holds | one or more failure codes (all printed) | bad arguments / unreadable repo files |
| `--record` | header written (prints old → new hash) | override missing, or the sweep marker missing (it refuses to record a fork that lost the sweep) | bad arguments |
| `--selftest` | every code detected on a fixture and the clean fixture passes | a detection broke | bad arguments |

## Output

- Success (scan): `✓ speckit-overrides gate passed (override present, sweep task present, core template matches fork point <hash12>, override-first resolution intact)`
- Failure: `[speckit-overrides] ✗ <code>: <message>` for each failure, then one remediation line:
  `Fix: merge the core change into the override, then run node scripts/check-speckit-overrides.mjs --record (never hand-type the hash). Procedure: docs/runbooks/doc-drift.md#upgrading-spec-kit`

## Programmatic API (for tests)

```js
export function checkSpeckitOverrides({ root }): { ok, failures }
export function recordForkPoint({ root }): { previous, current }
export function parseForkPoint(line): { corePath, sha256, specKit } | null
```

`root` defaults to the repository root. Tests pass a temp-dir fixture tree. `git` calls run with
`cwd: root` and degrade to the "history unavailable" note on any error.
