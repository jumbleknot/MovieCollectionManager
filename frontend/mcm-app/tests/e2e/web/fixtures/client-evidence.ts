/**
 * Capture what the BROWSER saw, for a test that did not reach its expected status.
 *
 * WHY THIS EXISTS: roughly one `app-e2e` run in seven collapses — every agent/dock spec fails at
 * once, `flaky=0`, and the gateway receives about a quarter of its usual traffic while answering
 * everything it does receive with 200 (backlog item #173). Every SERVER-side channel has been
 * exhausted: containers healthy, contention counters zero, `assistant_not_configured` never fired,
 * and the known `@expo/server` closed-stream drop appears in a healthy run too.
 *
 * What is left is the client, and nothing observed it. Before this fixture the only `page.on(...)`
 * anywhere under `tests/e2e/web/` was a `'response'` listener in `perf.spec.ts`. So the one question
 * that would settle #173 — did the client DISPATCH the turn and the request never left, or was the
 * turn never dispatched at all? — had no instrument.
 *
 * FR-012 (do not become the perturbation): everything is buffered in memory in a bounded ring and
 * written **only** when the test did not reach its expected status. A passing run pays for a few
 * array pushes and writes nothing.
 *
 * FR-011 (no credential material): headers are redacted through `redactHeaders`, and request bodies
 * are never recorded at all — an agent turn's body is member-authored text, and the capture has no
 * need for it to answer the dispatch question.
 *
 * Composed into the shared `test` object by `./worker-session.ts`. Three specs deliberately do not
 * import that object — `auth.spec.ts`, `security-headers.spec.ts`, `bff-prod-lifecycle.spec.ts` —
 * so they get no capture. That is an accepted boundary rather than an oversight: the collapse
 * manifests in the agent/dock specs, and those three run unauthenticated by design.
 */
import { test as base } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEvidenceRing, redactHeaders } from './client-evidence-buffer';

/**
 * 500 entries per test, chosen against the measured traffic rather than picked round: a HEALTHY run
 * drives ~155 gateway turns across the WHOLE suite, so one test never approaches this, while a
 * runaway console loop still cannot exhaust memory.
 */
const RING_LIMIT = 500;

/** Written into the workspace, which the Playwright container mounts at /work. */
const OUTPUT_DIR = 'client-evidence';

/** The routes that carry an agent turn. A turn that never appears here is a turn never sent. */
const AGENT_ROUTE = /\/(bff-api\/agent|agent\/movie-assistant)/;

const stamp = () => new Date().toISOString();

/** A filesystem-safe name that still identifies the test to a human reading the bundle. */
function evidenceFileName(titlePath: string[]): string {
  const slug = titlePath.join(' > ').replace(/[^A-Za-z0-9._ >-]+/g, '-').replace(/\s+/g, '_').slice(0, 120);
  return `client-evidence-${slug || 'unnamed'}.log`;
}

export const test = base.extend<{ clientEvidence: void }>({
  clientEvidence: [
    async ({ page }, use, testInfo) => {
      const ring = createEvidenceRing<string>(RING_LIMIT);

      page.on('console', (msg) => {
        // `msg.text()` only — never `msg.args()`, which would serialise live handles and can drag
        // application state (including whatever a component holds) into the log.
        ring.push(`${stamp()} console.${msg.type()} ${msg.text()}`);
      });

      page.on('pageerror', (err) => {
        ring.push(`${stamp()} pageerror ${err.name}: ${err.message}`);
      });

      page.on('requestfailed', (req) => {
        ring.push(`${stamp()} requestfailed ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`);
      });

      // Agent traffic only. Recording every request would bury the signal under the app's own asset
      // and data chatter, and the question this answers is specifically about turns.
      page.on('request', (req) => {
        if (!AGENT_ROUTE.test(req.url())) return;
        const headers = redactHeaders(req.headers());
        ring.push(`${stamp()} request ${req.method()} ${req.url()} headers=${JSON.stringify(headers)}`);
      });

      page.on('response', (res) => {
        if (!AGENT_ROUTE.test(res.url())) return;
        ring.push(`${stamp()} response ${res.status()} ${res.url()}`);
      });

      await use();

      // The whole point of FR-012: a passing test writes nothing at all.
      if (testInfo.status === testInfo.expectedStatus) return;

      const { entries, dropped } = ring.drain();
      const header = [
        `# client evidence for: ${testInfo.titlePath.join(' > ')}`,
        `# status=${testInfo.status} expected=${testInfo.expectedStatus} retry=${testInfo.retry}`,
        dropped > 0
          ? `# TRUNCATED — ${dropped} earlier entr${dropped === 1 ? 'y' : 'ies'} dropped (ring limit ${RING_LIMIT})`
          : `# complete — nothing dropped (ring limit ${RING_LIMIT})`,
        entries.length === 0
          ? '# NO CLIENT ACTIVITY RECORDED — no console output, no page error, and no agent request left the browser'
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      try {
        mkdirSync(OUTPUT_DIR, { recursive: true });
        writeFileSync(join(OUTPUT_DIR, evidenceFileName(testInfo.titlePath)), `${header}\n${entries.join('\n')}\n`);
      } catch {
        // A diagnostic must never fail the test it is diagnosing. The test's own result is the
        // signal; losing its capture is a degradation, not an error.
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
