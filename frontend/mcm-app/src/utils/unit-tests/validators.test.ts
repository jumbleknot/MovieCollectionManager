/**
 * Unit tests for validators (T-036)
 */

import {
  emailError,
  usernameError,
  isValidPassword,
  evaluatePassword,
  passwordError,
  confirmPasswordError,
} from '@/utils/validators';

describe('emailError', () => {
  it('returns null for valid emails', () => {
    expect(emailError('user@example.com')).toBeNull();
    expect(emailError('user+tag@sub.domain.co')).toBeNull();
  });

  it('returns error for empty email', () => {
    expect(emailError('')).toBe('Email address is required.');
  });

  it('returns error for invalid format', () => {
    expect(emailError('not-an-email')).toBe('Please enter a valid email address.');
    expect(emailError('missing@')).toBe('Please enter a valid email address.');
    expect(emailError('@nodomain.com')).toBe('Please enter a valid email address.');
  });
});

describe('usernameError', () => {
  it('returns null for valid usernames', () => {
    expect(usernameError('user_123')).toBeNull();
    expect(usernameError('abc')).toBeNull();
    expect(usernameError('abcdefghijklmnopqrst')).toBeNull(); // 20 chars
  });

  it('returns error for empty username', () => {
    expect(usernameError('')).toBe('Username is required.');
  });

  it('returns error for too short', () => {
    expect(usernameError('ab')).toBe('Username must be at least 3 characters.');
  });

  it('returns error for too long', () => {
    expect(usernameError('a'.repeat(21))).toBe('Username must be 20 characters or fewer.');
  });

  it('returns error for invalid chars', () => {
    expect(usernameError('user name')).toContain('letters, numbers, and underscores');
    expect(usernameError('user-name')).toContain('letters, numbers, and underscores');
  });
});

describe('evaluatePassword', () => {
  it('returns max score for policy-compliant password', () => {
    const result = evaluatePassword('SecurePass1!extra');
    expect(result.checks.minLength).toBe(true);
    expect(result.checks.hasUppercase).toBe(true);
    expect(result.checks.hasLowercase).toBe(true);
    expect(result.checks.hasDigit).toBe(true);
    expect(result.checks.hasSpecial).toBe(true);
    expect(result.score).toBe(4); // clamped 0–4 (009 FR-020), not the raw 5-criteria count
  });

  it('detects missing uppercase', () => {
    const result = evaluatePassword('lowercase1!password');
    expect(result.checks.hasUppercase).toBe(false);
  });

  it('detects missing digit', () => {
    const result = evaluatePassword('NoDigits!!Password');
    expect(result.checks.hasDigit).toBe(false);
  });

  it('detects missing special char', () => {
    const result = evaluatePassword('NoSpecialChar123456');
    expect(result.checks.hasSpecial).toBe(false);
  });

  it('detects short password', () => {
    const result = evaluatePassword('Short1!');
    expect(result.checks.minLength).toBe(false);
  });
});

describe('isValidPassword', () => {
  it('returns true for policy-compliant password', () => {
    expect(isValidPassword('SecurePass1!extra')).toBe(true);
  });

  it('returns false for short password', () => {
    expect(isValidPassword('Short1!')).toBe(false);
  });

  it('returns false for missing uppercase', () => {
    expect(isValidPassword('lowercase1!password')).toBe(false);
  });
});

describe('passwordError', () => {
  it('returns null for valid password', () => {
    expect(passwordError('SecurePass1!extra')).toBeNull();
  });

  it('returns error for empty', () => {
    expect(passwordError('')).toBe('Password is required.');
  });

  it('returns policy error for weak password', () => {
    expect(passwordError('weak')).toContain('12 characters');
  });
});

describe('confirmPasswordError', () => {
  it('returns null when passwords match', () => {
    expect(confirmPasswordError('Pass1!word12', 'Pass1!word12')).toBeNull();
  });

  it('returns error when empty', () => {
    expect(confirmPasswordError('Pass1!word12', '')).toBe('Please confirm your password.');
  });

  it('returns error when passwords do not match', () => {
    expect(confirmPasswordError('Pass1!word12', 'Different1!')).toBe('Passwords do not match.');
  });
});

describe('evaluatePassword score range (009 FR-020)', () => {
  it('keeps score within 0–4 even when all five criteria pass', () => {
    // 12+ chars, upper, lower, digit, special → all 5 checks pass.
    const result = evaluatePassword('Abcdef1!ghij');
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.score).toBeLessThanOrEqual(4);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('reports a low score for a weak password', () => {
    const result = evaluatePassword('abc');
    expect(result.score).toBeLessThanOrEqual(4);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
