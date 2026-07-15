// Global (application-wide) settings — feature 040 US3 / Item 1.
// A SINGLE document (unlike the per-user user_agent_config). Currently holds just the
// self-registration toggle; the admin settings screen is scoped to this one control.

// External-contract identifiers (the fixed _id sentinel + the persisted field names) are
// stable storage keys — exempt from the behavior-descriptive-identifier rule by design.
export const APP_SETTINGS_GLOBAL_ID = 'global' as const;

export interface AppSettingsDoc {
  _id: typeof APP_SETTINGS_GLOBAL_ID;
  // Whether user self-registration is permitted app-wide. Absent doc/field ⇒ treated as true
  // (default preserves current behavior on a fresh deploy).
  allowSelfRegistration: boolean;
  // Keycloak UUID of the admin who last changed it (never username/email); null before first write.
  updatedBy: string | null;
  updatedAt: string | null;
}

// The shape returned by the admin GET/PATCH endpoints (no _id leaked to clients).
export interface AppSettings {
  allowSelfRegistration: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}
