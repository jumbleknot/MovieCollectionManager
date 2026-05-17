import { logger } from '@/bff-server/logger';

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

function capturedEntry(spy: jest.SpyInstance): Record<string, unknown> {
  return JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
}

// ─── Output routing ───────────────────────────────────────────────────────────

describe('output routing', () => {
  it('writes debug to stdout (console.log)', () => {
    logger.debug('d');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('writes info to stdout (console.log)', () => {
    logger.info('i');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('writes warn to stderr (console.error)', () => {
    logger.warn('w');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('writes error to stderr (console.error)', () => {
    logger.error('e');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('writes audit to stdout (console.log)', () => {
    logger.audit('login');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ─── JSON output format ───────────────────────────────────────────────────────

describe('JSON output format', () => {
  it('outputs valid JSON', () => {
    logger.info('test message');
    expect(() => capturedEntry(logSpy)).not.toThrow();
  });

  it('includes required fields: time, level, service, msg', () => {
    logger.info('hello');
    const entry = capturedEntry(logSpy);
    expect(typeof entry['time']).toBe('string');
    expect(entry['level']).toBe('info');
    expect(entry['service']).toBe('mcm-bff');
    expect(entry['msg']).toBe('hello');
  });

  it('sets correct level for each method', () => {
    logger.debug('d'); expect(capturedEntry(logSpy)['level']).toBe('debug'); logSpy.mockClear();
    logger.info('i');  expect(capturedEntry(logSpy)['level']).toBe('info');  logSpy.mockClear();
    logger.warn('w');  expect(capturedEntry(errorSpy)['level']).toBe('warn'); errorSpy.mockClear();
    logger.error('e'); expect(capturedEntry(errorSpy)['level']).toBe('error');
  });

  it('includes context fields in output', () => {
    logger.info('msg', { requestId: 'abc-123', statusCode: 200 });
    const entry = capturedEntry(logSpy);
    expect(entry['requestId']).toBe('abc-123');
    expect(entry['statusCode']).toBe(200);
  });

  it('outputs valid JSON with no context', () => {
    logger.info('no context');
    const entry = capturedEntry(logSpy);
    expect(entry['msg']).toBe('no context');
  });
});

// ─── Sensitive field redaction ─────────────────────────────────────────────────

describe('sensitive field redaction', () => {
  it('redacts password to [REDACTED]', () => {
    logger.info('test', { password: 'secret123' });
    expect(capturedEntry(logSpy)['password']).toBe('[REDACTED]');
  });

  it('redacts token variants', () => {
    logger.info('test', { token: 'tok', accessToken: 'at', refreshToken: 'rt', idToken: 'it', id_token: 'it2', access_token: 'at2', refresh_token: 'rt2' });
    const entry = capturedEntry(logSpy);
    expect(entry['token']).toBe('[REDACTED]');
    expect(entry['accessToken']).toBe('[REDACTED]');
    expect(entry['refreshToken']).toBe('[REDACTED]');
    expect(entry['idToken']).toBe('[REDACTED]');
    expect(entry['id_token']).toBe('[REDACTED]');
    expect(entry['access_token']).toBe('[REDACTED]');
    expect(entry['refresh_token']).toBe('[REDACTED]');
  });

  it('redacts secret, clientSecret, client_secret', () => {
    logger.info('test', { secret: 's', clientSecret: 'cs', client_secret: 'cs2' });
    const entry = capturedEntry(logSpy);
    expect(entry['secret']).toBe('[REDACTED]');
    expect(entry['clientSecret']).toBe('[REDACTED]');
    expect(entry['client_secret']).toBe('[REDACTED]');
  });

  it('redacts sessionId and session_id', () => {
    logger.info('test', { sessionId: 'sid', session_id: 'sid2' });
    const entry = capturedEntry(logSpy);
    expect(entry['sessionId']).toBe('[REDACTED]');
    expect(entry['session_id']).toBe('[REDACTED]');
  });

  it('redacts cookie and authorization headers', () => {
    logger.info('test', { cookie: 'mcm_session=x', authorization: 'Bearer tok' });
    const entry = capturedEntry(logSpy);
    expect(entry['cookie']).toBe('[REDACTED]');
    expect(entry['authorization']).toBe('[REDACTED]');
  });

  it('redacts OAuth code and codeVerifier', () => {
    logger.info('test', { code: 'auth-code', codeVerifier: 'verifier', code_verifier: 'v2' });
    const entry = capturedEntry(logSpy);
    expect(entry['code']).toBe('[REDACTED]');
    expect(entry['codeVerifier']).toBe('[REDACTED]');
    expect(entry['code_verifier']).toBe('[REDACTED]');
  });

  it('redacts PII: email and username', () => {
    logger.info('test', { email: 'user@example.com', username: 'testuser' });
    const entry = capturedEntry(logSpy);
    expect(entry['email']).toBe('[REDACTED]');
    expect(entry['username']).toBe('[REDACTED]');
  });

  it('redacts sensitive fields in nested objects', () => {
    logger.info('test', { data: { token: 'nested-tok', userId: 'user-1' } });
    const entry = capturedEntry(logSpy) as { data: Record<string, unknown> };
    expect(entry.data['token']).toBe('[REDACTED]');
    expect(entry.data['userId']).toBe('user-1');
  });

  it('does not redact non-sensitive fields', () => {
    logger.info('test', { userId: 'user-uuid', ip: '1.2.3.4', action: 'login', statusCode: 200 });
    const entry = capturedEntry(logSpy);
    expect(entry['userId']).toBe('user-uuid');
    expect(entry['ip']).toBe('1.2.3.4');
    expect(entry['action']).toBe('login');
    expect(entry['statusCode']).toBe(200);
  });
});

// ─── Error serialization ──────────────────────────────────────────────────────

describe('Error serialization', () => {
  it('serializes Error to {name, message} — no stack trace', () => {
    const err = new Error('something went wrong');
    logger.error('an error occurred', { error: err });
    const entry = capturedEntry(errorSpy) as { error: Record<string, unknown> };
    expect(entry.error['name']).toBe('Error');
    expect(entry.error['message']).toBe('something went wrong');
    expect(entry.error['stack']).toBeUndefined();
  });

  it('serializes custom Error subclass with correct name', () => {
    class AuthError extends Error {
      constructor() { super('auth failed'); this.name = 'AuthError'; }
    }
    logger.error('auth error', { error: new AuthError() });
    const entry = capturedEntry(errorSpy) as { error: Record<string, unknown> };
    expect(entry.error['name']).toBe('AuthError');
    expect(entry.error['message']).toBe('auth failed');
  });

  it('does not throw when context contains a nested Error', () => {
    expect(() => logger.warn('nested error', { wrapper: { cause: new Error('cause') } })).not.toThrow();
  });
});

// ─── audit method ─────────────────────────────────────────────────────────────

describe('logger.audit', () => {
  it('sets msg to audit:<action>', () => {
    logger.audit('login');
    expect(capturedEntry(logSpy)['msg']).toBe('audit:login');
  });

  it('includes audit:true in output', () => {
    logger.audit('login');
    expect(capturedEntry(logSpy)['audit']).toBe(true);
  });

  it('includes action field matching the argument', () => {
    logger.audit('logout');
    const entry = capturedEntry(logSpy);
    expect(entry['action']).toBe('logout');
  });

  it('passes additional context fields through', () => {
    logger.audit('login', { userId: 'user-123', ip: '10.0.0.1', roles: ['mc-user'] });
    const entry = capturedEntry(logSpy);
    expect(entry['userId']).toBe('user-123');
    expect(entry['ip']).toBe('10.0.0.1');
    expect(entry['roles']).toEqual(['mc-user']);
  });

  it('still redacts sensitive fields in audit context', () => {
    logger.audit('token_event', { token: 'tok', userId: 'user-1' });
    const entry = capturedEntry(logSpy);
    expect(entry['token']).toBe('[REDACTED]');
    expect(entry['userId']).toBe('user-1');
  });

  it('level is info', () => {
    logger.audit('register');
    expect(capturedEntry(logSpy)['level']).toBe('info');
  });
});

// ─── Serialization failure resilience ─────────────────────────────────────────

describe('serialization failure', () => {
  it('does not throw when context contains a circular reference', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => logger.info('circular test', circular)).not.toThrow();
  });

  it('outputs a valid JSON entry with serializationError:true when serialization fails', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    logger.info('circular test', circular);
    const entry = capturedEntry(logSpy);
    expect(entry['serializationError']).toBe(true);
    expect(entry['msg']).toBe('circular test');
    expect(entry['level']).toBe('info');
  });
});
