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

import type { ResolvedRunConfig } from '@/types/agent-config';

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
  /**
   * Sanitized readable UI-state snapshot (US3/R15) — structural fields only, already
   * passed through `sanitizeUiState` at the BFF (the sole sanitization point). Rides
   * out-of-band as the `X-UI-Snapshot` header (never the run body) so the gateway can
   * resolve "this"/current-screen references. Contains no PII, values, or tokens.
   */
  uiSnapshot?: Record<string, unknown>;
  /**
   * Import-file reference (014 US2) — `{handle, filename}` naming the transient upload store
   * entry. Rides out-of-band as the `X-Import-File` header (never the run body) so the gateway
   * bridges it into `config["configurable"].file_handle` for the import node. The handle is an
   * opaque store key, not file bytes or a credential.
   */
  importFile?: { handle: string; filename?: string };
  /**
   * Per-run resolved agent config (018 US2) — the user's provider / model base URL / decrypted
   * provider+TMDB keys, resolved in-memory by `resolveForRun`. Rides as the `X-Agent-Config`
   * header so the gateway sources the model + TMDB credentials per-user instead of a shared env
   * key (SC-002/FR-021). Carries secrets: never logged (logger SENSITIVE_KEYS) or checkpointed;
   * lives only for the duration of this run request.
   */
  agentConfig?: ResolvedRunConfig;
}

/**
 * Build an AG-UI `HttpAgent` bound to the movie-assistant gateway endpoint. When a
 * subject token is supplied it rides as an ephemeral `Authorization` header — never
 * persisted, logged, or checkpointed. A sanitized UI snapshot rides as `X-UI-Snapshot`.
 */
export function createMovieAssistantAgent(options: CreateAgentOptions = {}): HttpAgent {
  const headers: Record<string, string> = {};
  if (options.subjectToken) {
    headers.Authorization = `Bearer ${options.subjectToken}`;
  }
  if (options.uiSnapshot) {
    headers['X-UI-Snapshot'] = JSON.stringify(options.uiSnapshot);
  }
  if (options.importFile?.handle) {
    headers['X-Import-File'] = JSON.stringify(options.importFile);
  }
  if (options.agentConfig) {
    headers['X-Agent-Config'] = JSON.stringify(options.agentConfig);
  }
  return new HttpAgent({ url: movieAssistantAgentUrl(), headers });
}

export interface ResumeRunOptions {
  threadId: string;
  proposalId: string;
  decision: 'approved' | 'rejected';
  /** Fresh run-scoped subject token (the paused run held none) — ephemeral, never logged. */
  subjectToken?: string;
}

/**
 * Resume an interrupted run after a HITL decision by forwarding to the AG-UI gateway, and
 * proxy the continuation stream back unchanged (the BFF is a proxy, not a translator). The
 * fresh subject token rides as an ephemeral `Authorization: Bearer` header so the gateway
 * can re-exchange it for the approved writes.
 *
 * The AG-UI resume payload carries the decision via `forwardedProps.command.resume` keyed by
 * `threadId` — the gateway maps this to a LangGraph `Command(resume=...)` on that checkpoint.
 * The exact field shape is finalised against the live gateway when the agent layer is
 * deployed (the auth guard + decision audit in the route are protocol-independent).
 */
export async function resumeMovieAssistantRun(options: ResumeRunOptions): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.subjectToken) {
    headers.Authorization = `Bearer ${options.subjectToken}`;
  }
  const body = JSON.stringify({
    threadId: options.threadId,
    messages: [],
    forwardedProps: {
      command: { resume: { decision: options.decision, proposalId: options.proposalId } },
    },
  });
  const upstream = await fetch(movieAssistantAgentUrl(), { method: 'POST', headers, body });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream' },
  });
}
