/**
 * Centralized configuration loader.
 * All environment variables are read once at startup and typed here.
 */
export const config = {
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  encryptionKey: process.env.ENCRYPTION_KEY || 'dev-key-change-me-16b',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://crmuser:password@localhost:5432/zalocrm',
  uploadDir: process.env.UPLOAD_DIR || '/var/lib/zalo-crm/files',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  isProduction: process.env.NODE_ENV === 'production',

  // Feature 0027 — MinIO/S3 attachment mirror.
  // `s3Endpoint` is the internal URL the backend uses to talk to MinIO
  // (docker DNS name in prod, localhost in dev). `s3PublicUrl` is what
  // browsers see in <img src> / <video src> tags. They MUST differ when
  // backend and browsers live in different network namespaces (e.g.
  // docker-internal vs. host network) — otherwise URLs returned to the FE
  // would be unreachable from outside the docker network.
  s3Endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  s3PublicUrl: process.env.S3_PUBLIC_URL || 'http://localhost:9000',
  s3Bucket: process.env.S3_BUCKET || 'zalocrm-attachments',
  s3AccessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
  s3SecretKey: process.env.S3_SECRET_KEY || 'minioadmin',
  s3Region: process.env.S3_REGION || 'us-east-1',

  // Feature 0033 — friend aggregates.
  // Window (in days) used by /api/v1/friends/stats to decide whether a friend
  // counts as "actively chatting" (i.e. has an inbound message in the window).
  // Default: 7. Increase if customers want a looser definition of active.
  friendActiveWindowDays: Math.max(
    1,
    parseInt(process.env.FRIEND_ACTIVE_WINDOW_DAYS || '7', 10) || 7,
  ),
};
