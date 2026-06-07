/**
 * T025 — agent-gateway-client (server-side client to the AG-UI Agent Gateway).
 *
 * The BFF is the SOLE caller of the gateway, over the private network. This module
 * centralizes (a) mode-aware gateway-URL resolution — internal Docker DNS via
 * `AGENT_GATEWAY_URL` for the container BFF, loopback `127.0.0.1:8123` for Metro dev
 * (quickstart) — and (b) construction of the AG-UI `HttpAgent` bound to the
 * movie-assistant endpoint, optionally carrying the run-scoped subject token (T023)
 * as an ephemeral `Authorization: Bearer` header (never logged/checkpointed).
 */

import {
  resolveGatewayUrl,
  movieAssistantAgentUrl,
  createMovieAssistantAgent,
} from '@/bff-server/agent-gateway-client';

const ORIGINAL_ENV = process.env.AGENT_GATEWAY_URL;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.AGENT_GATEWAY_URL;
  else process.env.AGENT_GATEWAY_URL = ORIGINAL_ENV;
});

describe('resolveGatewayUrl', () => {
  it('uses AGENT_GATEWAY_URL when set (container BFF → internal DNS)', () => {
    process.env.AGENT_GATEWAY_URL = 'http://agent-gateway:8000';
    expect(resolveGatewayUrl()).toBe('http://agent-gateway:8000');
  });

  it('falls back to the Metro loopback 127.0.0.1:8123 when unset', () => {
    delete process.env.AGENT_GATEWAY_URL;
    expect(resolveGatewayUrl()).toBe('http://127.0.0.1:8123');
  });

  it('strips a trailing slash so endpoint paths join cleanly', () => {
    process.env.AGENT_GATEWAY_URL = 'http://agent-gateway:8000/';
    expect(resolveGatewayUrl()).toBe('http://agent-gateway:8000');
  });
});

describe('movieAssistantAgentUrl', () => {
  it('appends the native AG-UI movie-assistant path', () => {
    process.env.AGENT_GATEWAY_URL = 'http://agent-gateway:8000';
    expect(movieAssistantAgentUrl()).toBe('http://agent-gateway:8000/agent/movie-assistant');
  });
});

describe('createMovieAssistantAgent', () => {
  it('binds an HttpAgent to the resolved movie-assistant endpoint', () => {
    process.env.AGENT_GATEWAY_URL = 'http://agent-gateway:8000';
    const agent = createMovieAssistantAgent();
    expect(agent.url).toBe('http://agent-gateway:8000/agent/movie-assistant');
  });

  it('attaches the subject token as an Authorization: Bearer header when provided', () => {
    process.env.AGENT_GATEWAY_URL = 'http://agent-gateway:8000';
    const agent = createMovieAssistantAgent({ subjectToken: 'subject-tok-123' });
    expect(agent.headers.Authorization).toBe('Bearer subject-tok-123');
  });

  it('sends no Authorization header when no subject token is supplied (tool-free graph)', () => {
    process.env.AGENT_GATEWAY_URL = 'http://agent-gateway:8000';
    const agent = createMovieAssistantAgent();
    expect(agent.headers.Authorization).toBeUndefined();
  });
});
