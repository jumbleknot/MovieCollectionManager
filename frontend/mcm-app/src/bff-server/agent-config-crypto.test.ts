// Unit tests for AES-256-GCM per-user secret encryption (feature 018, FR-013).
// Pure Node crypto — no live dependency. Verifies round-trip, ciphertext ≠ plaintext,
// and tamper detection (GCM auth tag).

import { encryptSecret, decryptSecret } from './agent-config-crypto';

// A deterministic 32-byte base64 key for tests (NOT a real key — random bytes).
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

describe('agent-config-crypto', () => {
  it('round-trips a secret: decrypt(encrypt(x)) === x', () => {
    const plain = 'sk-ant-example-value-1234567890';
    const blob = encryptSecret(plain, TEST_KEY);
    expect(decryptSecret(blob, TEST_KEY)).toBe(plain);
  });

  it('ciphertext blob is not the plaintext', () => {
    const plain = 'tmdb-key-abcdef';
    const blob = encryptSecret(plain, TEST_KEY);
    expect(blob).not.toContain(plain);
    expect(blob).not.toBe(plain);
  });

  it('produces a distinct blob each call (random IV) but both decrypt equally', () => {
    const plain = 'same-secret';
    const a = encryptSecret(plain, TEST_KEY);
    const b = encryptSecret(plain, TEST_KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, TEST_KEY)).toBe(plain);
    expect(decryptSecret(b, TEST_KEY)).toBe(plain);
  });

  it('throws when the ciphertext is tampered (GCM auth tag fails)', () => {
    const blob = encryptSecret('secret', TEST_KEY);
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte
    const tampered = raw.toString('base64');
    expect(() => decryptSecret(tampered, TEST_KEY)).toThrow();
  });

  it('throws when the key is missing/empty', () => {
    expect(() => encryptSecret('x', '')).toThrow();
  });
});
