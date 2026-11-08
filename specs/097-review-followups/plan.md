# Plan 097: Review follow-ups

**Spec**: [spec.md](./spec.md)

## Approach

### A. CI evidence for 094 and 095

`node scripts/ci-status.mjs status --pr 965` gives the verdict. The run ids come from the cached
`/tmp/mcm-ci-status/runs-2e81645b.json` (`id`, which is `GITHUB_RUN_ID`). The web UI path uses
`index_in_repo`, which is one lower, so both are quoted to keep the ids from being confused.

### B1. Item #962: lint

- The `lint` command becomes `eslint . && prettier --check …`. `eslint.config.js` keeps its global JS
  ignore, so `.` means every `*.ts`/`*.tsx`: `src/`, `tests/`, `scripts/*.ts` and the root config files.
- A `tests/**`, `scripts/**` and `*.config.ts` override turns off `expo/no-dynamic-env-var`. That rule
  exists because Metro inlines only static `process.env.EXPO_PUBLIC_*` reads into the app bundle; test,
  script and config code runs in Node, where a dynamic read is correct.
- The same override raises `@typescript-eslint/no-unused-vars` to `error`.
- Each of the other errors is fixed or, where the rule is wrong for that file, turned off with a reason.
- `inputs` stay `default` (the whole project root) plus the Prettier files. The comment says why the
  `.` scope needs nothing narrower.

### B2. Item #963: watchman

Remove the `037 base: watchman` layer from `.devcontainer/toolchain.Dockerfile`, leaving a comment with
the measurement so it is not re-added blind. Update the runbook's "Toolchain scope" note and the README
line. No jest config change: jest's fallback is silent when the binary is absent (measured).

### B3. Item #964

1. `models.py`: `ChatOllama(..., client_kwargs={"follow_redirects": False})`. New
   `tests/unit/test_ollama_redirects.py` runs two real loopback servers, sync and async. Pin test for the
   BFF probe in `agent-config-probes.test.ts`. Gotcha updated and re-fingerprinted.
2. `extractThreadId` returns the thread id the runtime will act on: `params.threadId` for an
   `agent/stop` envelope, `body.threadId` otherwise. `run+api.ts` already calls
   `enforceAgentThreadOwnership(user.id, extractThreadId(bodyText))` on every POST, so the stop path is
   covered with no new check. Tests: an `extractThreadId` unit case, and a route test where user A's run
   claims a thread and user B's stop of it is refused before the runtime.
3. `backup-destination-url-guard.ts`: parse an IPv6 literal into 8 hextets (handling `::` and an embedded
   dotted quad), then classify by prefix: `::/96` deny (covers `::` and `::1`), `::ffff:0:0/96` de-map and
   check, `64:ff9b::/96` and `64:ff9b:1::/48` deny. Tests go through `assertDestinationUrlAllowed` with URL
   literals, which `new URL()` canonicalizes to hex, and with resolver answers.

## Rollback

Revert the merge. No data or schema change. Reverting B2 re-adds a watchman that does not run.
