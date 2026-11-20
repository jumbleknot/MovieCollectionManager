# Feature Specification: Bill the model run, not the CopilotKit handshake (item #806)

**Feature Branch**: `fix/agent-billing-envelope`

**Created**: 2026-11-20

**Status**: Approved

**Input**: Operator, 2026-11-20: "do #806 as its own PR, watch to green, merge".

## Context

`isBillableAgentRun` (`frontend/mcm-app/src/bff-server/agent-rate-limiter.ts`) treats a POST to
`/bff-api/agent/run` as non-billable only when its GraphQL `operationName` is `availableAgents`,
`loadAgentState` or `hello`. The client runs CopilotKit with `useSingleEndpoint`, so it posts
`{ method, params?, body? }` envelopes and never an `operationName`, and the BFF mounts the runtime's
single-route handler only (`copilotRuntimeNextJSAppRouterEndpoint` → `createCopilotEndpointSingleRoute`),
which serves no GraphQL. Every handshake is therefore billable:

- it accrues the per-turn cost estimate and counts against the cost ceiling;
- it resolves the run config, so an unconfigured member's handshake is answered
  `assistant_not_configured` instead of reaching the runtime;
- it consumes the single-use pending import-file handle and the UI snapshot — the item #284 failure,
  back again.

## Request shapes (from the installed client, @copilotkit/core 1.87.1)

Read from `dist/index.mjs` of the installed package (not captured from live traffic; see Out of scope):

| method | Built by | Example body | Runs the model |
| --- | --- | --- | --- |
| `info` | runtime-info fetch on dock open | `{"method":"info"}` | no |
| `agent/connect` | `createSingleRouteRequestInit(…, "agent/connect", {agentId})` | `{"method":"agent/connect","params":{"agentId":"movie_assistant"},"body":{…RunAgentInput}}` | no — runtime `runner.connect` replays stored events |
| `agent/run` | `createSingleRouteRequestInit(…, "agent/run", {agentId})` | `{"method":"agent/run","params":{"agentId":"movie_assistant"},"body":{…RunAgentInput}}` | **yes** |
| `agent/stop` | stop helper | `{"method":"agent/stop","params":{"agentId":…,"threadId":…},"body":{"runId":…}}` | no |
| `trajectory/connect` | trajectory session | `{"method":"trajectory/connect","params":{"trajectoryId":…},"body":{}}` | no |
| `resource/request` | thread resource helper | `{"method":"resource/request","params":{"path":…,"httpMethod":…}}` | no |
| `inspector/metadata` | web inspector | `{"method":"inspector/metadata"}` | no |
| `agent/suggest` | suggestions | envelope with `params.agentId` | **yes** |

## Requirements *(mandatory)*

- **FR-001**: `isBillableAgentRun` classifies by the envelope's top-level `method`. Non-billable:
  `info`, `agent/connect`, `agent/stop`, `trajectory/connect`, `resource/request`, `inspector/metadata`.
  Everything else — `agent/run`, `agent/suggest`, any unknown, missing, non-string or differently
  cased method, and any unparseable or non-object body — is billable (default-deny).
- **FR-002**: The GraphQL `operationName` branch is removed (unreachable: the runtime serves no GraphQL).
  A body naming only an `operationName` is an unknown request, so billable.
- **FR-003**: A handshake POST leaves the pending import-file handle and the UI snapshot in place
  (item #284 holds again), and accrues no cost.

## Success Criteria *(mandatory)*

- **SC-001**: Per-method classifier tests and per-handshake import-handle tests fail on `main` and pass
  after the change.
- **SC-002**: The web agent E2E gate tier still passes (dock open, turn, approval) on this PR.

## Out of scope

Capturing live request bodies from a browser session (item #806 AC1 asks for it): the shapes above are
read from the installed client build, which is what the browser runs. The PR's E2E run exercises them.
