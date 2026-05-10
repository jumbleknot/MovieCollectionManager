/**
 * Auth domain TypeScript interfaces and types (T-008)
 * Plan: specs/001-user-login/plan.md — Data Model & Entities
 */

// ─── Client Roles ──────────────────────────────────────────────────────────────

export enum ClientRole {
  MCAdmin = 'mc-admin',
  MCUser = 'mc-user',
}

// ─── Keycloak User ─────────────────────────────────────────────────────────────

export interface KeycloakUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  emailVerified: boolean;
  createdTimestamp: number;
  attributes?: {
    lastLogin?: string;
    loginFailures?: number;
  };
}

// ─── JWT Payload ───────────────────────────────────────────────────────────────

export interface JWTPayload {
  sub: string;
  iss: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat: number;
  jti: string;
  auth_time: number;
  scope: string;
  at_hash?: string;
  preferred_username: string;
  email: string;
  email_verified: boolean;
  name: string;
  given_name: string;
  family_name: string;
  realm_access?: {
    roles: string[];
  };
  resource_access?: {
    'movie-collection-manager'?: {
      roles: string[];
    };
  };
}

// ─── User Profile (frontend-facing) ────────────────────────────────────────────

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
  emailVerified: boolean;
  accountStatus: 'active' | 'disabled' | 'locked';
  createdAt: string;
  lastLogin?: string;
}

// ─── Session ───────────────────────────────────────────────────────────────────

export interface Session {
  sessionId: string;
  userId: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
}

// ─── Auth State ────────────────────────────────────────────────────────────────

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserProfile | null;
  sessionId: string | null;
  error: string | null;
}

// ─── API Contracts ─────────────────────────────────────────────────────────────

export interface RegisterRequest {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

export interface RegisterResponse {
  success: boolean;
  message: string;
  userId?: string;
}

export interface LoginRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface LoginResponse {
  success: boolean;
  user: UserProfile;
}

export interface LogoutResponse {
  success: boolean;
  message: string;
}

export interface RefreshResponse {
  success: boolean;
  expiresIn: number;
}

export interface VerifyEmailResponse {
  success: boolean;
  message: string;
  email?: string;
}

export interface ResendVerificationRequest {
  email: string;
}

export interface ResendVerificationResponse {
  success: boolean;
  message: string;
}
