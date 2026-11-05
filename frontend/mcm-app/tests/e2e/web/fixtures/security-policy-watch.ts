/**
 * Records what a browser refused or crashed on: CSP violations and uncaught page errors (feature 087).
 *
 * WHY THIS EXISTS. A script the CSP blocks produces no failed request and no red line anywhere the
 * suite looks, so a page can stop hydrating while every locator-free check stays green. In the SDK 58
 * spike the hydrate script's hash changed and pages stopped working, and only the browser knew.
 *
 * It watches a whole context, so the sign-in popup's return to the app is covered too. Only the app's
 * own documents count: the identity provider's pages have their own policy, which is not ours to assert.
 *
 * Three things each run depends on, so a pass means something:
 *   - `assertRightServer`: Metro sends neither a CSP nor `X-BFF-Source`, and a walk under it would pass
 *     having tested nothing. Locally that is a visible skip; with `CI` set it fails.
 *   - `proveCanSee`: an injected inline script must be seen before the list is trusted. Call
 *     `assertClean` first, because an inline violation from the page's own load would satisfy the probe.
 *   - `assertClean`: allows nothing by default. An exception is passed at the call site, so reading a
 *     test tells you exactly what it tolerates.
 */
import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';

export interface PolicyViolation {
  directive: string;
  blockedURI: string;
  source: string;
  documentUrl: string;
  /** Identifies one loaded document, so an exception can be limited per document. */
  documentId: string;
}

/** A violation a test has decided to tolerate, and how many times per document. */
export interface PolicyException {
  description: string;
  matches: (violation: PolicyViolation) => boolean;
  maxPerDocument: number;
}

export interface SecurityPolicyWatch {
  violations: PolicyViolation[];
  pageErrors: string[];
  proveCanSee: (page: Page) => Promise<void>;
  assertClean: (step: string, options?: { allow?: PolicyException[] }) => void;
}

const BINDING = '__mcmRecordPolicyViolation';

const describeViolation = (v: PolicyViolation): string =>
  `${v.directive} blocked ${v.blockedURI || '(no URI)'} from ${v.source || '(inline)'} on ${v.documentUrl}`;

/** Start watching. Call before the first navigation, or an early violation is missed. */
export async function watchSecurityPolicy(context: BrowserContext, baseUrl: string): Promise<SecurityPolicyWatch> {
  const violations: PolicyViolation[] = [];
  const pageErrors: string[] = [];
  const isAppUrl = (url: string): boolean => url.startsWith(baseUrl);

  await context.exposeBinding(BINDING, (_source, violation: PolicyViolation) => {
    if (isAppUrl(violation.documentUrl)) violations.push(violation);
  });
  // The binding, not an array on `window`: a list on the page would be lost at every reload.
  // Origin and path only. These lines reach CI logs, and the sign-in callback's query carries OAuth values.
  await context.addInitScript((binding: string) => {
    const withoutQuery = (url: string): string => url.split(/[?#]/)[0] ?? '';
    const documentUrl = location.origin + location.pathname;
    const documentId = `${documentUrl}#${performance.timeOrigin}`;
    document.addEventListener('securitypolicyviolation', (e) => {
      void (window as unknown as Record<string, (v: PolicyViolation) => Promise<void>>)[binding]({
        directive: e.effectiveDirective,
        blockedURI: withoutQuery(e.blockedURI),
        source: withoutQuery(e.sourceFile),
        documentUrl,
        documentId,
      });
    });
  }, BINDING);

  const listen = (page: Page): void => {
    page.on('pageerror', (error) => {
      if (isAppUrl(page.url())) pageErrors.push(error.message);
    });
  };
  context.pages().forEach(listen);
  context.on('page', listen);

  return {
    violations,
    pageErrors,

    async proveCanSee(page: Page): Promise<void> {
      await page.evaluate(() => {
        const script = document.createElement('script');
        script.textContent = 'window.__mcmPolicyWatchProbe = 1;';
        document.head.appendChild(script);
      });
      await expect
        .poll(() => violations.some((v) => v.blockedURI === 'inline'), {
          message: 'an injected inline script was not reported, so a clean result from this watch would mean nothing',
          timeout: 5_000,
        })
        .toBe(true);
      // Only the probe's own line goes. Anything else stays counted, including an allowed exception.
      violations.splice(violations.findLastIndex((v) => v.blockedURI === 'inline'), 1);
    },

    assertClean(step: string, { allow = [] }: { allow?: PolicyException[] } = {}): void {
      const perDocument = new Map<string, number>();
      const unexpected = violations.filter((v) => {
        const exception = allow.find((a) => a.matches(v));
        if (!exception) return true;
        const key = `${exception.description}|${v.documentId}`;
        const count = (perDocument.get(key) ?? 0) + 1;
        perDocument.set(key, count);
        return count > exception.maxPerDocument;
      });
      const lines = [
        ...unexpected.map((v) => `CSP violation: ${describeViolation(v)}`),
        ...pageErrors.map((message) => `page error: ${message}`),
      ];
      expect(lines, `${step}: the browser refused or crashed on something`).toEqual([]);
    },
  };
}

/**
 * Metro sets neither header, and a walk under it passes having tested nothing. Skip visibly in local
 * use, and fail under `CI`, where a skip would read as a pass.
 */
export function assertRightServer(response: Response | null): void {
  const csp = response?.headers()['content-security-policy'];
  const source = response?.headers()['x-bff-source'] ?? '';
  const right = Boolean(csp) && /-container$/.test(source);
  if (right) return;
  const why = `not the BFF container: Content-Security-Policy ${csp ? 'present' : 'absent'}, X-BFF-Source "${source}"`;
  if (process.env['CI']) throw new Error(`The security policy walk must run against a container, but this is ${why}`);
  test.skip(true, `Needs E2E_BFF_TARGET=dev-container: this is ${why}`);
}
