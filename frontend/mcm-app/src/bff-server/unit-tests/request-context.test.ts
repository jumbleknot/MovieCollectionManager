import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';

let logSpy: jest.SpyInstance;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

function capturedEntry(spy: jest.SpyInstance): Record<string, unknown> {
  return JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
}

// ─── Correlation ID propagation ───────────────────────────────────────────────

describe('requestId propagation', () => {
  it('includes requestId in log entries when inside withRequestContext', async () => {
    await withRequestContext(async () => {
      logger.info('test');
    });
    const entry = capturedEntry(logSpy);
    expect(typeof entry['requestId']).toBe('string');
    expect(entry['requestId']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('omits requestId from log entries when outside any context', () => {
    logger.info('no context');
    const entry = capturedEntry(logSpy);
    expect(entry['requestId']).toBeUndefined();
  });

  it('generates a unique requestId for each withRequestContext call', async () => {
    const ids: string[] = [];

    await withRequestContext(async () => {
      logger.info('first');
      ids.push(capturedEntry(logSpy)['requestId'] as string);
      logSpy.mockClear();
    });

    await withRequestContext(async () => {
      logger.info('second');
      ids.push(capturedEntry(logSpy)['requestId'] as string);
    });

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('shares the same requestId across nested async calls within one context', async () => {
    const ids: string[] = [];

    await withRequestContext(async () => {
      logger.info('before await');
      ids.push(capturedEntry(logSpy)['requestId'] as string);
      logSpy.mockClear();

      await Promise.resolve();

      logger.info('after await');
      ids.push(capturedEntry(logSpy)['requestId'] as string);
    });

    expect(ids[0]).toBe(ids[1]);
  });

  it('uses separate requestIds for concurrent contexts', async () => {
    const ids: string[] = [];

    await Promise.all([
      withRequestContext(async () => {
        await Promise.resolve();
        logger.info('context A');
        ids.push(capturedEntry(logSpy)['requestId'] as string);
        logSpy.mockClear();
      }),
      withRequestContext(async () => {
        await Promise.resolve();
        logger.info('context B');
        ids.push(capturedEntry(logSpy)['requestId'] as string);
        logSpy.mockClear();
      }),
    ]);

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ─── Debug suppression ────────────────────────────────────────────────────────

describe('debug suppression', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env['NODE_ENV'];
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('suppresses debug when NODE_ENV=production', () => {
    process.env['NODE_ENV'] = 'production';
    logger.debug('should be suppressed');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('emits debug when NODE_ENV=development', () => {
    process.env['NODE_ENV'] = 'development';
    logger.debug('should appear');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('emits debug in test environment (default Jest NODE_ENV)', () => {
    // Jest sets NODE_ENV='test' by default — debug must not be suppressed
    logger.debug('should appear in test');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('does not suppress info/warn/error in production', () => {
    process.env['NODE_ENV'] = 'production';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
