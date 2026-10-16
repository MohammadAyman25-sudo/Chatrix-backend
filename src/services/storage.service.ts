import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

export interface StorageService {
  upload(input: UploadInput): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

export const LOCAL_UPLOAD_DIR = path.resolve('uploads');

class R2Storage implements StorageService {
  private readonly client: S3Client;

  constructor() {
    this.client = new S3Client({
      region: env.R2_REGION,
      endpoint: env.R2_ENDPOINT,
      // R2 is S3-compatible; path-style avoids bucket subdomain DNS.
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
      },
    });
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
    return { key, url: `${env.R2_URL}/${key}` };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  }
}

class LocalStorage implements StorageService {
  async upload({ key, buffer }: UploadInput): Promise<StoredObject> {
    const filePath = path.join(LOCAL_UPLOAD_DIR, key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return { key, url: `/uploads/${key}` };
  }

  async delete(key: string): Promise<void> {
    await unlink(path.join(LOCAL_UPLOAD_DIR, key)).catch(() => undefined);
  }
}

function createStorage(): StorageService {
  return env.MEDIA_DISK === 'r2' ? new R2Storage() : new LocalStorage();
}

export const storage = createStorage();
