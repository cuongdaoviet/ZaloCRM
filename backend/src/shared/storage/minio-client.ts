/**
 * minio-client.ts — MinIO/S3 storage client for chat attachments (feature 0027).
 *
 * Wraps the official `minio` SDK with a tiny `uploadBuffer()` helper that
 * returns a publicly-reachable URL suitable for `<img src>` / `<video src>`
 * tags (bucket is configured as anonymous-read by `minio-init`).
 *
 * - `s3Endpoint` is the internal URL the backend uses to PUT objects.
 * - `s3PublicUrl` is what we hand back to the FE — they may differ when
 *   backend is on a docker-internal network and browsers see the host.
 * - `ensureBucket()` is idempotent and called once at app startup.
 */
import { Client } from 'minio';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { config } from '../../config/index.js';

function parseEndpoint(url: string): { endPoint: string; port: number; useSSL: boolean } {
  const u = new URL(url);
  const useSSL = u.protocol === 'https:';
  const port = u.port ? parseInt(u.port) : useSSL ? 443 : 80;
  return { endPoint: u.hostname, port, useSSL };
}

const { endPoint, port, useSSL } = parseEndpoint(config.s3Endpoint);

export const minioClient = new Client({
  endPoint,
  port,
  useSSL,
  accessKey: config.s3AccessKey,
  secretKey: config.s3SecretKey,
  region: config.s3Region,
});

const BUCKET = config.s3Bucket;

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  mimeType: string;
}

/**
 * Upload a buffer to MinIO and return the public URL.
 * Object key format (BR-0001): `YYYY-MM-DD/<uuid><ext>`.
 * Throws on failure — callers decide whether to abort the request.
 */
export async function uploadBuffer(
  buffer: Buffer,
  mimeType: string,
  originalName?: string,
): Promise<UploadResult> {
  const ext = originalName && extname(originalName) ? extname(originalName) : mimeToExt(mimeType);
  const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext}`;
  await minioClient.putObject(BUCKET, key, buffer, buffer.length, {
    'Content-Type': mimeType,
    'Cache-Control': 'public, max-age=31536000',
  });
  return {
    key,
    url: `${config.s3PublicUrl}/${BUCKET}/${key}`,
    size: buffer.length,
    mimeType,
  };
}

function mimeToExt(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'application/pdf') return '.pdf';
  return '';
}

/**
 * Idempotent bucket bootstrap. Called once at app startup.
 * BR-0010: matches the pattern of `prisma db push` on container start.
 */
export async function ensureBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await minioClient.makeBucket(BUCKET, config.s3Region);
  }
}
