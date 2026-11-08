# Tasks 097: Review follow-ups

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Quote PR #965's runs in spec 094 T003 and spec 095 T005, and tick both (FR-001).
- [X] **T002** (#962) Widen `mcm-app` lint to `.`, add the test/script/config override, fix the errors
  (FR-002 to FR-004).
  **Verify RED**: with the widened command and no override, `pnpm nx lint mcm-app` fails.
  **Verify GREEN**: with the override and fixes, it exits 0.
- [X] **T003** (#963) Remove watchman from the image; update the runbook and README (FR-005, FR-006).
  **Verify RED**: bare `npx jest <file>` with today's broken binary on `PATH` prints the loader error and
  runs nothing. **Verify GREEN**: with the binary off `PATH`, the same command passes.
- [X] **T004** (#964.1) Gateway Ollama client does not follow redirects; BFF probe pinned; gotcha updated
  (FR-007).
  **Verify RED**: `test_ollama_redirects.py` fails, the target receives `POST /api/chat`.
  **Verify GREEN**: the same tests pass with `follow_redirects=False`.
- [X] **T005** (#964.2) `agent/stop` ownership through `extractThreadId` (FR-008).
  **Verify RED**: the `agent/stop` extract case and the B-stops-A route test fail.
  **Verify GREEN**: both pass, with the existing ownership and run-route suites.
- [X] **T006** (#964.3) Deny `::/96`, `64:ff9b::/96`, `64:ff9b:1::/48` in the backup guard (FR-009).
  **Verify RED**: the new canonical-form cases fail. **Verify GREEN**: they and the existing guard suite
  pass.
- [X] **T007** Run the touched tiers one at a time: `nx lint mcm-app`, `nx test mcm-app`,
  `nx lint movie-assistant`, `nx test movie-assistant`, `okf-lint`, `okf-governance`,
  `formatter-gates.guard`.
- [X] **T008** Open the PR and get green CI. **Quote** the run numbers.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 | `ci-status.mjs status --pr 965` on `2e81645b21c2b7c772a2fea156001f65f409444b`: `VERDICT mergeable — all required contexts satisfied`, 12/12 required passed. Run ids 7156 `app-ci`, 7157 `guardrails`, 7158 `infra-image-scan` (web UI `/actions/runs/7155`–`7157`, which is `index_in_repo`) | CI, PR #965 |
| T003 RED | `npx jest --maxWorkers=1 src/bff-server/agent-config-probes.test.ts`: only `watchman --no-pretty get-sockname returned with exit code=127 … libcrypto.so.1.1: cannot open shared object file`, no test result | Local |
| T003 GREEN | Same command with `/usr/local/bin` replaced on `PATH` by a copy without `watchman*` (`command -v watchman` empty): `Tests: 15 passed, 15 total`. Metro: `metro-file-map` 0.87.3 `#shouldUseWatchman` catches a failed capability check and returns `false` (source read, not run) | Local |
| T004 RED | `pytest tests/unit/test_ollama_redirects.py`: `2 failed`, both `assert ['POST /api/chat'] == []` | Local |
| T004 GREEN | `2 passed`; with `test_models.py` and `test_ollama_guard.py`: `30 passed` | Local |
| T004 BFF pin | `agent-config-probes.test.ts` redirect case passed on first run (a pin: `http.request` cannot follow). Sensitivity: a temporary mutation that followed the 307 (once awaiting the second response, once fire-and-forget) failed it both times; source restored with `git checkout` | Local |
| T004 gotcha | `agent-config-ssrf-guard.md` "Gotchas" re-fingerprinted (`sha256:1fc67789…`); `nx okf-governance` exit 0 | Local |
| T005 RED | `agent-resume.test.ts` + new `agent-stop-ownership.test.ts`: `3 failed, 17 passed`. `Expected: "thread-A" / Received: undefined`; the decoy case returned `"own-thread"`; B's stop "resolved instead of rejected". The run-envelope case passed before and after (it guards against the fix over-reaching) | Local |
| T005 GREEN | Those two plus `agent-thread-owner`, `agent-run-api`, `tests/app/bff-api/agent/run.test.ts`: 5 suites, `35 passed` | Local |
| T006 RED | `backup-destination-url-guard.test.ts`: `10 failed, 24 passed`, exactly the 10 new rejection cases (`expected http://[::127.0.0.1]/ to be rejected, but it was allowed`, …). The public-IPv6, mapped-public and allow-listed-NAT64 cases passed | Local |
| T006 GREEN | `34 passed`. Also found and denied: the IPv4-translated form `::ffff:0:a.b.c.d`, which `mappedIpv4` never matched (three groups follow `ffff`) | Local |
| T002 RED | `lint` changed to `eslint . && prettier --check …`, no override yet: `pnpm nx lint mcm-app --skip-nx-cache` exit 1, `185 problems (17 errors, 168 warnings)`. 17 is the item's 18 less the `_layout.test.tsx` hook already fixed: `mockConfigProbe` called a hook from a plain function, a real (if harmless) violation, now a `MockConfigProbe` component rendered with `createElement`; its suite `2 passed` | Local |
| T002 GREEN | Overrides: `expo/no-dynamic-env-var` off and `no-unused-vars` error for `tests/**`, `scripts/**`, `*.config.ts`; `rules-of-hooks` off for `tests/e2e/**` only (the Playwright `use` false positive, confirmed on `worker-session.ts`; nothing under `tests/e2e` imports React); k6 declared as `import/core-modules` for `tests/load/**` instead of disabling `import/no-unresolved`. `nx lint mcm-app --skip-nx-cache` exit 0, `0 errors, 168 warnings`. An unused `const` in a `tests/` file is reported as `error` | Local |
| T002 inputs | Unchanged on purpose: `default` is `{projectRoot}/**/*`, which already covers `tests/`, `scripts/` and `eslint.config.js`. Measured: lint `1/1 hit`, then append a line to `tests/load/auth-load-impl.ts`, lint `0/1 hit` | Local |
| T007 | One at a time, `--parallel=1`, `--skip-nx-cache`: `nx lint mcm-app` exit 0 (0 errors); `nx test mcm-app -- --maxWorkers=1`: `165 passed` suites, `1759 passed` tests, 0 skipped; `nx typecheck mcm-app` exit 0; `nx lint movie-assistant`: `156 files already formatted`, ruff `All checks passed!`, mypy `no issues found in 45 source files`; `nx test movie-assistant`: `1239 passed, 1 skipped` (spec 094's 1237 + 1 skipped, plus the 2 new); `okf-lint`: `74 concepts conformant`; `okf-governance` exit 0; `formatter-gates.guard`: 11 pass, 0 skipped; `renovate-workflow.guard` (reads the Dockerfile): 150 pass, 0 skipped | Local |
| T008 | PR #969, head `dae54d65`: `ci-status.mjs watch --pr 969 --required-only` → `VERDICT mergeable — all required contexts satisfied`, 12/12 required passed (advisory `dast` and `android-launch` also passed). Run ids **7187** `app-ci`, **7188** `guardrails`, **7189** `infra-image-scan` (web UI `/actions/runs/7186`–`7188`, which is `index_in_repo`). A first 5400 s watch exited 3 (still waiting, not failure): the runs queued ~30 min behind other work before starting. Merged as `f72833b3` | CI, PR #969 |

## Follow-ups filed

Found while doing this work, out of its scope, and tracked in the backlog rather than here:

- item #970: the session-end proposal sweep (spec 012 T062) was never wired, so a pending proposal outlives the session.
- item #973: the gateway writes the user's bearer token into every LangGraph checkpoint's metadata (`get_checkpoint_metadata` copies every string in `configurable`). Measured: 3 of 3 checkpoints held the token.
- item #974: the gateway's `MemorySaver` grows without bound until restart.
- item #975: once the 24 h owner claim lapses, another user can claim a stale thread. This revisits the risk T005's analysis accepted. It also records that the claim is never refreshed, and that the `owner ?? userId` race fallback fails open.

Item #963's last criterion, a freshly built image, is verified in the operator's other session, not here.
