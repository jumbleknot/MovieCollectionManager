/**
 * URL scheme guard (009 finding #1, FR-003).
 *
 * Returns true only when the URL uses the http or https scheme. Used before
 * opening an external-identifier URL so attacker-controlled schemes
 * (javascript:, data:, file:, custom deep links) can never execute in the app
 * (web) or launch an arbitrary intent (native).
 */
export function isSafeHttpUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}
