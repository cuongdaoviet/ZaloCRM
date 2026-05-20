/**
 * download-mirror.ts — best-effort helper for the inbound mirror (feature 0027).
 *
 * Given a Zalo CDN URL, download the bytes (timeout 10s, max 20MB) and
 * re-upload to MinIO. Returns `null` on ANY failure — the caller is
 * expected to keep the original Zalo URL on the persisted Message
 * (BR-0008: mirror failure does NOT block message ingest).
 */
import { logger } from '../utils/logger.js';
import { uploadBuffer, type UploadResult } from './minio-client.js';

const DOWNLOAD_TIMEOUT_MS = 10_000;
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20 MB — matches outbound cap.

export interface MirrorOptions {
  /** Source URL on Zalo CDN. */
  url: string;
  /** Override MIME type. If absent, falls back to `Content-Type` response header
   *  or 'application/octet-stream'. */
  mimeType?: string;
  /** Original filename for extension inference. */
  filename?: string;
}

/**
 * Download from `url` and re-upload to MinIO.
 * Returns the {@link UploadResult} on success, or `null` on any failure.
 *
 * EC-0004 — Aborts the fetch if the response exceeds {@link DOWNLOAD_MAX_BYTES}
 * (checked first via `Content-Length`, then enforced while streaming).
 */
export async function mirrorAttachment(opts: MirrorOptions): Promise<UploadResult | null> {
  const { url, mimeType, filename } = opts;
  if (!url || !/^https?:\/\//.test(url)) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn(`[mirror] download ${url} → HTTP ${res.status}`);
      return null;
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > DOWNLOAD_MAX_BYTES) {
      logger.warn(`[mirror] skip ${url} — Content-Length ${contentLength} > 20MB`);
      return null;
    }

    const buffer = await readWithCap(res, DOWNLOAD_MAX_BYTES);
    if (!buffer) {
      logger.warn(`[mirror] skip ${url} — exceeded 20MB during stream`);
      return null;
    }

    const finalMime =
      mimeType || res.headers.get('content-type') || 'application/octet-stream';

    return await uploadBuffer(buffer, finalMime, filename);
  } catch (err) {
    logger.warn(`[mirror] failed for ${url}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the response body into a Buffer but abort if the running total
 * exceeds `maxBytes`. Returns `null` when the cap is hit.
 */
async function readWithCap(res: Response, maxBytes: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body — fall back to arrayBuffer with a manual length check.
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return Buffer.from(ab);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Best-effort — the response is already aborted.
      }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
