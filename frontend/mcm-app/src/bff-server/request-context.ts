import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `handler` inside a new request context with a unique requestId.
 * The requestId is automatically included in all logger calls made within
 * the handler's async call chain, enabling end-to-end request tracing.
 */
export function withRequestContext<T>(handler: () => Promise<T>): Promise<T> {
  return storage.run({ requestId: crypto.randomUUID() }, handler);
}

/** Returns the requestId for the current async context, or undefined if outside any context. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
