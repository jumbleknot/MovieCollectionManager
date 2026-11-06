/**
 * Feature 089. Stops zod's `new Function("")` availability probe in the browser, where the strict CSP
 * blocks it and reports a violation. zod's fast path is already off there because `eval` is blocked, so
 * this costs nothing. `assistant-panel.tsx` imports this first, because zod reads the setting when the
 * first object schema is built.
 */
import { config } from 'zod';

config({ jitless: true });
