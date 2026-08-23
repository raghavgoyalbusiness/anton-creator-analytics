import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  PresignUploadParams,
  PresignedRead,
  PresignedUpload,
  StorageAdapter,
} from './types.js';

/**
 * Development driver. Signs URLs with HMAC-SHA256 and serves them from Express,
 * mirroring S3 presign semantics: an opaque URL, an expiry baked into the
 * signature, and no ambient authentication.
 *
 * Files live under STORAGE_LOCAL_PATH, which is gitignored. Not for production:
 * env validation refuses to boot with STORAGE_DRIVER=local when NODE_ENV is
 * production.
 */
export class LocalDiskAdapter implements StorageAdapter {
  readonly driver = 'local' as const;

  constructor(
    private readonly rootDir: string,
    private readonly secret: string,
    private readonly publicBaseUrl: string,
  ) {}

  /** Rejects traversal and absolute paths before any path join. */
  private resolve(key: string): string {
    if (key.includes('..') || key.startsWith('/') || key.includes('\0')) {
      throw new Error(`illegal storage key: ${key}`);
    }
    const full = path.resolve(this.rootDir, key);
    const root = path.resolve(this.rootDir);
    if (!full.startsWith(root + path.sep)) throw new Error(`storage key escapes root: ${key}`);
    return full;
  }

  sign(key: string, expiresAtMs: number, operation: 'put' | 'get'): string {
    return createHmac('sha256', this.secret)
      .update(`${operation}:${key}:${expiresAtMs}`)
      .digest('hex');
  }

  /** Timing-safe. Returns a reason rather than throwing, so routes can map it. */
  verify(
    key: string,
    expiresAtMs: number,
    operation: 'put' | 'get',
    signature: string,
  ): { ok: true } | { ok: false; reason: 'expired' | 'bad_signature' } {
    if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) {
      return { ok: false, reason: 'expired' };
    }
    const expected = Buffer.from(this.sign(key, expiresAtMs, operation), 'utf8');
    const actual = Buffer.from(signature, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, reason: 'bad_signature' };
    }
    return { ok: true };
  }

  private buildUrl(route: string, key: string, expiresAtMs: number, operation: 'put' | 'get'): string {
    const params = new URLSearchParams({
      key,
      exp: String(expiresAtMs),
      sig: this.sign(key, expiresAtMs, operation),
    });
    return `${this.publicBaseUrl}${route}?${params.toString()}`;
  }

  async presignUpload(params: PresignUploadParams): Promise<PresignedUpload> {
    const expiresAtMs = Date.now() + params.expiresInSeconds * 1000;
    return {
      uploadUrl: this.buildUrl('/api/storage/upload', params.key, expiresAtMs, 'put'),
      method: 'PUT',
      headers: { 'content-type': params.contentType },
      key: params.key,
      expiresAt: new Date(expiresAtMs),
      maxBytes: params.maxBytes,
    };
  }

  async presignRead(key: string, expiresInSeconds: number): Promise<PresignedRead> {
    const expiresAtMs = Date.now() + expiresInSeconds * 1000;
    return {
      url: this.buildUrl('/api/storage/object', key, expiresAtMs, 'get'),
      expiresAt: new Date(expiresAtMs),
    };
  }

  async writeObject(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    await this.write(key, bytes);
  }

  async write(key: string, body: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async readObject(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      const info = await stat(this.resolve(key));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
