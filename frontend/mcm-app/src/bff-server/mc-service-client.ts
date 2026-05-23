/**
 * mc-service HTTP client (T019)
 *
 * SERVER-SIDE ONLY — used exclusively inside BFF API route handlers.
 * The client never runs in the browser bundle.
 *
 * Design:
 *   - One instance per BFF request, created via `createMcServiceClient(jwt)`.
 *   - The JWT is extracted from the user's HTTP-only session cookie by the
 *     BFF route handler before calling this factory.
 *   - The Authorization header is injected at construction time so each
 *     instance carries exactly the right identity — no global state.
 *
 * Error handling:
 *   - Axios errors propagate to the caller unchanged; the BFF route handler
 *     maps them to the appropriate HTTP response for the client.
 *   - mc-service returns RFC 9457 Problem Details on errors; the raw Axios
 *     error (with `error.response.data`) is forwarded without transformation.
 */

import axios, { type AxiosInstance } from 'axios';
import { env } from '@/config/env';
import { logger } from '@/bff-server/logger';

/**
 * Create an Axios instance pre-configured for mc-service calls.
 *
 * @param jwt - The user's JWT extracted from the BFF session. Injected as
 *              `Authorization: Bearer {jwt}` on every request so mc-service
 *              can validate the user's identity and roles.
 */
export function createMcServiceClient(jwt: string): AxiosInstance {
  const instance = axios.create({
    baseURL: env.mcServiceUrl,
    timeout: 15_000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
  });

  // Log failed mc-service calls for observability (non-2xx responses and network errors).
  // The raw Axios error is still re-thrown so BFF route handlers can propagate it to the client.
  instance.interceptors.response.use(
    (response) => response,
    (error: unknown) => {
      if (axios.isAxiosError(error) && error.response) {
        logger.error('mc-service call failed', {
          action: 'mc_service_request',
          status: error.response.status,
          method: error.config?.method?.toUpperCase(),
          url: error.config?.url,
        });
      } else if (axios.isAxiosError(error)) {
        logger.error('mc-service network error', {
          action: 'mc_service_request',
          method: error.config?.method?.toUpperCase(),
          url: error.config?.url,
          error,
        });
      }
      return Promise.reject(error);
    },
  );

  return instance;
}
