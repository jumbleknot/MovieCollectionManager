/**
 * Feature 054 US3 — the client-evidence buffer: redaction and bounded retention.
 *
 * Nothing captures the browser today, which is why item #173 has exhausted every server-side channel
 * without finding the collapse's mechanism. This buffer is that missing channel — and because it
 * records network activity from an authenticated session, "we do not log secrets" is exactly the kind
 * of claim that needs a test rather than a comment.
 *
 * The helpers live in their own dependency-free module rather than inside the Playwright fixture, for
 * a mechanical reason: `/tests/e2e/` is in jest's `testPathIgnorePatterns`, and a module importing
 * `@playwright/test` cannot be loaded by jest at all. Splitting the pure logic out is what makes it
 * testable in the unit tier instead of only inside a 30-minute E2E run.
 */
import {
  createEvidenceRing,
  redactHeaders,
  REDACTED_HEADER_NAMES,
} from '../e2e/web/fixtures/client-evidence-buffer';

describe('redactHeaders', () => {
  it('drops every credential-bearing header, case-insensitively', () => {
    const out = redactHeaders({
      cookie: 'mcm_sid=abc123; other=x',
      Cookie: 'mcm_sid=abc123',
      'set-cookie': 'mcm_sid=abc123; HttpOnly',
      AUTHORIZATION: 'Bearer eyJhbGciOi.reallylong.token',
      'x-agent-config': '{"apiKey":"sk-ant-secret"}',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    });

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('abc123');
    expect(serialised).not.toContain('eyJhbGciOi');
    expect(serialised).not.toContain('sk-ant-secret');
    // What survives is what makes a request identifiable without being a credential.
    expect(out['content-type']).toBe('application/json');
    expect(out['accept']).toBe('text/event-stream');
  });

  it('names the redacted headers rather than removing them silently', () => {
    // A removed header and an absent header are different facts. If the capture ever needs to answer
    // "was this request authenticated at all?", a silent drop makes that unanswerable.
    const out = redactHeaders({ cookie: 'mcm_sid=abc123' });
    expect(out['cookie']).toBe('[redacted]');
  });

  it('redacts a header added to the list without touching the call sites', () => {
    for (const name of REDACTED_HEADER_NAMES) {
      const out = redactHeaders({ [name]: 'secret-value-here' });
      expect(JSON.stringify(out)).not.toContain('secret-value-here');
    }
  });
});

describe('createEvidenceRing', () => {
  it('keeps everything while under the limit', () => {
    const ring = createEvidenceRing(5);
    ring.push('a');
    ring.push('b');
    expect(ring.drain()).toEqual({ entries: ['a', 'b'], dropped: 0 });
  });

  it('drops the OLDEST entries past the limit and reports how many', () => {
    // A truncated capture must never read as a complete one. Without the count, a reader cannot tell
    // "the run made 3 requests" from "the run made 3000 and this is the tail".
    const ring = createEvidenceRing(3);
    for (const v of ['a', 'b', 'c', 'd', 'e']) ring.push(v);
    expect(ring.drain()).toEqual({ entries: ['c', 'd', 'e'], dropped: 2 });
  });

  it('survives a runaway producer without unbounded growth', () => {
    const ring = createEvidenceRing(10);
    for (let i = 0; i < 100_000; i++) ring.push(i);
    const { entries, dropped } = ring.drain();
    expect(entries).toHaveLength(10);
    expect(entries[9]).toBe(99_999);
    expect(dropped).toBe(99_990);
  });

  it('a limit of zero retains nothing and still counts', () => {
    const ring = createEvidenceRing(0);
    ring.push('a');
    expect(ring.drain()).toEqual({ entries: [], dropped: 1 });
  });
});
