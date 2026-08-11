/**
 * Capture the BFF logger's structured output for assertion.
 *
 * The logger writes newline-delimited JSON to stdout (debug/info) or stderr (warn/error).
 * Intercepting the process's own console is NOT a Test Type Integrity violation: the integrated
 * dependencies (Redis, Keycloak, mc-service) stay real and unmocked. Only this process's console is
 * captured, only for the duration of the call, and it is always restored.
 *
 * Feature 052 FR-001/FR-002/FR-003 — the events these helpers observe are the measurement the
 * feature exists to take, so a test that cannot see them cannot verify the feature.
 */

/** One decoded structured log line. `action` is present on `logger.audit` entries. */
export interface CapturedLogEntry {
  level?: string;
  msg?: string;
  action?: string;
  audit?: boolean;
  [key: string]: unknown;
}

/**
 * Run `fn` with the console captured, and return every structured entry it wrote.
 *
 * Non-JSON console output (a stray `console.log` from a dependency) is ignored rather than throwing —
 * the caller is asking "what did the logger emit", not "was anything else printed".
 */
export async function captureLogEntries(fn: () => Promise<void>): Promise<CapturedLogEntry[]> {
  const raw: string[] = [];
  const collect = (...args: unknown[]) => { raw.push(args.map(String).join(' ')); };

  const originalLog = console.log;
  const originalError = console.error;
  console.log = collect as typeof console.log;
  console.error = collect as typeof console.error;

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const entries: CapturedLogEntry[] = [];
  for (const line of raw) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed as CapturedLogEntry);
    } catch {
      // Not structured output — not what the caller is asking about.
    }
  }
  return entries;
}

/** The entries whose audit action matches `action`. */
export function auditEntriesFor(entries: CapturedLogEntry[], action: string): CapturedLogEntry[] {
  return entries.filter((e) => e.action === action);
}

/**
 * Assert that nothing credential-bearing reached the log.
 *
 * Checks the SERIALISED entry, so a secret nested at any depth is caught. Returns the offending
 * fragments so a failure names what leaked rather than only that something did.
 */
export function findCredentialLeaks(
  entries: CapturedLogEntry[],
  forbiddenValues: readonly string[],
): string[] {
  const serialised = entries.map((e) => JSON.stringify(e)).join('\n');
  return forbiddenValues.filter((v) => v.length > 0 && serialised.includes(v));
}
