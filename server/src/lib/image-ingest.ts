import sharp from 'sharp';
import { ApiError } from './errors.js';
import { ALLOWED_UPLOAD_TYPES, type AllowedUploadType } from '../storage/types.js';

/**
 * Post-upload image validation and normalisation.
 *
 * A presigned PUT enforces the declared content type at the storage layer, but
 * a declared type is a claim by the uploader. This re-derives the real type
 * from the file's own bytes and rejects anything that is not genuinely an
 * image — a `.png` that is actually a PDF, an SVG carrying script, a zip.
 */

/** Magic-byte signatures. Checked before sharp touches the buffer. */
const SIGNATURES: { type: AllowedUploadType; test: (b: Buffer) => boolean }[] = [
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    type: 'image/webp',
    test: (b) =>
      b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export function sniffImageType(bytes: Buffer): AllowedUploadType | null {
  for (const signature of SIGNATURES) {
    if (signature.test(bytes)) return signature.type;
  }
  return null;
}

export interface IngestedImage {
  /** Re-encoded, metadata stripped. This is what gets stored. */
  readonly bytes: Buffer;
  readonly contentType: AllowedUploadType;
  readonly width: number;
  readonly height: number;
  /**
   * Whether EXIF was present BEFORE stripping.
   *
   * Absence is normal and is not a red flag: a phone screenshot carries no EXIF
   * to begin with, and the browser's canvas re-encode strips whatever survived.
   * Recorded because presence is occasionally informative — a "screenshot" that
   * arrives with camera EXIF is a photo of a screen, which is a different thing.
   */
  readonly exifPresent: boolean;
  readonly captureTimestamp: Date | null;
}

/** Parses the EXIF DateTimeOriginal / DateTime field, which is not ISO 8601. */
function parseExifDate(raw: string): Date | null {
  // "2026:08:15 14:03:22"
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function readExifTimestamp(exif: Buffer): Date | null {
  // Deliberately not a full EXIF parser. The tag we want is an ASCII run in a
  // fixed, recognisable shape, and scanning for it avoids pulling in a parser
  // for a field that is advisory anyway.
  const text = exif.toString('latin1');
  const match = /(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})/.exec(text);
  return match?.[1] ? parseExifDate(match[1]) : null;
}

/**
 * Validates, records metadata, then strips it.
 *
 * The output is a re-encode rather than the original bytes with metadata
 * removed. Re-encoding through sharp means anything the decoder did not
 * understand — trailing data after the image, a polyglot payload, an embedded
 * colour profile carrying junk — does not survive into storage.
 */
export async function ingestImage(
  bytes: Buffer,
  declaredType: string,
  maxBytes: number,
): Promise<IngestedImage> {
  if (bytes.length === 0) {
    throw ApiError.badRequest('empty_upload', 'That upload was empty.');
  }
  if (bytes.length > maxBytes) {
    throw ApiError.tooLarge('file_too_large', 'That image is too large.');
  }

  const sniffed = sniffImageType(bytes);
  if (sniffed === null) {
    throw ApiError.badRequest(
      'not_an_image',
      'That file is not a JPEG, PNG or WebP image, whatever it is named.',
    );
  }
  if (declaredType !== sniffed) {
    // A mismatch is worth refusing rather than silently trusting the bytes:
    // it means either a broken client or a deliberate attempt to smuggle.
    throw ApiError.badRequest(
      'type_mismatch',
      `That file was declared as ${declaredType} but its contents are ${sniffed}.`,
    );
  }

  let metadata: sharp.Metadata;
  let pipeline: sharp.Sharp;
  try {
    // failOn 'error' rejects truncated or structurally broken images rather
    // than silently producing a partial decode.
    pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 });
    metadata = await pipeline.metadata();
  } catch {
    throw ApiError.badRequest('unreadable_image', 'That image could not be read.');
  }

  if (!metadata.width || !metadata.height) {
    throw ApiError.badRequest('unreadable_image', 'That image has no readable dimensions.');
  }

  const exifPresent = Boolean(metadata.exif && metadata.exif.length > 0);
  const captureTimestamp = metadata.exif ? readExifTimestamp(metadata.exif) : null;

  // `rotate()` with no argument applies the EXIF orientation before we discard
  // the metadata, so a sideways screenshot is not baked in sideways forever.
  const normalised = await sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();

  const finalMeta = await sharp(normalised).metadata();

  return {
    bytes: normalised,
    contentType: 'image/jpeg',
    width: finalMeta.width ?? metadata.width,
    height: finalMeta.height ?? metadata.height,
    exifPresent,
    captureTimestamp,
  };
}

export { ALLOWED_UPLOAD_TYPES };
