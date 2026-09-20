// Unit tests for backup credential encryption context (feature 073, FR-002).
//
// The encryption itself is feature 018's AES-256-GCM and is already tested in
// agent-config-crypto.test.ts. What is new here is the AAD — the context a blob is BOUND to —
// and one design decision worth stating, because it is the reason this file exists:
//
//   THE DESTINATION ID IS PART OF THE AAD, not just the user id. Without it, two of ONE user's
//   own destination secrets are interchangeable: a store-layer mixup that put the NAS password
//   into the S3 document would decrypt cleanly and the BFF would present it to Amazon. With it,
//   the same mixup fails the GCM authentication check and the run fails loudly instead.
//
// A secret is also never sealed under the assistant's key: BACKUP_CREDENTIAL_ENC_KEY is separate
// from AGENT_CONFIG_ENC_KEY so that one key's exposure does not reach both.

jest.mock('@/config/env', () => ({ env: { backupCredentialEncKey: '' } }));

import { env } from '@/config/env';
import { encryptSecret, decryptSecret } from '@/bff-server/agent-config-crypto';
import {
  backupSecretAad,
  offlineTokenAad,
  backupEncryptionKey,
} from '@/bff-server/agent-config-crypto';

const mockEnv = env as unknown as { backupCredentialEncKey: string };

// Deterministic 32-byte key — random bytes, not a real credential.
const TEST_KEY = Buffer.alloc(32, 11).toString('base64');

const USER_A = 'user-a-2f1c';
const USER_B = 'user-b-9d70';
const DEST_A = 'dest-a-4410';
const DEST_B = 'dest-b-88c3';

describe('backupSecretAad', () => {
  it('round-trips a secret sealed and opened under the SAME owner and destination', () => {
    const secret = 'wJalrXUtnFEMI-EXAMPLE-KEY';
    const blob = encryptSecret(secret, TEST_KEY, backupSecretAad(USER_A, DEST_A));
    expect(decryptSecret(blob, TEST_KEY, backupSecretAad(USER_A, DEST_A))).toBe(secret);
  });

  it('refuses a blob from one destination under ANOTHER destination of the same user', () => {
    const blob = encryptSecret('nas-app-password', TEST_KEY, backupSecretAad(USER_A, DEST_A));
    expect(() => decryptSecret(blob, TEST_KEY, backupSecretAad(USER_A, DEST_B))).toThrow();
  });

  it('refuses a blob from one user under another user', () => {
    const blob = encryptSecret('nas-app-password', TEST_KEY, backupSecretAad(USER_A, DEST_A));
    expect(() => decryptSecret(blob, TEST_KEY, backupSecretAad(USER_B, DEST_A))).toThrow();
  });

  it('is distinct from the assistant AAD for the same user, so the two never collide', () => {
    expect(backupSecretAad(USER_A, DEST_A)).not.toBe(`${USER_A}:anthropicKey`);
    expect(backupSecretAad(USER_A, DEST_A)).toContain(USER_A);
    expect(backupSecretAad(USER_A, DEST_A)).toContain(DEST_A);
  });
});

describe('offlineTokenAad', () => {
  it('round-trips the standing-permission token for its owner', () => {
    const token = 'offline-refresh-token-value';
    const blob = encryptSecret(token, TEST_KEY, offlineTokenAad(USER_A));
    expect(decryptSecret(blob, TEST_KEY, offlineTokenAad(USER_A))).toBe(token);
  });

  it('refuses one user’s offline token under another user', () => {
    const blob = encryptSecret('offline-refresh-token-value', TEST_KEY, offlineTokenAad(USER_A));
    expect(() => decryptSecret(blob, TEST_KEY, offlineTokenAad(USER_B))).toThrow();
  });

  it('is not interchangeable with a destination secret for the same user', () => {
    const blob = encryptSecret('offline-refresh-token-value', TEST_KEY, offlineTokenAad(USER_A));
    expect(() => decryptSecret(blob, TEST_KEY, backupSecretAad(USER_A, DEST_A))).toThrow();
  });
});

describe('backupEncryptionKey', () => {
  it('names BACKUP_CREDENTIAL_ENC_KEY when it is absent, not the assistant key', () => {
    // Absent-and-unused must stay startable — the feature is optional — so this fails at FIRST
    // USE rather than at boot. That makes the message the only thing telling an operator which
    // of the two keys is missing, and naming the wrong one sends them to the wrong variable.
    mockEnv.backupCredentialEncKey = '';
    expect(() => backupEncryptionKey()).toThrow(/^BACKUP_CREDENTIAL_ENC_KEY is not set/);
    // The message may MENTION the assistant key to distinguish the two — that is the useful part
    // for an operator staring at a config with one of them already set. What it must never do is
    // report the assistant key as the missing one, which would send the fix to the wrong line.
    expect(() => backupEncryptionKey()).not.toThrow(/AGENT_CONFIG_ENC_KEY is not set/);
  });

  it('rejects a key of the wrong length rather than failing later inside the cipher', () => {
    mockEnv.backupCredentialEncKey = Buffer.alloc(16, 3).toString('base64');
    expect(() => backupEncryptionKey()).toThrow(/32 bytes/);
  });

  it('returns a valid key unchanged', () => {
    mockEnv.backupCredentialEncKey = TEST_KEY;
    expect(backupEncryptionKey()).toBe(TEST_KEY);
  });
});
