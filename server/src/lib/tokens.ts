import { createHash, randomBytes } from 'node:crypto';

/**
 * Magic-link and share tokens.
 *
 * 32 bytes of CSPRNG entropy, base64url encoded to 43 characters. Only the
 * SHA-256 is ever persisted: the raw token exists once, in the response to the
 * call that minted it, so a dump of the database yields no working links.
 *
 * No salt and no KDF, deliberately. These are 256-bit random values, not
 * user-chosen passwords — there is no dictionary to attack, so a slow hash
 * would buy nothing and cost a KDF round on every request.
 */

export function mintToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}


/** Shape check before any database lookup, so malformed input costs nothing. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function looksLikeToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
