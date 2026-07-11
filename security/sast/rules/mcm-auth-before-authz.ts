// Test fixture for mcm-auth-before-authz (semgrep --test). Intentionally-insecure sample —
// excluded from the product scan via .semgrepignore. Do not import.

import { requireAuth, requireMcUser, createMcServiceClient, extractRawToken } from '@/bff-server/x';

async function GETsecure(headers: any) {
  const { user } = await requireAuth(headers);
  requireMcUser(user);
  const jwt = extractRawToken(headers);
  // ok: mcm-auth-before-authz
  const client = createMcServiceClient(jwt);
  return client;
}

async function GETinsecure(headers: any) {
  const jwt = extractRawToken(headers);
  // ruleid: mcm-auth-before-authz
  const client = createMcServiceClient(jwt);
  return client;
}
