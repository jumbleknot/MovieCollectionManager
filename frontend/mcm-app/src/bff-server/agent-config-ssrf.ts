// SSRF guard for the user-supplied Ollama base URL (feature 018, review #3).
//
// "Bring your own Ollama" intentionally allows a private / loopback / LAN address (the user's own
// model server), so a blanket private-range block would break the primary use case. We therefore
// block only the unambiguously dangerous targets — link-local and cloud-metadata — ALWAYS, and
// optionally enforce a strict host allowlist (AGENT_OLLAMA_ALLOWED_HOSTS) for hardened multi-user
// deployments. Enforced on SAVE (validateOllamaUrl) and again at probe time; the probe also uses
// redirect:'manual' so a vetted URL can't 30x-bounce to a blocked target after the check.

import { env } from '@/config/env';

export interface UrlCheckResult {
  ok: boolean;
  reason?: string;
}

// 169.254.0.0/16 — link-local, includes the AWS/GCP/Azure IMDS at 169.254.169.254.
const LINK_LOCAL_V4 = /^169\.254\./;
// IPv4-mapped IPv6 form of the same range, e.g. ::ffff:169.254.169.254.
const LINK_LOCAL_V4_MAPPED = /^::ffff:169\.254\./i;
// fe80::/10 — IPv6 link-local.
const LINK_LOCAL_V6 = /^fe80:/i;
// AWS IMDS over IPv6.
const METADATA_V6 = 'fd00:ec2::254';

function normalizeHost(hostname: string): string {
  // URL.hostname keeps IPv6 in brackets only in .host, not .hostname; strip defensively anyway.
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isBlockedHost(host: string): boolean {
  return (
    LINK_LOCAL_V4.test(host) ||
    LINK_LOCAL_V4_MAPPED.test(host) ||
    LINK_LOCAL_V6.test(host) ||
    host === METADATA_V6
  );
}

function allowedHosts(): string[] {
  return env.agentOllamaAllowedHosts
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Validate a user-supplied Ollama base URL for save + probe. Returns a safe, field-attributable
 * reason on rejection (never echoes anything sensitive). Allows private/loopback by default;
 * blocks link-local + cloud-metadata always; enforces AGENT_OLLAMA_ALLOWED_HOSTS when set.
 */
export function validateOllamaUrl(value: string): UrlCheckResult {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, reason: 'Must be a valid http(s) URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'Must be a valid http(s) URL' };
  }
  const host = normalizeHost(u.hostname);
  if (isBlockedHost(host)) {
    return { ok: false, reason: 'That address is not allowed (link-local / cloud-metadata range)' };
  }
  const allow = allowedHosts();
  if (allow.length > 0 && !allow.includes(host)) {
    return { ok: false, reason: 'That host is not in the configured Ollama allow-list' };
  }
  return { ok: true };
}
