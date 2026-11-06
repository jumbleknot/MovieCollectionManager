# Implementation Plan: The assistant raises no blocked `eval` probes

**Spec**: [spec.md](./spec.md) | **Branch**: `089-single-zod-jitless`

## Summary

Move `@ag-ui/*` onto the app's zod 4 copy with a scoped override, then set `jitless` as the first thing
the assistant chunk does. `script-src` does not change.

## Design

| File | Change |
| --- | --- |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml` | `'@ag-ui/client>zod'` and `'@ag-ui/proto>zod'` overrides, with the app's own range |
| `frontend/mcm-app/src/utils/zod-jitless.web.ts` | `config({ jitless: true })` |
| `frontend/mcm-app/src/utils/zod-jitless.ts` | Empty module, so native changes nothing |
| `frontend/mcm-app/src/components/agent/assistant-panel.tsx` | Import that module first |
| `frontend/mcm-app/web-security-headers.js` | Replace the note that says one probe is expected |

**Why the first import.** Modules evaluate in import order, and the panel is the chunk's only root, so
this runs before any package in the chunk builds a schema.

**Why it costs nothing on web.** The CSP already blocks `eval`, so zod's fast path is already off there.
`jitless` skips the attempt, not a working optimisation.

**To measure after the build.** The source map must show one `v4/core/util` in the assistant chunk. The
lock file cannot prove this, because `@copilotkit/runtime` legitimately keeps a zod 3 `@ag-ui/core`.

**Rejected**: `jitless` without the override, because the older copy would still probe. A global zod
override, because `@copilotkit/shared` uses the v3 API through the root import.

## Verification

- `scripts/__tests__/single-zod-engine.guard.test.mjs`: the lock file and the import order.
- `frontend/mcm-app/src/utils/unit-tests/zod-jitless.test.ts`: counts real `Function` constructions by zod,
  with a control proving the counter can see a probe.
- Browser: the assistant navigate turn with no allowance. The permanent version is PR B's watch.
- CI: agent `@gate` tests and the Android agent flows. A change under `frontend/` already runs those flows.
