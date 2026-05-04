/**
 * Form validators (T-031 / T-047 / T-048)
 * Client-side validation for registration form fields.
 * Password policy mirrors the Keycloak server-side policy (plan.md FR-004a).
 */

// ─── Email ─────────────────────────────────────────────────────────────────────

/**
 * Validate email address format (RFC 5322 simplified).
 */
export function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return re.test(email.trim());
}

export function emailError(email: string): string | null {
  if (!email.trim()) return 'Email address is required.';
  if (!isValidEmail(email)) return 'Please enter a valid email address.';
  return null;
}

// ─── Username ──────────────────────────────────────────────────────────────────

/**
 * Validate username: 3–20 alphanumeric characters or underscores.
 */
export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username.trim());
}

export function usernameError(username: string): string | null {
  const trimmed = username.trim();
  if (!trimmed) return 'Username is required.';
  if (trimmed.length < 3) return 'Username must be at least 3 characters.';
  if (trimmed.length > 20) return 'Username must be 20 characters or fewer.';
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed))
    return 'Username may only contain letters, numbers, and underscores.';
  return null;
}

// ─── Password ──────────────────────────────────────────────────────────────────

export interface PasswordStrength {
  score: number;          // 0–4
  label: 'Weak' | 'Fair' | 'Good' | 'Strong';
  checks: {
    minLength: boolean;
    hasUppercase: boolean;
    hasLowercase: boolean;
    hasDigit: boolean;
    hasSpecial: boolean;
  };
}

/**
 * Evaluate password strength against the policy:
 *   min 12 chars, 1 uppercase, 1 lowercase, 1 digit, 1 special character.
 */
export function evaluatePassword(password: string): PasswordStrength {
  const checks = {
    minLength: password.length >= 12,
    hasUppercase: /[A-Z]/.test(password),
    hasLowercase: /[a-z]/.test(password),
    hasDigit: /[0-9]/.test(password),
    hasSpecial: /[^a-zA-Z0-9]/.test(password),
  };

  const passed = Object.values(checks).filter(Boolean).length;
  const score = Math.min(4, passed - 1) as 0 | 1 | 2 | 3 | 4;
  const labels: PasswordStrength['label'][] = ['Weak', 'Fair', 'Good', 'Strong'];
  const label = labels[Math.min(score, 3)] as PasswordStrength['label'];

  return { score: passed, label, checks };
}

/**
 * Check if a password meets the full policy.
 */
export function isValidPassword(password: string): boolean {
  const { checks } = evaluatePassword(password);
  return Object.values(checks).every(Boolean);
}

export function passwordError(password: string): string | null {
  if (!password) return 'Password is required.';
  if (!isValidPassword(password)) {
    return 'Password must be at least 12 characters and include uppercase, lowercase, a number, and a special character.';
  }
  return null;
}

export function confirmPasswordError(password: string, confirm: string): string | null {
  if (!confirm) return 'Please confirm your password.';
  if (password !== confirm) return 'Passwords do not match.';
  return null;
}

// ─── Name fields ───────────────────────────────────────────────────────────────

export function firstNameError(firstName: string): string | null {
  if (!firstName.trim()) return 'First name is required.';
  if (firstName.trim().length > 50) return 'First name must be 50 characters or fewer.';
  return null;
}

export function lastNameError(lastName: string): string | null {
  if (!lastName.trim()) return 'Last name is required.';
  if (lastName.trim().length > 50) return 'Last name must be 50 characters or fewer.';
  return null;
}
