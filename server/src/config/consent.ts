import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSENT_PATH = path.resolve(HERE, '../../../CONSENT.md');

let cached: { version: string; sha256: string; text: string } | null = null;

/**
 * Reads CONSENT.md and hashes its exact bytes.
 *
 * The hash is stored on every consent record so that editing this document
 * later cannot retroactively change what a creator agreed to: a mismatch
 * between a stored hash and the current file is detectable, and means that
 * creator consented to a different text and must be asked again.
 */
export async function loadConsentDocument(): Promise<{
  version: string;
  sha256: string;
  text: string;
}> {
  if (cached) return cached;
  const text = await readFile(CONSENT_PATH, 'utf8');
  cached = {
    version: loadEnv().CONSENT_SCOPE_VERSION,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
  };
  return cached;
}

/**
 * Salted one-way hash of a source IP. The raw address is never persisted; this
 * exists only to evidence that a distinct consent event occurred.
 */
export function hashIp(ip: string): string {
  return createHash('sha256').update(`${loadEnv().IP_HASH_SALT}:${ip}`).digest('hex');
}

/** True when a stored consent record still matches the current document. */
export function consentIsCurrent(
  record: { scopeVersion: string; documentSha256: string },
  current: { version: string; sha256: string },
): boolean {
  return record.scopeVersion === current.version && record.documentSha256 === current.sha256;
}
