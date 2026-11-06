# Feature Specification: The assistant raises no blocked `eval` probes

**Feature Branch**: `089-single-zod-jitless`

**Created**: 2026-11-06

**Status**: Approved by the operator, 2026-11-06

**Input**: Feature 087's browser walk measured two blocked `eval` probes per page on the assistant path,
where feature 032 had accepted one. The operator chose to remove the cause rather than raise the limit.

## Measured Baseline

Web bundle, SDK 57. Sizes come from the assistant chunk's source map (2,850,492 B in total).

| Copy in the assistant chunk | Pulled in by | Minified | Probes? |
| --- | --- | --- | --- |
| `zod@4.6.7`, v4 code | the app's own code, `@copilotkit/react-core` | 508,915 B | Yes |
| `zod@3.25.76`, v4 code | `@ag-ui/core` only | 280,049 B | Yes |
| `zod@3.25.76`, v3 code | `@copilotkit/shared` | 72,850 B | No |
| `zod@4.6.7`, v3 code | `zod-to-json-schema` | 73,481 B | No |

- `@ag-ui/core` allows `^3.25.18 || ^4.0.0`. It is tied to 3.25.76 because `@ag-ui/client` and
  `@ag-ui/proto` depend on `^3.25.76`, and that satisfies its peer.
- `@ag-ui/client` and `@ag-ui/core` import only `zod/v4`. `@ag-ui/proto` does not import zod at all.
- `zod@4.6.7` skips its probe when `globalConfig.jitless` is set, and its source says this is to avoid
  this CSP report. `zod@3.25.76`'s probe has no such check.
- The server also loads `@ag-ui/client` (`agent-gateway-client.ts`), so the override reaches the BFF.
- `@copilotkit/runtime` requires zod `^3.25.18` and runs only in the BFF, so it keeps its own zod 3 copy
  of `@ag-ui/core`. The BFF will therefore hold two copies of that package, one for the runtime and one
  for the client. There is still one `@ag-ui/client`.
- `zod@4.6.7` keeps its settings on `globalThis`, so its ESM and CJS files share `jitless`.

## User Story: The assistant runs under the strict CSP without violations (P1)

A user opening the assistant raises no CSP violations, so any blocked `eval` on that path is a real
finding rather than a known line that the test has to allow.

**Acceptance Scenarios**:

1. **Given** the web build, **When** the assistant loads and streams a turn, **Then** the browser reports
   no `eval` violation.
2. **Given** the assistant on web and on Android, **When** it streams and validates AG-UI events, **Then**
   it behaves as before.

## Requirements

- **FR-001**: `@ag-ui/client` uses a copy of `@ag-ui/core` on the app's zod 4, through an override limited
  to the `@ag-ui` packages.
- **FR-002**: The web assistant sets zod's `jitless` before any schema is built.
- **FR-003**: `jitless` is web-only, because native's evaluation behaviour has not been measured.
- **FR-004**: `script-src` stays as it is. `'unsafe-eval'` and `'unsafe-inline'` stay absent.
- **FR-005**: `zod@3.25.76` stays where a package needs its v3 API (`@copilotkit/shared`, `@expo/cli`).

## Out of Scope

Removing zod 3 entirely, upgrading CopilotKit or AG-UI, and using `jitless` on the server. Removing the
allowance from feature 087's walk happens on PR B's branch, where that test lives.

## Success Criteria

- **SC-001**: The assistant's navigate turn runs with no `eval` violation, measured in a browser.
- **SC-002**: The assistant chunk contains one zod `v4/core/util` and is about 280 KB smaller.
- **SC-003**: The agent E2E `@gate` tests and the Android agent flows pass in CI. These tests also exercise
  the BFF's two copies of `@ag-ui/core`.
