import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  PresignUploadParams,
  PresignedRead,
  PresignedUpload,
  StorageAdapter,
} from './types.js';

/**
 * Production driver. The bucket must be private with public access fully
 * blocked; every read goes through a short-lived presigned URL.
 *
 * NOT YET EXERCISED against a live bucket — there are no S3 credentials on the
 * development machine. The shape matches the AWS SDK v3 contract but treat the
 * first real deployment as the test.
 */
export class S3Adapter implements StorageAdapter {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    credentials: { accessKeyId: string; secretAccessKey: string },
    endpoint?: string,
  ) {
    this.client = new S3Client({
      region,
      credentials,
      // Set for R2, MinIO and other S3-compatible hosts. Path style is required
      // by most of them; AWS proper ignores it.
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  async presignUpload(params: PresignUploadParams): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ContentType: params.contentType,
      // Signed into the URL: an upload declaring a different length is rejected
      // by S3, so the size cap is enforced by storage rather than by trust.
      ContentLength: params.maxBytes,
    });
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn: params.expiresInSeconds,
    });
    return {
      uploadUrl,
      method: 'PUT',
      headers: { 'content-type': params.contentType },
      key: params.key,
      expiresAt: new Date(Date.now() + params.expiresInSeconds * 1000),
      maxBytes: params.maxBytes,
    };
  }

  async presignRead(key: string, expiresInSeconds: number): Promise<PresignedRead> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  async readObject(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error(`empty body for key ${key}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async writeObject(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType }),
    );
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
