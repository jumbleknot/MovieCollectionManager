// Durable store for global application settings (feature 040 US3 / Item 1).
// A SINGLE document (_id: "global") in the app_settings collection — mirrors the per-user
// agent-config-store pattern but is application-wide, not keyed by user. The updating admin's
// userId is always supplied by the caller from the validated session, never from request input.

import { getAppSettingsCollection } from '@/bff-server/mongo-client';
import { APP_SETTINGS_GLOBAL_ID } from '@/types/app-settings';
import type { AppSettings } from '@/types/app-settings';

// Default when no document exists yet — self-registration ALLOWED, preserving current behavior
// on a fresh deploy (SC-004).
const DEFAULT_SETTINGS: AppSettings = {
  allowSelfRegistration: true,
  updatedBy: null,
  updatedAt: null,
};

export async function getAppSettings(): Promise<AppSettings> {
  const col = await getAppSettingsCollection();
  const doc = await col.findOne({ _id: APP_SETTINGS_GLOBAL_ID });
  if (!doc) return { ...DEFAULT_SETTINGS };
  return {
    // Tolerate a legacy/partial doc — a missing flag defaults to allowed.
    allowSelfRegistration: doc.allowSelfRegistration ?? true,
    updatedBy: doc.updatedBy ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

// Atomically set the self-registration toggle and stamp who/when. `updatedBy` is the admin's
// Keycloak UUID (from the validated session). Creates the single "global" doc on first write.
export async function setAllowSelfRegistration(
  allowed: boolean,
  updatedBy: string,
): Promise<AppSettings> {
  const col = await getAppSettingsCollection();
  const updatedAt = new Date().toISOString();
  const doc = await col.findOneAndUpdate(
    { _id: APP_SETTINGS_GLOBAL_ID },
    {
      $set: { allowSelfRegistration: allowed, updatedBy, updatedAt },
      $setOnInsert: { _id: APP_SETTINGS_GLOBAL_ID },
    },
    { upsert: true, returnDocument: 'after' },
  );
  if (!doc) throw new Error('app-settings upsert did not persist');
  return {
    allowSelfRegistration: doc.allowSelfRegistration,
    updatedBy: doc.updatedBy,
    updatedAt: doc.updatedAt,
  };
}
