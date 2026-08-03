/**
 * The agent-E2E gate — and the switch that makes a missed stack LOUD instead of silent.
 *
 * Every `agent-*.spec.ts` needs the containerized production-node stack (gateway + MCP servers,
 * `scripts/agent-stack.mjs`) and un-gates on `E2E_AGENT_PRODUCTION=1`. Without it the specs skip,
 * which is right for a developer running the general web suite — those specs genuinely cannot run.
 *
 * The trap that motivated this module: the final-validation checklist says "run
 * `pnpm nx e2e mcm-app`", and that command alone skips EVERY agent spec. The suite reports green,
 * and nobody learns the agent flows never ran. A suite that passes for the wrong reason is worse
 * than one that does not run — the same reasoning behind `MCM_REQUIRE_LIVE_STACK` in the Python
 * integration tiers and `mc-service-integration-guard.mjs`'s no-false-green check.
 *
 * So: set `E2E_REQUIRE_AGENT_STACK=1` whenever the agent stack is SUPPOSED to be up — in CI, and
 * in any pre-PR validation run — and a missing `E2E_AGENT_PRODUCTION` becomes a hard failure that
 * names what to start, rather than a green tick.
 *
 * Usage — first line inside the describe block:
 *
 *   test.describe('…', () => {
 *     requireAgentStack(test);
 *     …
 *   });
 */
import type { test as PlaywrightTest } from '@playwright/test';

export const AGENT_STACK_ENV = 'E2E_AGENT_PRODUCTION';
export const REQUIRE_AGENT_STACK_ENV = 'E2E_REQUIRE_AGENT_STACK';

const SKIP_REASON =
  'Needs the production-node gateway + a runnable dock config (TMDB). ' +
  'Deploy with `node scripts/agent-stack.mjs` and run with E2E_AGENT_PRODUCTION=1 ' +
  '(or `node scripts/agent-e2e.mjs`, which sets both).';

const FAIL_REASON =
  `${REQUIRE_AGENT_STACK_ENV}=1 says the agent stack is supposed to be up, but ` +
  `${AGENT_STACK_ENV} is not set — so this suite would have SKIPPED and reported green.\n` +
  'Bring the stack up before the run:\n' +
  '  node scripts/agent-stack.mjs           # deploy gateway + MCP servers\n' +
  '  node scripts/agent-e2e.mjs             # runs every agent spec, isolated per file\n' +
  'See openwiki/invariants/feature-validation-checklist.md.';

export function agentStackEnabled(): boolean {
  return process.env[AGENT_STACK_ENV] === '1';
}

export function agentStackRequired(): boolean {
  return process.env[REQUIRE_AGENT_STACK_ENV] === '1';
}

/**
 * Gate a describe block on the agent stack.
 *
 * - stack up            → run normally.
 * - stack down, not required → skip with a reason naming how to bring it up.
 * - stack down, REQUIRED     → fail loudly, because a silent skip here is a false green.
 */
export function requireAgentStack(test: typeof PlaywrightTest): void {
  if (agentStackEnabled()) return;

  if (agentStackRequired()) {
    // A `beforeAll` throw fails the suite rather than skipping it. Deliberately not
    // `test.fail()`, which marks tests as EXPECTED to fail — that would be another quiet pass.
    test.beforeAll(() => {
      throw new Error(FAIL_REASON);
    });
    return;
  }

  test.skip(true, SKIP_REASON);
}
