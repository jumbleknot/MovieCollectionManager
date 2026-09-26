/**
 * The assistant runtime's one dynamic-import boundary (feature 077; item #558).
 *
 * WHY A MODULE RATHER THAN AN INLINE `import()`. Two things load the assistant panel — the idle
 * prefetch (`use-assistant-runtime`) and the user pressing the dock toggle — and they must share one
 * fetch. Two inline `import()` calls would be deduplicated by the module registry in practice, but
 * nothing would SAY so, and nothing would make the retry behaviour below true. Routing both through
 * one function makes the single-flight property a property of this file, and testable.
 *
 * WHY THE REJECTION IS NOT CACHED. The obvious form is `inFlight ??= importer()`. It is
 * single-flight, and it is wrong: a rejected promise stays in the cache, so the FIRST failed chunk
 * fetch disables the assistant for the rest of the page's life and the user's only recovery is a
 * reload — for a chunk that would very likely have arrived on a second attempt. Clearing on
 * rejection is what makes FR-006 ("remains openable on a subsequent attempt") true.
 *
 * WHAT THIS IS WORTH. The deferred chunk is ~2.4 MB: the model client, its schema validator, its
 * GraphQL client, the AG-UI transport, and the React Native polyfills that `@copilotkit/react-native`
 * imports as a side effect of its own entry point. None of it is needed to paint a route, and before
 * this it was in the entry chunk on every authenticated screen.
 */
import type { ComponentType } from 'react';

/** What the deferred module exports: the panel, already wrapped in its provider. */
export type AssistantRuntimeModule = { default: ComponentType<Record<string, never>> };

type Importer = () => Promise<AssistantRuntimeModule>;

// The real boundary. `@/components/agent/assistant-panel` is the ONLY place the assistant's
// dependencies are reachable from, which is what keeps them out of the entry chunk — adding a
// static import of it anywhere in the eager graph silently undoes this whole feature, which is why
// `scripts/check-web-bundle-budget.mjs` asserts those packages contribute zero entry-chunk modules.
const importRuntime: Importer = () =>
  import('@/components/agent/assistant-panel') as Promise<AssistantRuntimeModule>;

let inFlight: Promise<AssistantRuntimeModule> | null = null;

/**
 * Load the assistant runtime, at most once per page session.
 *
 * `importer` is injectable so the contract above is unit-testable without mocking the module
 * system; production always uses the default.
 */
export function loadAssistantRuntime(importer: Importer = importRuntime): Promise<AssistantRuntimeModule> {
  if (inFlight) return inFlight;
  const attempt = importer().catch((err: unknown) => {
    // Clear BEFORE rethrowing, so every concurrent caller sees this rejection while the next
    // caller gets a fresh attempt.
    if (inFlight === attempt) inFlight = null;
    throw err;
  });
  inFlight = attempt;
  return attempt;
}

/** Drop the cached module so a test can observe a fresh load. Test-only. */
export function resetAssistantRuntimeForTest(): void {
  inFlight = null;
}
