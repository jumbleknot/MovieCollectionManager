# Contract: `scripts/check-no-argv-secrets.mjs`

A keyless CI guard that fails the build if any in-scope tracked file passes a credential-named argument
to the Maestro test runner on the command line. Modeled on `scripts/secret-scan.mjs` /
`scripts/check-no-inline-secrets.mjs`.

## Invocation

```text
node scripts/check-no-argv-secrets.mjs            # scan in-scope git-tracked files; exit 1 on any hit
node scripts/check-no-argv-secrets.mjs --selftest # validate detection (planted line → hit; clean → none)
```

Wired into `.forgejo/workflows/guardrails.yml` (naming job) as two steps: `--selftest` then plain scan,
matching the other gates.

## Detection rule

Flag a match when, in a `maestro` invocation context, an argument of the form:

```text
(--env|-e)\s+<KEY>=…    where <KEY> matches /(KEY|PASSWORD|SECRET|TOKEN)/i
```

- Tolerant of quoting (`"$VAR"`, `'…'`, bare) and backslash line-continuation between the flag and the
  key (the CI runner's `--env FOO="$FOO" \` multi-line shape).
- Does NOT flag non-credential `--env` keys (`COLLECTION_NAME`, `E2E_TEST_USER`).
- Value shape is irrelevant — the argument *pattern* is the violation, whether the value is a real secret,
  a `$VAR`, or empty.

## Scope / allowlist

- **Scanned**: `git ls-files` tree, restricted to in-scope files (`scripts/**`,
  `frontend/mcm-app/tests/e2e/mobile/*.yaml`, `docs/**`, `CLAUDE.md`).
- **Excluded (allowlist)**: `specs/0NN/**` (historical records — spec clarification), binary files, and
  the guard's own source (`SELF`, which holds the pattern as regex).

## Output / exit codes

| Condition | stdout/stderr | Exit |
|---|---|---|
| No flagged argument in scope | `✅ no argv-secret arguments to the test runner` | 0 |
| One or more flagged | `❌` list of `file:line — --env <KEY>=` per hit + remediation pointer to `scripts/maestro-run.sh` | 1 |
| `--selftest` passes | `✅ detects planted --env SECRET=; clean tree passes` | 0 |
| `--selftest` fails | `❌` which assertion failed | 1 |

## Self-test (TDD RED/GREEN surface)

- Planted positive: a string containing `maestro test flow.yaml --env E2E_TEST_PASSWORD="$P"` → MUST be
  detected.
- Planted positive (multi-line): flag + backslash-continued `--env ANTHROPIC_API_KEY=…` → MUST be detected.
- Clean negatives that MUST NOT flag: `scripts/maestro-run.sh tests/e2e/mobile/x.yaml`,
  `maestro test x.yaml --env COLLECTION_NAME="t-1"`, `--env E2E_TEST_USER="$U"`.

## Guarantees

- **G1** — Fails on any in-scope reintroduction of a `--env <credential>=` argument (SC-004, SC-005).
- **G2** — Passes on the cleaned tree and never flags historical `specs/0NN/**` records or legitimate
  non-secret `--env` args.
- **G3** — Keyless and network-free (pure `git ls-files` + regex), safe for the every-push guardrails job.
