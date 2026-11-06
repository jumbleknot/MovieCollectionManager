# Tasks: The assistant raises no blocked `eval` probes

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

**Tests**: TDD. Each Verify RED was confirmed before the change it covers.

- [X] **T001** Write `scripts/__tests__/single-zod-engine.guard.test.mjs`. **Verify RED**: the lock-file and
  import-order checks fail.
- [X] **T002** Write `src/utils/unit-tests/zod-jitless.test.ts`. **Verify RED**: the control passes, and the
  web and native cases fail because the module does not exist.
- [X] **T003** Add the `@ag-ui` overrides and regenerate the lock file (FR-001, FR-005).
- [X] **T004** Add `zod-jitless.web.ts` and the empty native module, import it first in
  `assistant-panel.tsx`, and replace the note in `web-security-headers.js` (FR-002, FR-003, FR-004).
- [X] **T005** Build the web bundle and measure the assistant chunk (SC-002).
- [X] **T006** Run the assistant turn through the BFF with no `eval` allowance (SC-001).
- [X] **T007** Run the same test on `main` and this branch on a fresh stack, after the first run failed.
- [ ] **T008** Get a green CI run, including the Android agent flows (SC-003). Quote the run number here.
- [ ] **T009** On feature 087's PR B branch, remove the walk's `eval` allowance and correct its contract.

## Evidence

Measured 2026-11-06 in the dev container. The browser runs used `MODEL_PROVIDER=anthropic`,
`E2E_REQUIRE_AGENT_STACK=1` and Playwright's official image.

| Task | Result |
| --- | --- |
| T001, T002 RED | Guard: 2 failed, 1 passed. Jest: 2 failed, control passed |
| T001, T002 GREEN | Guard: 3 passed. Jest: 3 passed |
| T003 | Lock diff: 14 added, 5 removed. No new package versions |
| T005 | Assistant chunk 2,850,492 B to 2,536,265 B (314,227 B, 11%). One `v4/core/util` (`zod@4.6.7`). `zod@3.25.76` v3 code remains for `@copilotkit/shared` |
| T006 | No `eval` violation, with the watch's probe proving it could see violations: 1 passed, then 6 passed with `--repeat-each=3` |
| T006, failed runs | Fresh stack: 2 failed, then 1 failed and 1 passed. Each failure was a timeout waiting for navigation, not a CSP violation |
| T007 | Fresh stack, three alternating trials each: `main` 3 of 3 failed, this branch 3 of 3 failed, each with `runs=4 uiAction=0`. The failure predates this feature: item #943 |

`typecheck`, `lint` and `test` for `mcm-app` pass. `override-consistency` passes.
