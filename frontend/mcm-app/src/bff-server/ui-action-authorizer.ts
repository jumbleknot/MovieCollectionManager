/**
 * UI-action authorizer (T026) — navigate/prefill target ↔ JWT-role check.
 *
 * When the agent requests a UI action (the `navigate_*` / `prefill_*` tools, US3/T059),
 * the BFF must confirm both that the target is an allowlisted destination AND that the
 * user's roles permit reaching it. The agent can never drive the UI somewhere the user
 * themselves could not go (FR-011/FR-012, SC-003) — this is a compensating control that
 * sits alongside mc-service's own authorization, not a replacement for it.
 *
 * The target→role maps are the single source of truth for what the agent may drive; a new
 * agent-navigable screen MUST be added here (default-deny for anything unlisted).
 */

import type { UserProfile } from '@/types/auth';
import { ClientRole } from '@/types/auth';

export type UiActionType = 'navigate' | 'prefill';

export interface UiAction {
  type: UiActionType;
  /** Structural destination key (e.g. 'home', 'collection', 'movie-detail', 'add-movie'). */
  target: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/** Screens the agent may navigate to, and the minimum role each requires. */
export const NAVIGABLE_TARGETS: Record<string, ClientRole> = {
  home: ClientRole.MCUser,
  collection: ClientRole.MCUser,
  'movie-detail': ClientRole.MCUser,
  profile: ClientRole.MCUser,
};

/** Prefill actions the agent may request (HITL-surfaced for unsaved state — T059). */
export const PREFILL_TARGETS: Record<string, ClientRole> = {
  'add-movie': ClientRole.MCUser,
};

/** mc-admin implies mc-user; an mc-admin-only target requires the admin role explicitly. */
function satisfiesRole(user: UserProfile, required: ClientRole): boolean {
  if (user.roles.includes(required)) return true;
  return required === ClientRole.MCUser && user.roles.includes(ClientRole.MCAdmin);
}

function deny(reason: string): AuthorizationResult {
  return { allowed: false, reason };
}

/**
 * Authorize a single agent-requested UI action. Default-deny: an unknown action type or a
 * target outside the allowlist is rejected, and the user must hold the role the target
 * requires (the base app gate being mc-user / mc-admin).
 */
export function authorizeUiAction(action: UiAction, user: UserProfile): AuthorizationResult {
  const targets =
    action.type === 'navigate'
      ? NAVIGABLE_TARGETS
      : action.type === 'prefill'
        ? PREFILL_TARGETS
        : null;

  if (!targets) return deny(`unknown action type: ${String(action.type)}`);

  const required = targets[action.target];
  if (required === undefined) return deny(`target not allowlisted: ${action.target}`);

  if (!satisfiesRole(user, required)) {
    return deny(`user lacks required role ${required} for ${action.type}:${action.target}`);
  }

  return { allowed: true };
}
