# Contract — environment forwarding into the Playwright container

**Governs**: FR-001, FR-002, FR-003 · **Consumer**: `.forgejo/workflows/app-ci.yml`, job `app-e2e`

`docker run` forwards **only** the variables named with `-e`. A variable set at job level and not
named is invisible inside the container. Every gate the web E2E suite applies is driven by such a
variable, so an omission does not produce an error — it produces a silent skip and a green gate.

## Required set

| Variable | Job-level `env:` | `-e` flag | Why |
| --- | --- | --- | --- |
| `E2E_BFF_TARGET` | yes | yes, literal `dev-container` | Selects the BFF fronting mode |
| `E2E_TEST_USER` | yes (secret) | yes, pass-through | Login for global setup + seeding |
| `E2E_TEST_PASSWORD` | yes (secret) | yes, pass-through | " |
| `CI` | — | yes, literal `1` | Playwright CI behaviour |
| `E2E_AGENT_PROVIDER` | — | yes, literal `anthropic` | Model surface for agent specs |
| `ANTHROPIC_API_KEY` | yes (secret) | yes, pass-through | " |
| `TMDB_API_KEY` | yes (secret) | yes, pass-through | Enrichment flows |
| **`E2E_AGENT_PRODUCTION`** | yes, `'1'` | **ADD, pass-through** | Un-gates every `agent-*.spec.ts`. Absent today → all skip |
| **`E2E_REQUIRE_AGENT_STACK`** | — | **ADD, literal `1`** | Turns a missed stack into a loud failure instead of a skip |
| **`KEYCLOAK_SERVICE_CLIENT_SECRET`** | **ADD** from `secrets.KEYCLOAK_SERVICE_CLIENT_SECRET` | **ADD, pass-through** | Un-gates `admin-card.spec.ts` and `admin-registration.spec.ts`. Absent from *both* today → both skip |

## Deliberately not forwarded

Recorded here, and in a comment beside the invocation, so the next reader does not re-derive the
table or "helpfully" add them.

| Variable | Why not |
| --- | --- |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_SERVICE_CLIENT_ID` | The defaults in `tests/e2e/web/setup/keycloak-admin.ts` already match the CI topology, and the container runs `--network host` so `localhost:8099` resolves identically inside and out |
| `E2E_AGENT_OLLAMA_URL` | The CI provider is `anthropic`; this is the dev/test provider's endpoint |
| `E2E_LARGE_LIBRARY`, `E2E_LARGE_LIBRARY_SIZE` | Opt-in performance scenario, deliberately off in the merge gate |

## Invariants

1. **Pass-through form, not assignment, for anything secret.** `-e NAME` forwards the runner's value;
   `-e NAME=$NAME` would place the value in the command line, where it can reach process listings and
   step logs. The argv-secret gate in `guardrails / naming` exists for this class of mistake.
2. **A variable that gates a spec MUST be paired with its require-flag.** Un-gating without the
   corresponding `*_REQUIRE_*` merely moves the failure mode from "always skips" to "skips whenever
   the stack is down", which is the same false green with a smaller blast radius.
3. **The forwarded set is verified by enumeration, not by reading.** The check is: enumerate every
   `process.env` read under `frontend/mcm-app/tests/e2e/`, diff against the `-e` list, and account for
   every difference as either *required* or *deliberately not forwarded*. Inspection is what missed
   both defects for the lifetime of the job.

## Acceptance evidence

Not an exit status. A CI run must show, for the agent spec files, a **non-zero executed count and a
zero skip count**, and the same for the two admin spec files. The reproduction that proves the
mechanism, run locally against the CI invocation verbatim:

```text
without -e E2E_AGENT_PRODUCTION :  Running 3 tests using 1 worker → 3 skipped, EXIT=0
with    -e E2E_AGENT_PRODUCTION :  all 3 execute
```
