// Test fixture for mcm-no-token-logging (semgrep --test). Intentionally-insecure sample —
// excluded from the product scan via .semgrepignore. Do not import.

import { logger } from '@/bff-server/logger';

function handler(user: any, session: any) {
  // ruleid: mcm-no-token-logging
  logger.info('login', { accessToken: user.accessToken });
  // ruleid: mcm-no-token-logging
  logger.error('auth failure', user.email);
  // ruleid: mcm-no-token-logging
  console.log('session', { sessionId: session.id, note: 'x' });
  // ruleid: mcm-no-token-logging
  logger.debug('token', user.refreshToken);

  // ok: mcm-no-token-logging
  logger.info('login', { userId: user.id });
  // ok: mcm-no-token-logging
  logger.info('session started', { requestId: session.requestId });
}
