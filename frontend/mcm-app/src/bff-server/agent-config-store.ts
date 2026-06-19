// Durable store for per-user agent config (feature 018, FR-013/014/016).
// Persists to the user_agent_config collection (keyed by Keycloak userId). Secrets are
// stored only as AES-256-GCM blobs by the caller (service layer); this layer never sees
// or logs plaintext. The owning userId is always supplied by the caller from the validated
// session — never from request input (FR-017).

import { getAgentConfigCollection } from '@/bff-server/mongo-client';
import type { UserAgentConfigDoc } from '@/types/agent-config';

export async function getByUserId(userId: string): Promise<UserAgentConfigDoc | null> {
  const col = await getAgentConfigCollection();
  return col.findOne({ _id: userId });
}

// Partial upsert. Fields present in `patch` overwrite; fields absent are left intact —
// so a save that omits a secret keeps the stored secret (FR-014). `updatedAt` is always set.
export async function upsert(
  userId: string,
  patch: Partial<Omit<UserAgentConfigDoc, '_id'>>,
): Promise<UserAgentConfigDoc> {
  const col = await getAgentConfigCollection();
  const updatedAt = new Date().toISOString();
  await col.updateOne(
    { _id: userId },
    {
      $set: { ...patch, updatedAt },
      $setOnInsert: { _id: userId },
    },
    { upsert: true },
  );
  const doc = await col.findOne({ _id: userId });
  if (!doc) throw new Error('agent-config upsert did not persist');
  return doc;
}

// Clear = disable + wipe secrets, keep non-secret settings (FR-016, research R9).
export async function clear(userId: string): Promise<void> {
  const col = await getAgentConfigCollection();
  await col.updateOne(
    { _id: userId },
    {
      $set: { enabled: false, updatedAt: new Date().toISOString() },
      $unset: { anthropicKeyEnc: '', tmdbKeyEnc: '' },
    },
  );
}
