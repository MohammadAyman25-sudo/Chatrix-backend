import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

export interface UploadInput {
  key: string;
  buffer: Buffer;
  contentType: string;
}

export interface StoredObject {
  key: string;
  url: string;
}

export interface PresignUploadInput {
  key: string;
  contentType: string;
  /** How long the URL stays valid. Defaults to 15 minutes. */
  expiresInSeconds?: number;
}

export interface PresignedUpload {
  key: string;
  /** Presigned `PUT` URL the client uploads the file bytes to. */
  url: string;
  /** Headers the client must send with the PUT (the content type is signed). */
  headers: Record<string, string>;
  expiresAt: Date;
}

/** Metadata of an object that already exists in the bucket. */
export interface StoredObjectInfo {
  key: string;
  url: string;
  size: number;
  contentType: string | null;
}

export interface StorageService {
  upload(input: UploadInput): Promise<StoredObject>;
  /** Signs a direct client -> bucket upload so bytes never pass through the API. */
  presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;
  /** `HeadObject`; resolves `null` when the key does not exist. */
  stat(key: string): Promise<StoredObjectInfo | null>;
  delete(key: string): Promise<void>;
  /** Public read URL of a key in the bucket's R2 public domain. */
  getPublicUrl(key: string): string;
}

/**
 * Cloudflare R2 (S3-compatible) object storage. Every uploaded file — avatars,
 * group icons, message attachments (images / audio / video / documents) and
 * recorded voice notes — is stored here. Clients upload directly with a
 * presigned URL; the app never writes uploads to the local filesystem.
 */
class R2Storage implements StorageService {
  private readonly client: S3Client;

  constructor() {
    this.client = new S3Client({
      region: env.R2_REGION,
      endpoint: env.R2_ENDPOINT,
      // R2 is S3-compatible; path-style avoids bucket subdomain DNS.
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  getPublicUrl(key: string): string {
    return `${env.R2_URL}/${key}`;
  }

  async upload({ key, buffer, contentType }: UploadInput): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return { key, url: this.getPublicUrl(key) };
  }

  async presignUpload({
    key,
    contentType,
    expiresInSeconds = 900,
  }: PresignUploadInput): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
    return {
      key,
      url,
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
      );
      return {
        key,
        url: this.getPublicUrl(key),
        size: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (name === 'NotFound' || name === 'NoSuchKey') {
    return true;
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}

export const storage: StorageService = new R2Storage();
