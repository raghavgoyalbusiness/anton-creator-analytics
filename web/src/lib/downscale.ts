/**
 * Client-side image downscale, before upload.
 *
 * Two reasons this happens on the phone rather than the server: a creator on
 * mobile data should not upload a 4 MB screenshot, and the vision model is
 * billed per image tile, so a 2796px-tall screenshot costs materially more than
 * the same screenshot at 1600px with no gain in legibility.
 *
 * Quality is set high (0.92) on purpose. These images are almost entirely small
 * text and thin UI lines, which is exactly what JPEG artefacts destroy, and an
 * unreadable digit becomes a low-confidence extraction and then human work.
 */

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.92;

export interface DownscaleResult {
  readonly blob: Blob;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly originalBytes: number;
  readonly bytes: number;
  readonly previewUrl: string;
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      // Honours EXIF orientation, which matters: a screenshot shared through
      // some chat apps arrives rotated, and a sideways panel reads as noise.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('That file could not be read as an image.'));
      img.src = url;
    });
    return img;
  } finally {
    // The bitmap has been decoded into the element; the object URL is spent.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function downscaleImage(file: File): Promise<DownscaleResult> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image. A screenshot from your Insights panel.');
  }

  const source = await loadBitmap(file);
  const sourceWidth = 'width' in source ? source.width : 0;
  const sourceHeight = 'height' in source ? source.height : 0;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error('That image appears to be empty.');
  }

  const longEdge = Math.max(sourceWidth, sourceHeight);
  const scale = longEdge > MAX_EDGE_PX ? MAX_EDGE_PX / longEdge : 1;
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser cannot process the image.');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Flatten onto white first: screenshots with alpha would otherwise composite
  // onto black in a JPEG and lose the text entirely.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);

  if ('close' in source && typeof source.close === 'function') source.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new Error('Could not prepare the image for upload.');

  return {
    blob,
    contentType: 'image/jpeg',
    width,
    height,
    originalBytes: file.size,
    bytes: blob.size,
    previewUrl: URL.createObjectURL(blob),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
