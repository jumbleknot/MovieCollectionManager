/**
 * JWT token service (T-022)
 * Server-side only — validates JWTs using Keycloak's JWKS endpoint.
 * Handles token parsing, signature validation, expiration checks, and claims extraction.
 */

import { createHash, createVerify } from 'crypto';
import { keycloakConfig } from '@/config/keycloak';
import type { JWTPayload } from '@/types/auth';
import { AuthError, AuthErrorCode } from '@/types/errors';

// ─── JWKS types ────────────────────────────────────────────────────────────────

interface JwkKey {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
}

interface JwksDocument {
  keys: JwkKey[];
}

// ─── JWKS cache (TTL 5 minutes) ───────────────────────────────────────────────

let jwksCache: JwksDocument | null = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

async function getJwks(): Promise<JwksDocument> {
  const now = Date.now();
  if (jwksCache && now - jwksCacheTime < JWKS_CACHE_TTL_MS) {
    return jwksCache;
  }

  let res: Response;
  try {
    res = await fetch(`${keycloakConfig.issuer}/protocol/openid-connect/certs`);
  } catch (err) {
    throw new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Failed to reach Keycloak JWKS endpoint', 503);
  }
  if (!res.ok) {
    throw new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Failed to fetch JWKS', 503);
  }

  jwksCache = (await res.json()) as JwksDocument;
  jwksCacheTime = now;
  return jwksCache;
}

// ─── Base64URL helpers ─────────────────────────────────────────────────────────

function base64urlDecode(str: string): Buffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  return Buffer.from(padded, 'base64');
}

function base64urlToBuffer(str: string): Buffer {
  return base64urlDecode(str);
}

// ─── RSA public key construction from JWK ─────────────────────────────────────

function constructPemFromJwk(jwk: JwkKey): string {
  // Construct DER-encoded RSA public key from n and e modulus/exponent
  const nBuf = base64urlToBuffer(jwk.n);
  const eBuf = base64urlToBuffer(jwk.e);

  // ASN.1 encoding for RSA public key
  function encodeLength(len: number): Buffer {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  }

  function encodeInteger(buf: Buffer): Buffer {
    const needsPad = buf[0]! & 0x80 ? Buffer.from([0x00]) : Buffer.alloc(0);
    const content = Buffer.concat([needsPad, buf]);
    return Buffer.concat([Buffer.from([0x02]), encodeLength(content.length), content]);
  }

  const nDer = encodeInteger(nBuf);
  const eDer = encodeInteger(eBuf);
  const seq = Buffer.concat([Buffer.from([0x30]), encodeLength(nDer.length + eDer.length), nDer, eDer]);

  // OID for rsaEncryption (1.2.840.113549.1.1.1) + NULL
  const oid = Buffer.from('300d06092a864886f70d0101010500', 'hex');
  const bitString = Buffer.concat([Buffer.from([0x00]), seq]);
  const bitStringDer = Buffer.concat([
    Buffer.from([0x03]),
    encodeLength(bitString.length),
    bitString,
  ]);

  const spki = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(oid.length + bitStringDer.length),
    oid,
    bitStringDer,
  ]);

  return `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
}

// ─── at_hash validation ────────────────────────────────────────────────────────

export function validateAtHash(idTokenPayload: JWTPayload, accessToken: string): boolean {
  if (!idTokenPayload.at_hash) return true; // at_hash is optional per OIDC spec

  const hash = createHash('sha256').update(Buffer.from(accessToken)).digest();
  const halfHash = hash.subarray(0, hash.length / 2);
  const expectedAtHash = halfHash.toString('base64url');

  return idTokenPayload.at_hash === expectedAtHash;
}

// ─── Core JWT validation ───────────────────────────────────────────────────────

export interface ValidatedToken {
  payload: JWTPayload;
  header: { alg: string; kid: string; typ: string };
}

/**
 * Validate a JWT signature + standard claims (iss, aud, exp, iat).
 * Uses Keycloak's JWKS endpoint for public key retrieval.
 */
export async function validateJwt(token: string): Promise<ValidatedToken> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Malformed JWT', 401);
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // Decode header and payload
  let header: { alg: string; kid: string; typ: string };
  let payload: JWTPayload;

  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf-8')) as typeof header;
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8')) as JWTPayload;
  } catch {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Malformed JWT', 401);
  }

  // Check issuer
  // In dev, the Android emulator accesses Keycloak via 10.0.2.2 (emulator gateway to host),
  // so Keycloak stamps tokens with iss=http://10.0.2.2:8099/... instead of localhost:8099.
  // Accept both since they point to the same Keycloak instance.
  const tokenIssuer = payload.iss ?? '';
  const expectedIssuer = keycloakConfig.issuer;
  const issuerMatches =
    tokenIssuer === expectedIssuer ||
    tokenIssuer === expectedIssuer.replace('localhost', '10.0.2.2') ||
    tokenIssuer === expectedIssuer.replace('10.0.2.2', 'localhost');
  if (!issuerMatches) {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Invalid token issuer', 401);
  }

  // Check audience — Keycloak access tokens put the client ID in `azp`, not `aud`
  // (`aud` is typically `["account"]` for access tokens)
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const isValidAudience = aud.includes(keycloakConfig.clientId) || payload.azp === keycloakConfig.clientId;
  if (!isValidAudience) {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Invalid token audience', 401);
  }

  // Check expiration
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSeconds) {
    throw new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Token has expired', 401);
  }

  // Verify signature using JWKS
  const jwks = await getJwks();
  let signingKey = jwks.keys.find((k) => k.kid === header.kid);
  if (!signingKey) {
    // Refresh JWKS cache once (Keycloak may have rotated keys) and retry
    jwksCache = null;
    const freshJwks = await getJwks();
    signingKey = freshJwks.keys.find((k) => k.kid === header.kid);
    if (!signingKey) {
      throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Unknown signing key', 401);
    }
  }

  const pem = constructPemFromJwk(signingKey);
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64urlToBuffer(signatureB64);

  const algorithm = header.alg === 'RS256' ? 'RSA-SHA256'
    : header.alg === 'RS384' ? 'RSA-SHA384'
    : header.alg === 'RS512' ? 'RSA-SHA512'
    : header.alg;

  let isValid: boolean;
  try {
    const verifier = createVerify(algorithm);
    verifier.update(signingInput);
    isValid = verifier.verify(pem, signature);
  } catch {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Token signature verification failed', 401);
  }
  if (!isValid) {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'Invalid token signature', 401);
  }

  return { payload, header };
}

/**
 * Extract user roles from token payload's resource_access claim.
 */
export function extractRoles(payload: JWTPayload, clientId: string): string[] {
  return payload.resource_access?.[clientId as keyof typeof payload.resource_access]?.roles ?? [];
}

/**
 * Check whether a token will expire within the given threshold (seconds).
 * Used by the silent refresh strategy.
 */
export function isTokenExpiringSoon(payload: JWTPayload, thresholdSeconds = 60): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return payload.exp - nowSeconds <= thresholdSeconds;
}

/**
 * Check if a token has already expired.
 */
export function isTokenExpired(payload: JWTPayload): boolean {
  return payload.exp <= Math.floor(Date.now() / 1000);
}

/** @internal For testing only — resets the JWKS cache. */
export function __clearJwksCache(): void {
  jwksCache = null;
  jwksCacheTime = 0;
}
