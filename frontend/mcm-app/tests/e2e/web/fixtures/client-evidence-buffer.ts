/**
 * Bounded, redacted retention for the client-side evidence capture (feature 054 US3, FR-010..FR-012).
 *
 * Kept in its own dependency-free module rather than inside the Playwright fixture for two reasons,
 * one mechanical and one about testability:
 *   * `/tests/e2e/` is in jest's `testPathIgnorePatterns`, and a module importing `@playwright/test`
 *     cannot be loaded by jest at all — so pure logic living next to the fixture is unreachable from
 *     the unit tier and could only be exercised inside a 30-minute E2E run;
 *   * redaction is a security property. "We do not log secrets" is exactly the class of claim that
 *     needs a test rather than a comment (see tests/unit/client-evidence-buffer.test.ts).
 */

/**
 * Headers dropped before anything is written.
 *
 * `x-agent-config` is on the list and is easy to miss: the BFF forwards the member's per-user agent
 * configuration in it, which carries their model-provider API key.
 */
export const REDACTED_HEADER_NAMES = [
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-agent-config',
  'x-api-key',
] as const;

const REDACTED = '[redacted]';
const redactedSet = new Set<string>(REDACTED_HEADER_NAMES);

/**
 * Replace credential-bearing header VALUES, keeping the header names.
 *
 * Replacing rather than deleting is deliberate: a removed header and an absent header are different
 * facts, and the capture exists to answer questions like "was this request even authenticated?".
 * Dropping the key entirely would make that unanswerable while looking tidier.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = redactedSet.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

export interface EvidenceRing<T> {
  push: (entry: T) => void;
  drain: () => { entries: T[]; dropped: number };
}

/**
 * A ring that keeps the most recent `limit` entries and COUNTS what it discarded.
 *
 * The count is the point. A truncated capture that does not say it was truncated reads as a complete
 * one, and a reader cannot tell "this run made 3 requests" from "this run made 3000 and this is the
 * tail" — which are opposite conclusions about a suspected collapse.
 *
 * The most recent entries are kept rather than the earliest: a test fails at its end, so the traffic
 * nearest the failure is the traffic worth having.
 */
export function createEvidenceRing<T>(limit: number): EvidenceRing<T> {
  const max = Math.max(0, limit);
  const entries: T[] = [];
  let dropped = 0;

  return {
    push(entry: T) {
      if (max === 0) {
        dropped += 1;
        return;
      }
      entries.push(entry);
      if (entries.length > max) {
        entries.shift();
        dropped += 1;
      }
    },
    drain() {
      return { entries: [...entries], dropped };
    },
  };
}
