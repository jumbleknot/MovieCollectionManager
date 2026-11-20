# Implementation Plan: Bill the model run, not the CopilotKit handshake

**Branch**: `fix/agent-billing-envelope` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)

## Summary

One PR, its own CI signal (it changes what counts against the cost ceiling).

1. `agent-rate-limiter.ts`: replace `NON_BILLABLE_AGENT_OPS` (GraphQL op names) with
   `NON_BILLABLE_AGENT_METHODS` (envelope methods); `isBillableAgentRun` reads `body.method` from a
   parsed object, exact-match, default-deny.
2. `run+api.ts`: comments only — the route already keys the cost ceiling, cost accrual, run-config
   resolution, UI snapshot and import-file bridge on `billable`.
3. Tests: classifier (`agent-rate-limiter.test.ts`), route bridges (`agent-run-api.test.ts`) and the
   two route tests whose request bodies were GraphQL-shaped.
4. Wiki: `openwiki/projects/bff.md` and `openwiki/architecture/agent-layer.md` describe the
   `operationName` rule; update them.

## Constitution Check

TDD with Verify RED. Security: default-deny preserved; a mislabelled body cannot smuggle a run,
because the runtime dispatches on the same `method` (labelling a run `info` executes `info`). The
rate limit and the cross-user thread guard still apply to every POST.

## Risk

An unconfigured member's handshake now reaches the runtime instead of the early
`assistant_not_configured` reply. The billable `agent/run` still gets that reply, which is what the
dock shows. Covered by the web E2E `assistant-config.spec.ts` in this PR's gate tier.
