// Structured JSON logger for BFF server-side use only (bff-server/, bff-api/).
// Outputs newline-delimited JSON to stdout (info/debug) or stderr (warn/error).
// Redacts sensitive fields so tokens, session IDs, and PII never reach log sinks.

import { getRequestId } from '@/bff-server/request-context';

const SENSITIVE_KEYS = new Set([
  'password',
  'token', 'accessToken', 'refreshToken', 'idToken',
  'id_token', 'access_token', 'refresh_token',
  'secret', 'clientSecret', 'client_secret',
  'sessionId', 'session_id',
  'cookie', 'authorization',
  'code', 'codeVerifier', 'code_verifier',
  'email', 'username',
]);

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const result: LogContext = {};
  for (const [k, v] of Object.entries(value as LogContext)) {
    result[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return result;
}

function write(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (level === 'debug' && process.env['NODE_ENV'] === 'production') return;

  const requestId = getRequestId();
  let entry: string;
  try {
    entry = JSON.stringify({
      time: new Date().toISOString(),
      level,
      service: 'mcm-bff',
      ...(requestId !== undefined ? { requestId } : {}),
      msg,
      ...((ctx ? redact(ctx) : {}) as LogContext),
    });
  } catch {
    entry = JSON.stringify({
      time: new Date().toISOString(),
      level,
      service: 'mcm-bff',
      ...(requestId !== undefined ? { requestId } : {}),
      msg,
      serializationError: true,
    });
  }
  if (level === 'error' || level === 'warn') {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => write('debug', msg, ctx),
  info:  (msg: string, ctx?: LogContext) => write('info',  msg, ctx),
  warn:  (msg: string, ctx?: LogContext) => write('warn',  msg, ctx),
  error: (msg: string, ctx?: LogContext) => write('error', msg, ctx),
  // For security-relevant events: login, logout, auth failure, access denied, rate limits.
  // Include who (userId — Keycloak UUID, never email/username) and from where (ip) where available.
  audit: (action: string, ctx?: Omit<LogContext, 'action'>) =>
    write('info', `audit:${action}`, { audit: true, action, ...ctx }),
};
