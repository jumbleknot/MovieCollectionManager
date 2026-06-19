// AES-256-GCM encryption for per-user agent secrets (feature 018, FR-013).
// Authenticated encryption: the stored blob is base64(iv || authTag || ciphertext).
// The master key (AGENT_CONFIG_ENC_KEY, 32 bytes base64) comes from Vault (prod) /
// gitignored env (dev) — managed separately from the data store (Encryption at Rest /
// KMS-separation). Plaintext secrets are decrypted only transiently in the BFF and are
// NEVER persisted or logged (SC-004 extension).

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

function loadKey(keyBase64: string): Buffer {
  if (!keyBase64) {
    throw new Error('AGENT_CONFIG_ENC_KEY is not set — cannot encrypt/decrypt agent secrets');
  }
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`AGENT_CONFIG_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = loadKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(blobBase64: string, keyBase64: string): string {
  const key = loadKey(keyBase64);
  const raw = Buffer.from(blobBase64, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Encrypted blob is too short to be valid');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
