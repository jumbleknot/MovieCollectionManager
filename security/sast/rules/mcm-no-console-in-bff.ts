// Test fixture for mcm-no-console-in-bff (semgrep --test). Intentionally-insecure sample —
// excluded from the product scan via .semgrepignore. Do not import.

import { logger } from '@/bff-server/logger';

function handler(err: unknown) {
  // ruleid: mcm-no-console-in-bff
  console.log('debug value');
  // ruleid: mcm-no-console-in-bff
  console.error('request failed', err);
  // ruleid: mcm-no-console-in-bff
  console.warn('deprecated path');

  // ok: mcm-no-console-in-bff
  logger.error('request failed', { error: err });
  // ok: mcm-no-console-in-bff
  logger.info('handled');
}
