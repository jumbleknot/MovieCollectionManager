/**
 * Agent Gateway client (T025) — the BFF's SERVER-SIDE, sole interface to the AG-UI
 * Agent Gateway over the private network. The gateway + `agent-db` are never reachable
 * from the client (constitution §Agent Architecture Boundaries); only these BFF routes
 * reach them.
 *
 * Responsibilities:
 *   - **Mode-aware URL resolution.** `AGENT_GATEWAY_URL` (internal Docker DNS, e.g.
 *     `http://agent-gateway:8000`) for the containerized BFF; loopback
 *     `http://127.0.0.1:8123` for Metro dev (quickstart "Token exchange across serving
 *     modes" / T009 profile-gated host port).
 *   - **Agent construction.** Builds the AG-UI `HttpAgent` (from `@ag-ui/client` — the
 *     native AG-UI protocol the gateway speaks, NOT `LangGraphHttpAgent`) bound to the
 *     movie-assistant endpoint, optionally carrying the run-scoped subject token (T023)
 *     as an ephemeral `Authorization: Bearer` header. The token is never logged or
 *     checkpointed (SC-004); it lives only for the duration of the run request.
 */

import { HttpAgent } from '@ag-ui/client';

/** Metro-dev loopback — the gateway's profile-gated host port (T009/quickstart). */
const METRO_LOOPBACK_GATEWAY_URL = 'http://127.0.0.1:8123';

/** Native AG-UI endpoint path the gateway exposes for the supervisor graph. */
const MOVIE_ASSISTANT_PATH = '/agent/movie-assistant';

/**
 * Resolve the gateway base URL for the current serving mode. Reads `AGENT_GATEWAY_URL`
 * (set in `.env.docker` for the container BFF) and falls back to the Metro loopback.
 * Any trailing slash is stripped so endpoint paths join cleanly.
 */
export function resolveGatewayUrl(): string {
  const raw = process.env.AGENT_GATEWAY_URL?.trim();
  const base = raw && raw.length > 0 ? raw : METRO_LOOPBACK_GATEWAY_URL;
  return base.replace(/\/+$/, '');
}

/** Full URL of the movie-assistant AG-UI endpoint on the gateway. */
export function movieAssistantAgentUrl(): string {
  return `${resolveGatewayUrl()}${MOVIE_ASSISTANT_PATH}`;
}

export interface CreateAgentOptions {
  /**
   * Run-scoped RFC 8693 subject token (T023). Attached as `Authorization: Bearer`
   * so the gateway can re-exchange it per tool call. Omit for the tool-free graph.
   */
  subjectToken?: string;
}

/**
 * Build an AG-UI `HttpAgent` bound to the movie-assistant gateway endpoint. When a
 * subject token is supplied it rides as an ephemeral `Authorization` header — never
 * persisted, logged, or checkpointed.
 */
export function createMovieAssistantAgent(options: CreateAgentOptions = {}): HttpAgent {
  const headers: Record<string, string> = {};
  if (options.subjectToken) {
    headers.Authorization = `Bearer ${options.subjectToken}`;
  }
  return new HttpAgent({ url: movieAssistantAgentUrl(), headers });
}
