// Unit tests for the Ollama base-URL SSRF guard (feature 018, review #3).
// "Bring your own Ollama" allows private/loopback by design; link-local + cloud-metadata are
// always blocked; an optional AGENT_OLLAMA_ALLOWED_HOSTS allow-list hardens a multi-user deploy.

jest.mock('@/config/env', () => ({ env: { agentOllamaAllowedHosts: '' } }));

import { env } from '@/config/env';
import { validateOllamaUrl } from './agent-config-ssrf';

const mockEnv = env as unknown as { agentOllamaAllowedHosts: string };

describe('validateOllamaUrl', () => {
  beforeEach(() => {
    mockEnv.agentOllamaAllowedHosts = '';
  });

  it('allows a loopback Ollama URL by default (the common local case)', () => {
    expect(validateOllamaUrl('http://localhost:11434').ok).toBe(true);
    expect(validateOllamaUrl('http://127.0.0.1:11434').ok).toBe(true);
  });

  it('allows a private-LAN Ollama URL by default', () => {
    expect(validateOllamaUrl('http://10.0.0.5:11434').ok).toBe(true);
    expect(validateOllamaUrl('http://192.168.1.20:11434').ok).toBe(true);
  });

  it('blocks the cloud-metadata IP (always)', () => {
    const r = validateOllamaUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not allowed/i);
  });

  it('blocks the link-local range and IPv6 link-local + IPv6 metadata', () => {
    expect(validateOllamaUrl('http://169.254.1.1/').ok).toBe(false);
    expect(validateOllamaUrl('http://[fe80::1]:11434/').ok).toBe(false);
    expect(validateOllamaUrl('http://[fd00:ec2::254]/').ok).toBe(false);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(validateOllamaUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateOllamaUrl('ftp://host/').ok).toBe(false);
    expect(validateOllamaUrl('not a url').ok).toBe(false);
  });

  it('enforces the allow-list when configured — only listed hosts pass', () => {
    mockEnv.agentOllamaAllowedHosts = 'ollama.internal, 10.0.0.5';
    expect(validateOllamaUrl('http://ollama.internal:11434').ok).toBe(true);
    expect(validateOllamaUrl('http://10.0.0.5:11434').ok).toBe(true);
    // A host not on the list is rejected even though it's an ordinary private address.
    const r = validateOllamaUrl('http://192.168.1.20:11434');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/allow-list/i);
  });

  it('still blocks metadata even if someone allow-lists it', () => {
    mockEnv.agentOllamaAllowedHosts = '169.254.169.254';
    expect(validateOllamaUrl('http://169.254.169.254/').ok).toBe(false);
  });
});
