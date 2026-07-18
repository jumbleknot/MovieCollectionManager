/**
 * Ollama reachability helper for the BFF integration suite (feature 041).
 *
 * The app-e2e CI stack runs MODEL_PROVIDER=anthropic and stands up NO Ollama server, so the
 * Ollama-dependent config tests (validate-on-save / re-probe against a real Ollama) can't pass
 * there. They self-skip when Ollama is unreachable — a legitimate "ollama not reachable" skip,
 * the same category the agent pytest suite already allowlists (specs/041-…/contracts/
 * skip-escalation-convention.md). In a dev environment with Ollama up, they run normally.
 *
 * Reuses the BFF's real probe (bounded, SSRF-guarded) so the reachability signal matches what the
 * server does — no separate ad-hoc HTTP client.
 */
import { probeOllama } from '@/bff-server/agent-config-probes';

export async function isOllamaReachable(url: string): Promise<boolean> {
  try {
    return (await probeOllama(url)) === 'ok';
  } catch {
    return false;
  }
}
