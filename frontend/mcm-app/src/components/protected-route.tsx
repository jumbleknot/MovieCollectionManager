/**
 * ProtectedRoute component (T-089)
 * Reusable wrapper for role-protected screens.
 * Thin wrapper over AuthGuard, providing props-based role requirement.
 */

import React from 'react';
import { AuthGuard } from '@/components/auth-guard';
import type { ClientRole } from '@/types/auth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: ClientRole | 'mc-user' | 'mc-admin';
}

export function ProtectedRoute({ children, requiredRole = 'mc-user' }: ProtectedRouteProps): React.JSX.Element {
  return <AuthGuard requiredRole={requiredRole}>{children}</AuthGuard>;
}
