# Contract: `scripts/check-version-pins.mjs`

```text
node scripts/check-version-pins.mjs            check the tree; print the classification
node scripts/check-version-pins.mjs --json     the same, as JSON on stdout
node scripts/check-version-pins.mjs --help     usage
```

The script is read-only: no flag writes anything, so a bare invocation is safe (item #500). Any
argument outside these is rejected with exit 2 by `lib/argv-contract.mjs`.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | every pin is managed or excluded, and every exclusion is valid, live and needed |
| 1 | at least one unmanaged pin, or a stale, redundant or invalid exclusion |
| 2 | bad arguments |
| 3 | the check could not run: an unreadable `renovate.json` or exclusions file, an unsupported `matchStringsStrategy`, or `git ls-files` failing. This is distinct from 1 so an instrument failure never reads as a finding |

## Human output (stdout, always, on pass and fail: FR-008)

```text
── version pins ──
managed    .forgejo/workflows/app-ci.yml:156          actions/setup-node:node-version = 26.13.1   ← github-actions:actions/setup-node
managed    scripts/ci-install-trivy.sh:36             TRIVY_VERSION = v0.76.2                    ← aquasecurity/trivy
excluded   .devcontainer/toolchain.Dockerfile:285     SPECKIT_VERSION = v1.4.2                   ← "Spec Kit upgrades are a reviewed procedure…"
UNMANAGED  .forgejo/workflows/app-ci.yml:900          FOO_VERSION = 1.2.3
  → add a customManager to renovate.json that captures it, or add {file, name, reason} to .forgejo/version-pin-exclusions.json
STALE      exclusion {file: x, name: Y} matches no pin — delete it
REDUNDANT  exclusion {file: x, name: Y} — the pin is managed by <manager>; delete the exclusion
── 42 pins: 36 managed, 5 excluded, 1 unmanaged · 0 stale · 0 redundant · 0 invalid ──
```

Failures also go to stderr. The line format (`<status> <file>:<line> <name> = <value>`) is stable, so it
can be read by the CI failure digest.

## `--json`

```json
{
  "pins": [{ "file": "…", "line": 1, "shape": "assignment", "name": "…", "value": "…",
             "status": "managed|excluded|unmanaged", "manager": "…", "reason": "…" }],
  "staleExclusions": [], "redundantExclusions": [], "invalidExclusions": [],
  "ok": true
}
```
