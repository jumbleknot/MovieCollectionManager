/**
 * Unit tests for audit-sink.ts (T076c)
 *
 * Verifies:
 *   1. buildAuditDoc strips all redacted keys (token, access_token, email, etc.) + keeps safe keys.
 *   2. audit() always calls logger.audit once with the original fields.
 *   3. OPENSEARCH_URL unset → fetch NOT called.
 *   4. OPENSEARCH_URL set → fetch called once with the correct URL + a body free of redacted keys.
 *   5. A rejected fetch is swallowed (does not throw, logs an error).
 *   6. OPENSEARCH_INSECURE_TLS + https URL → postAuditDoc uses node:https (no fetch dispatcher).
 *   7. OPENSEARCH_INSECURE_TLS unset or http URL → postAuditDoc uses plain fetch (no node:https).
 */

import * as nodeHttps from 'node:https';
import { buildAuditDoc, audit, postAuditDoc } from '@/bff-server/audit-sink';
import { logger } from '@/bff-server/logger';

jest.mock('@/bff-server/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    audit: jest.fn(),
  },
}));

const mockFetch = jest.fn();

beforeAll(() => {
  global.fetch = mockFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, status: 201 });
  // Ensure env is clean before each test.
  delete process.env['OPENSEARCH_URL'];
  delete process.env['OPENSEARCH_USERNAME'];
  delete process.env['OPENSEARCH_PASSWORD'];
  delete process.env['OPENSEARCH_INSECURE_TLS'];
});

// ─── buildAuditDoc ────────────────────────────────────────────────────────────

describe('buildAuditDoc', () => {
  it('keeps action + safe fields and strips all redacted keys', () => {
    const doc = buildAuditDoc('ui_action', {
      userId: 'u1',
      target: 'collection',
      token: 'X',
      access_token: 'Y',
      email: 'a@b.c',
      allowed: true,
    });

    expect(doc).toEqual({ action: 'ui_action', userId: 'u1', target: 'collection', allowed: true });
    expect(doc).not.toHaveProperty('token');
    expect(doc).not.toHaveProperty('access_token');
    expect(doc).not.toHaveProperty('email');
  });

  it('strips all keys in the REDACT set', () => {
    const redactedInput = {
      token: 'a',
      sessionId: 'b',
      password: 'c',
      secret: 'd',
      cookie: 'e',
      authorization: 'f',
      code: 'g',
      codeVerifier: 'h',
      email: 'i',
      username: 'j',
      safe: 'keep',
    };
    const doc = buildAuditDoc('test', redactedInput);

    const redactedKeys = ['token', 'sessionId', 'password', 'secret', 'cookie',
      'authorization', 'code', 'codeVerifier', 'email', 'username'];
    for (const key of redactedKeys) {
      expect(doc).not.toHaveProperty(key);
    }
    expect(doc['safe']).toBe('keep');
  });

  it('strips any key containing "token" (case-insensitive)', () => {
    const doc = buildAuditDoc('test', {
      access_token: 'x',
      refreshToken: 'y',
      idToken: 'z',
      userId: 'u1',
    });

    expect(doc).not.toHaveProperty('access_token');
    expect(doc).not.toHaveProperty('refreshToken');
    expect(doc).not.toHaveProperty('idToken');
    expect(doc['userId']).toBe('u1');
  });

  it('always includes the action field', () => {
    const doc = buildAuditDoc('approval_decision', { decision: 'approve' });
    expect(doc['action']).toBe('approval_decision');
  });

  it('handles an empty fields object', () => {
    const doc = buildAuditDoc('login', {});
    expect(doc).toEqual({ action: 'login' });
  });
});

// ─── audit() — logger.audit call ─────────────────────────────────────────────

