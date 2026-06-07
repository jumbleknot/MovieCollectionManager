/**
 * T026 — UI-action authorizer (navigate/prefill target ↔ JWT-role check).
 *
 * When the agent requests a UI action (navigate / prefill tools, US3/T059), the BFF must
 * verify the action targets an allowlisted destination AND that the user's roles permit
 * it — the agent can never drive the UI somewhere the user themselves could not go
 * (FR-011/FR-012, SC-003). This is a compensating control alongside mc-service's own authz.
 */

import { authorizeUiAction } from '@/bff-server/ui-action-authorizer';
import type { UserProfile } from '@/types/auth';
import { ClientRole } from '@/types/auth';

function user(roles: string[]): UserProfile {
  return {
    id: 'u1',
    username: 'tester',
    email: 't@example.com',
    firstName: 'T',
    lastName: 'Ester',
    roles,
    emailVerified: true,
    accountStatus: 'active',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('authorizeUiAction', () => {
  it('allows an mc-user to navigate to an allowlisted target', () => {
    expect(authorizeUiAction({ type: 'navigate', target: 'home' }, user([ClientRole.MCUser])).allowed).toBe(
      true,
    );
    expect(
      authorizeUiAction({ type: 'navigate', target: 'collection' }, user([ClientRole.MCUser])).allowed,
    ).toBe(true);
  });

  it('allows an mc-admin (admin implies user) to navigate', () => {
    expect(
      authorizeUiAction({ type: 'navigate', target: 'movie-detail' }, user([ClientRole.MCAdmin])).allowed,
    ).toBe(true);
  });

  it('denies a user lacking mc-user/mc-admin (JWT-role gate)', () => {
    const result = authorizeUiAction({ type: 'navigate', target: 'home' }, user([]));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('denies a navigate to a target that is not allowlisted', () => {
    const result = authorizeUiAction(
      { type: 'navigate', target: 'admin-panel' },
      user([ClientRole.MCUser]),
    );
    expect(result.allowed).toBe(false);
  });

  it('allows an allowlisted prefill action for an mc-user', () => {
    expect(
      authorizeUiAction({ type: 'prefill', target: 'add-movie' }, user([ClientRole.MCUser])).allowed,
    ).toBe(true);
  });

  it('denies an unknown action type', () => {
    const result = authorizeUiAction(
      { type: 'exfiltrate' as unknown as 'navigate', target: 'home' },
      user([ClientRole.MCUser]),
    );
    expect(result.allowed).toBe(false);
  });
});
