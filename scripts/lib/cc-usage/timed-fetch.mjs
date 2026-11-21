// fetch with the two bounds contracts/cli.md sets for every network call: 2 s to connect (measured
// as time to response headers, which bounds the connect) and 5 s in total. Node's built-in fetch
// has no separate connect timeout without a dispatcher, so the header bound stands in for it.
export const CONNECT_TIMEOUT_MS = 2000;
export const TOTAL_TIMEOUT_MS = 5000;

export async function timedFetch(fetchImpl, url, init = {}, { connectMs = CONNECT_TIMEOUT_MS, totalMs = TOTAL_TIMEOUT_MS } = {}) {
  const headers = new AbortController();
  const timer = setTimeout(() => headers.abort(new Error('connect timeout')), connectMs);
  const signal = AbortSignal.any([headers.signal, AbortSignal.timeout(totalMs)]);
  try {
    const res = await fetchImpl(url, { ...init, signal });
    clearTimeout(timer);
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}