describe('audit — logger.audit always called', () => {
  it('calls logger.audit exactly once with action and original fields', () => {
    audit('approval_decision', { userId: 'u1', decision: 'approve' });

    expect(logger.audit).toHaveBeenCalledTimes(1);
    expect(logger.audit).toHaveBeenCalledWith('approval_decision', { userId: 'u1', decision: 'approve' });
  });

  it('passes the ORIGINAL fields to logger.audit (including redacted keys — logger does its own redaction)', () => {
    audit('ui_action', { userId: 'u1', token: 'SHOULD_BE_IN_LOG_ARGS', allowed: true });

    // The original token is forwarded to logger.audit; the logger's own SENSITIVE_KEYS handling
    // is responsible for redacting it in the log output. audit() must not strip it before passing.
    expect(logger.audit).toHaveBeenCalledWith('ui_action', {
      userId: 'u1',
      token: 'SHOULD_BE_IN_LOG_ARGS',
      allowed: true,
    });
  });
});

// ─── audit() — OPENSEARCH_URL unset ──────────────────────────────────────────

describe('audit — OPENSEARCH_URL unset', () => {
  it('does NOT call fetch when OPENSEARCH_URL is not set', () => {
    audit('ui_action', { userId: 'u1', allowed: true });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when OPENSEARCH_URL is an empty string', () => {
    process.env['OPENSEARCH_URL'] = '';
    audit('ui_action', { userId: 'u1', allowed: true });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when OPENSEARCH_URL is only whitespace', () => {
    process.env['OPENSEARCH_URL'] = '   ';
    audit('ui_action', { userId: 'u1', allowed: true });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── audit() — OPENSEARCH_URL set ────────────────────────────────────────────

describe('audit — OPENSEARCH_URL set', () => {
  beforeEach(() => {
    process.env['OPENSEARCH_URL'] = 'http://localhost:9200';
    process.env['OPENSEARCH_USERNAME'] = 'admin';
    process.env['OPENSEARCH_PASSWORD'] = 'secret';
  });

  it('calls fetch exactly once with the /mcm-agent-audit/_doc URL', () => {
    audit('ui_action', { userId: 'u1', allowed: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:9200/mcm-agent-audit/_doc');
  });

  it('POSTs with content-type application/json', () => {
    audit('ui_action', { userId: 'u1', allowed: true });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('sends Basic auth header', () => {
    audit('ui_action', { userId: 'u1', allowed: true });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const authHeader = (init.headers as Record<string, string>)['authorization'];
    expect(authHeader).toMatch(/^Basic /);
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    expect(decoded).toBe('admin:secret');
  });

  it('body contains action + safe fields and NO redacted keys', () => {
    audit('approval_decision', {
      userId: 'u1',
      threadId: 't1',
      token: 'SHOULD_NOT_APPEAR',
      email: 'user@example.com',
      decision: 'approve',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body['action']).toBe('approval_decision');
    expect(body['userId']).toBe('u1');
    expect(body['threadId']).toBe('t1');
    expect(body['decision']).toBe('approve');
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('email');
  });

  it('trailing slash in OPENSEARCH_URL is stripped', () => {
    process.env['OPENSEARCH_URL'] = 'http://localhost:9200/';
    audit('ui_action', { userId: 'u1', allowed: true });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:9200/mcm-agent-audit/_doc');
  });

  it('a rejected fetch is swallowed — does not throw', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));

    // Must not throw synchronously or propagate the rejection.
    expect(() => audit('ui_action', { userId: 'u1', allowed: true })).not.toThrow();

    // Flush microtasks so the rejected promise settles and the .catch fires.
    await Promise.resolve();
    await Promise.resolve();

    // logger.error is called for the swallowed fetch failure.
    expect(logger.error).toHaveBeenCalledWith(
      'audit append failed',
      expect.objectContaining({ action: 'audit_append' }),
    );
  });

  it('logger.audit is STILL called even when OPENSEARCH_URL is set (additive, not replacing)', () => {
    audit('ui_action', { userId: 'u1', allowed: true });

    expect(logger.audit).toHaveBeenCalledTimes(1);
    expect(logger.audit).toHaveBeenCalledWith('ui_action', { userId: 'u1', allowed: true });
  });
});

// ─── postAuditDoc — OPENSEARCH_INSECURE_TLS ───────────────────────────────────

describe('postAuditDoc — OPENSEARCH_INSECURE_TLS', () => {
  const AUTH = 'Basic dGVzdDp0ZXN0';
  const BODY = JSON.stringify({ action: 'test' });

  beforeEach(() => {
    // Restore any https.request spy before each test
    jest.restoreAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 201 });
  });

  it('uses plain fetch (no node:https) when OPENSEARCH_INSECURE_TLS is unset + http URL', async () => {
    delete process.env['OPENSEARCH_INSECURE_TLS'];
    const httpsRequestSpy = jest.spyOn(nodeHttps, 'request');

    await postAuditDoc('http://localhost:9200/mcm-agent-audit/_doc', AUTH, BODY);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  });

  it('uses plain fetch (no node:https) when OPENSEARCH_INSECURE_TLS is unset + https URL', async () => {
    delete process.env['OPENSEARCH_INSECURE_TLS'];
    const httpsRequestSpy = jest.spyOn(nodeHttps, 'request');

    await postAuditDoc('https://localhost:9200/mcm-agent-audit/_doc', AUTH, BODY);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  });

  it('uses plain fetch (no node:https) when OPENSEARCH_INSECURE_TLS is truthy but URL is http', async () => {
    process.env['OPENSEARCH_INSECURE_TLS'] = 'true';
    const httpsRequestSpy = jest.spyOn(nodeHttps, 'request');

    await postAuditDoc('http://localhost:9200/mcm-agent-audit/_doc', AUTH, BODY);

    // http:// — no TLS needed; plain fetch path is used
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  });

  it('uses node:https with rejectUnauthorized:false when OPENSEARCH_INSECURE_TLS is truthy + https URL', async () => {
    process.env['OPENSEARCH_INSECURE_TLS'] = 'true';

    // Capture the options passed to nodeHttps.request — typed via unknown to avoid
    // TypeScript overload-resolution conflicts on the nodeHttps.request spy.
    let capturedOptions: unknown = null;
    const fakeReq = {
      on: jest.fn().mockReturnThis(),
      write: jest.fn().mockReturnThis(),
      end: jest.fn(),
    };
    const httpsRequestMock = jest.fn((options: unknown, callback?: (res: unknown) => void) => {
      capturedOptions = options;
      if (callback) callback({ statusCode: 200 });
      return fakeReq;
    });
    (nodeHttps as unknown as Record<string, unknown>)['request'] = httpsRequestMock;

    await postAuditDoc('https://localhost:9200/mcm-agent-audit/_doc', AUTH, BODY);

    // node:https path — fetch must NOT be called
    expect(mockFetch).not.toHaveBeenCalled();
    expect(capturedOptions).not.toBeNull();
    const opts = capturedOptions as Record<string, unknown>;
    expect(opts['rejectUnauthorized']).toBe(false);
    expect(opts['hostname']).toBe('localhost');
    expect(opts['method']).toBe('POST');
  });

  it('swallows node:https errors and does not throw', async () => {
    process.env['OPENSEARCH_INSECURE_TLS'] = 'true';

    let errorCallback: ((err: Error) => void) | null = null;
    const fakeReq = {
      on: jest.fn().mockImplementation((event: string, cb: (err: Error) => void) => {
        if (event === 'error') errorCallback = cb;
        return fakeReq;
      }),
      write: jest.fn().mockReturnThis(),
      end: jest.fn().mockImplementation(() => {
        // Fire the error after end() is called
        if (errorCallback) errorCallback(new Error('self-signed cert'));
      }),
    };
    (nodeHttps as unknown as Record<string, unknown>)['request'] = jest.fn(
      (_options: unknown, _callback?: unknown) => fakeReq,
    );

    await expect(
      postAuditDoc('https://localhost:9200/mcm-agent-audit/_doc', AUTH, BODY),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'audit append failed',
      expect.objectContaining({ action: 'audit_append' }),
    );
  });
});
