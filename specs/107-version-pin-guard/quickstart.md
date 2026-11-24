# Quickstart: validating the version-pin guard (107)

Prerequisites: Node (the version in `.forgejo/workflows/*` `node-version`) and a checkout. Nothing is
installed: the check uses Node built-ins only.

## 1. The tree passes, and says why

```bash
node scripts/check-version-pins.mjs; echo "exit=$?"
```

Expected: exit 0. Every pin is listed as `managed` (with its manager) or `excluded` (with its reason).
The summary line shows `0 unmanaged · 0 stale · 0 redundant · 0 invalid` (FR-008, SC-002, SC-005).

## 2. A new unmanaged pin fails, naming file and line (US1, SC-001)

```bash
printf '\nFOO_VERSION=1.2.3\n' >> scripts/ci-install-trivy.sh
node scripts/check-version-pins.mjs; echo "exit=$?"
git checkout -- scripts/ci-install-trivy.sh
```

Expected: exit 1, with an `UNMANAGED scripts/ci-install-trivy.sh:<n> FOO_VERSION = 1.2.3` line and both
remedies printed.

## 3. A manager whose file pattern matches but whose regex misses does not count

Covered by unit test, because the mutation is to `renovate.json`. Break the Trivy manager's
`matchStrings` so it captures nothing. `TRIVY_VERSION` must then report UNMANAGED, although the manager's
file pattern still names the file.

## 4. Exclusions are exact, reasoned, live and needed (US3)

Covered by `scripts/__tests__/check-version-pins.test.mjs`. Each of the following fails, naming the entry:
- an entry with a wildcard name;
- an entry with an empty reason;
- an entry for a pin that does not exist (stale);
- an entry for a managed pin (redundant).

## 5. In CI

guardrails / `renovate-config` runs step 1 on every pull request (required context). A red run's
failure digest carries the UNMANAGED / STALE / REDUNDANT lines.

## 6. Unit tests

```bash
node --test scripts/__tests__/check-version-pins.test.mjs
```

Expected: the `ℹ pass N` / `ℹ fail 0` summary lines.
