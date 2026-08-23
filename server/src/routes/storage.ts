import { Router, raw } from 'express';
import { z } from 'zod';
import { LocalDiskAdapter, MAX_UPLOAD_BYTES, isAllowedUploadType } from '../storage/index.js';
import { getStorage } from '../storage/index.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseQuery } from '../lib/validate.js';

/**
 * Local storage driver endpoints. These exist only to give the development
 * environment the same shape as S3: an opaque signed URL the browser PUTs to,
 * with no ambient authentication and an expiry inside the signature.
 *
 * Mounted only when STORAGE_DRIVER=local. Under S3 the browser talks to the
 * bucket directly and none of this is reachable.
 */
export const storageRouter: Router = Router();

const signedQuerySchema = z.object({
  key: z.string().min(1).max(512),
  exp: z.coerce.number().int().positive(),
  sig: z.string().regex(/^[a-f0-9]{64}$/),
});

function localAdapter(): LocalDiskAdapter {
  const storage = getStorage();
  if (!(storage instanceof LocalDiskAdapter)) {
    throw ApiError.notFound('not_local_storage', 'Local storage routes are not active.');
  }
  return storage;
}

storageRouter.put(
  '/upload',
  raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
  asyncRoute(async (req, res) => {
    const query = parseQuery(signedQuerySchema, req);
    const adapter = localAdapter();

    const verdict = adapter.verify(query.key, query.exp, 'put', query.sig);
    if (!verdict.ok) {
      throw verdict.reason === 'expired'
        ? ApiError.gone('upload_url_expired', 'This upload link has expired. Start again.')
        : ApiError.forbidden('bad_signature', 'This upload link is not valid.');
    }

    const contentType = req.header('content-type') ?? '';
    if (!isAllowedUploadType(contentType.split(';')[0]?.trim() ?? '')) {
      throw ApiError.badRequest('unsupported_type', 'Upload a JPEG, PNG or WebP image.');
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw ApiError.badRequest('empty_upload', 'No image data was received.');
    }
    if (body.length > MAX_UPLOAD_BYTES) {
      throw ApiError.tooLarge('file_too_large', 'That image is too large.');
    }

    await adapter.write(query.key, body);
    res.status(200).json({ key: query.key, bytes: body.length });
  }),
);

storageRouter.get(
  '/object',
  asyncRoute(async (req, res) => {
    const query = parseQuery(signedQuerySchema, req);
    const adapter = localAdapter();

    const verdict = adapter.verify(query.key, query.exp, 'get', query.sig);
    if (!verdict.ok) {
      throw verdict.reason === 'expired'
        ? ApiError.gone('read_url_expired', 'This link has expired.')
        : ApiError.forbidden('bad_signature', 'This link is not valid.');
    }

    if (!(await adapter.objectExists(query.key))) {
      throw ApiError.notFound('object_not_found', 'That image is no longer stored.');
    }

    const bytes = await adapter.readObject(query.key);
    const extension = query.key.split('.').pop()?.toLowerCase();
    const contentType =
      extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';

    res.setHeader('content-type', contentType);
    // Private, short-lived. Never cached by a shared proxy.
    res.setHeader('cache-control', 'private, max-age=60, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(bytes);
  }),
);
