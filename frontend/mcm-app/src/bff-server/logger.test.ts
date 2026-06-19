// Unit test for logger redaction of feature-018 secret fields (FR-024, NFR-Sec-3).

import { logger } from './logger';

describe('logger redaction — agent config secrets (018)', () => {
  let logged: string[];
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logged = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((line) => { logged.push(String(line)); });
    errSpy = jest.spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  const SECRET = 'super-secret-value-do-not-leak';

  it.each([
    'anthropicKey',
    'tmdbKey',
    'anthropicKeyEnc',
    'tmdbKeyEnc',
    'agentConfig',
    'AGENT_CONFIG_ENC_KEY',
  ])('redacts %s and never emits the raw value', (field) => {
    logger.info('test', { [field]: SECRET });
    const out = logged.join('\n');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(SECRET);
  });
});
