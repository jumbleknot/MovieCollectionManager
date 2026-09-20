// AES-256-GCM encryption for per-user agent secrets (feature 018, FR-013).
// Authenticated encryption: the stored blob is base64(iv || authTag || ciphertext).
// The master key (AGENT_CONFIG_ENC_KEY, 32 bytes base64) comes from Vault (prod) /
// gitignored env (dev) — managed separately from the data store (Encryption at Rest /
// KMS-separation). Plaintext secrets are decrypted only transiently in the BFF and are
// NEVER persisted or logged (SC-004 extension).

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

import { env } from '@/config/env';

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

/**
 * Encrypt a secret. `aad` (Additional Authenticated Data) binds the ciphertext to its context —
 * pass `${userId}:${field}` so a blob can only ever be decrypted in the SAME context it was
 * sealed in (018 review #10). The AAD is authenticated by the GCM tag but is NOT stored in the
 * blob; the decrypt side must supply the identical value. A store-layer mixup (e.g. user A's
 * blob landing in user B's document) then fails authentication instead of silently decrypting.
 */
export function encryptSecret(plaintext: string, keyBase64: string, aad = ''): string {
  const key = loadKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a secret. `aad` must match the value passed to `encryptSecret` (e.g.
 * `${userId}:${field}`) or the GCM auth check fails and this throws — the cryptographic guard
 * against a cross-user/cross-field blob mixup (018 review #10).
 */
export function decryptSecret(blobBase64: string, keyBase64: string, aad = ''): string {
  const key = loadKey(keyBase64);
  const raw = Buffer.from(blobBase64, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Encrypted blob is too short to be valid');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Canonical AAD for a per-user secret field — binds an encrypted blob to its owner + field so
 * it can't be reused in another user's document or as a different field (018 review #10).
 */
export function secretAad(userId: string, field: 'anthropicKey' | 'tmdbKey'): string {
  return `${userId}:${field}`;
}

// ─── Backups (feature 073) ─────────────────────────────────────────────────────
//
// The same AES-256-GCM primitives above, under a DIFFERENT master key and different AADs. Sharing
// AGENT_CONFIG_ENC_KEY would have been one fewer variable and would have widened that key's blast
// radius from "the user's assistant credentials" to "every store the user's whole collection can
// be written to". The primitives are shared; the key is not.

/**
 * AAD for a destination's stored secret — binds the blob to its owner AND to the specific
 * destination.
 *
 * The destination id is what makes this more than a copy of `secretAad`. Bound to the user alone,
 * two of ONE user's own destination secrets would be interchangeable: a store-layer mixup that
 * put the WebDAV app password into the S3 document would decrypt perfectly and the BFF would
 * then present it to the S3 endpoint as an access key. Bound to the destination, that same mixup
 * fails the GCM authentication check, which is a loud failure instead of a silent leak.
 */
export function backupSecretAad(userId: string, destinationId: string): string {
  return `${userId}:backupDestinationSecret:${destinationId}`;
}

/**
 * AAD for the standing-permission (offline) refresh token. ONE per user, not one per job — a user
 * consents once and revocation is a single act — so the owner is the whole context.
 */
export function offlineTokenAad(userId: string): string {
  return `${userId}:offlineRefresh`;
}

/**
 * The backup master key, validated.
 *
 * Read at USE, not at boot. A deployment that never configures a destination must still start:
 * the feature is genuinely optional, and refusing to boot over an unused variable would make it
 * mandatory in practice. The cost of that choice is that this message is the only thing telling
 * an operator WHICH of the two keys is missing, so it names BACKUP_CREDENTIAL_ENC_KEY explicitly
 * rather than deferring to `loadKey`'s message about the assistant key.
 */
export function backupEncryptionKey(): string {
  const keyBase64 = env.backupCredentialEncKey;
  if (!keyBase64) {
    throw new Error(
      'BACKUP_CREDENTIAL_ENC_KEY is not set — a backup destination secret cannot be stored or ' +
        'read. It is a separate key from AGENT_CONFIG_ENC_KEY; generate 32 bytes base64.',
    );
  }
  if (Buffer.from(keyBase64, 'base64').length !== KEY_BYTES) {
    throw new Error(
      `BACKUP_CREDENTIAL_ENC_KEY must decode to ${KEY_BYTES} bytes ` +
        `(got ${Buffer.from(keyBase64, 'base64').length})`,
    );
  }
  return keyBase64;
}
