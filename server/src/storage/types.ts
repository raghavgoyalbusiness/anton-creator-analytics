/**
 * One storage interface, two implementations.
 *
 * The local driver signs short-lived HMAC URLs served by Express; the S3 driver
 * issues genuine presigned URLs against a private bucket. Both expose the same
 * semantics — a URL the browser PUTs to directly, and a separate short-lived
 * read URL — so nothing about the upload flow is a dev-only fiction that has to
 * be rewritten for production.
 *
 * Screenshots never transit our API process. The browser uploads straight to
 * storage; the server only ever holds the key.
 */

export interface PresignedUpload {
  readonly uploadUrl: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly key: string;
  readonly expiresAt: Date;
  readonly maxBytes: number;
}

export interface PresignedRead {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface PresignUploadParams {
  readonly key: string;
  readonly contentType: string;
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
}

export interface StorageAdapter {
  readonly driver: 'local' | 's3';
  presignUpload(params: PresignUploadParams): Promise<PresignedUpload>;
  presignRead(key: string, expiresInSeconds: number): Promise<PresignedRead>;
  /** Server-side read. Used to hash and validate the object; never to serve it. */
  readObject(key: string): Promise<Buffer>;
  /** Server-side write. Used to replace an upload with its normalised form. */
  writeObject(key: string, bytes: Buffer, contentType: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
}

/** Image types a creator's phone actually produces. */
export const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

export function isAllowedUploadType(value: string): value is AllowedUploadType {
  return (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(value);
}

/** Screenshots are downscaled client-side to 1600px; 10 MB is generous headroom. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/**
 * Five minutes. Long enough for a slow mobile upload, short enough that a
 * presigned URL captured from a device or a proxy log is worthless by the time
 * anyone acts on it.
 */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
/**
 * Sixty seconds. A read URL is handed out to render one image in one page
 * view; anything longer is a link to a creator's private analytics sitting in
 * someone's history.
 */
export const READ_URL_TTL_SECONDS = 60;

/**
 * Object keys are generated server-side only, namespaced by creator.
 * A client-supplied key is never accepted: it is the difference between a
 * creator storing their own screenshot and a creator overwriting someone
 * else's.
 */
export function buildScreenshotKey(creatorId: string, uuid: string): string {
  return `creators/${creatorId}/${uuid}.jpg`;
}

/** The creator a key belongs to, or null if it is not a well-formed key. */
export function creatorIdFromKey(key: string): string | null {
  const match = /^creators\/([a-f0-9]{24})\/[a-f0-9-]{8,}\.jpg$/.exec(key);
  return match?.[1] ?? null;
}
