/**
 * Feature 0044 — one-off migration that encrypts every plaintext
 * `zalo_accounts.proxy_url` value into AES-256-GCM blobs stored in three
 * sibling columns (proxy_url_cipher, proxy_url_iv, proxy_url_tag), then
 * drops the old plaintext column.
 *
 * Why not a pure Prisma migration? Encryption needs the per-org HKDF sub-
 * key, which is derived in application code (encrypt-config.ts). We run the
 * migration as a Node script so we can reuse that helper.
 *
 * Idempotent — safe to re-run:
 *   1. ADD COLUMN IF NOT EXISTS for the three cipher fields.
 *   2. Backfill every row where the new cipher fields are NULL **but** the
 *      old proxy_url is non-NULL.
 *   3. ALTER TABLE ... DROP COLUMN IF EXISTS proxy_url, but only after the
 *      backfill verified every previously-plaintext row was encrypted (or
 *      logged as a skip — invalid URLs are not silently dropped).
 *
 * Usage:
 *   pnpm tsx scripts/migrate-encrypt-proxy-url.ts          # actually migrate
 *   pnpm tsx scripts/migrate-encrypt-proxy-url.ts --dry-run  # report only
 *
 * Exit codes:
 *   0 — done (or already done — no rows needed encryption).
 *   1 — fatal (env var missing, DB unavailable, malformed URL refused).
 *   2 — partial: at least one row had a proxy_url value that could not be
 *       encrypted (e.g. shape that fails URL validation). Old column NOT
 *       dropped; operator must investigate.
 *
 * BR-0011, BR-0012, EC-0007.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encryptForOrg } from '../src/shared/crypto/encrypt-config.js';

interface MigrationStats {
  rowsScanned: number;
  rowsEncrypted: number;
  rowsAlreadyMigrated: number;
  rowsSkippedInvalid: number;
  rowsWithoutProxy: number;
  oldColumnDropped: boolean;
}

const DRY_RUN = process.argv.includes('--dry-run');

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[migrate-encrypt-proxy-url] ${msg}`);
}

async function columnExists(
  prisma: PrismaClient,
  table: string,
  column: string,
): Promise<boolean> {
  const rows: { exists: boolean }[] = await prisma.$queryRawUnsafe(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2
    ) AS exists`,
    table,
    column,
  );
  return rows[0]?.exists === true;
}

async function ensureNewColumns(prisma: PrismaClient): Promise<void> {
  // Additive — IF NOT EXISTS makes this safe to re-run.
  if (DRY_RUN) {
    log('--dry-run: would ADD COLUMN proxy_url_cipher/iv/tag IF NOT EXISTS');
    return;
  }
  await prisma.$executeRawUnsafe(
    `ALTER TABLE zalo_accounts
       ADD COLUMN IF NOT EXISTS proxy_url_cipher TEXT,
       ADD COLUMN IF NOT EXISTS proxy_url_iv     TEXT,
       ADD COLUMN IF NOT EXISTS proxy_url_tag    TEXT`,
  );
  log('Ensured proxy_url_cipher/iv/tag columns exist.');
}

interface PlainProxyRow {
  id: string;
  org_id: string;
  proxy_url: string | null;
  proxy_url_cipher: string | null;
}

async function backfill(
  prisma: PrismaClient,
  stats: MigrationStats,
): Promise<string[]> {
  const failedRowIds: string[] = [];
  // We deliberately query in the OLD-schema mode (proxy_url column present)
  // and check cipher == NULL so re-runs after partial completion are safe.
  const rows: PlainProxyRow[] = await prisma.$queryRawUnsafe(
    `SELECT id, org_id, proxy_url, proxy_url_cipher
       FROM zalo_accounts`,
  );

  for (const row of rows) {
    stats.rowsScanned += 1;
    if (!row.proxy_url) {
      stats.rowsWithoutProxy += 1;
      continue;
    }
    if (row.proxy_url_cipher) {
      // Already encrypted on a previous run.
      stats.rowsAlreadyMigrated += 1;
      continue;
    }
    try {
      const blob = encryptForOrg(row.org_id, row.proxy_url);
      if (!DRY_RUN) {
        await prisma.$executeRawUnsafe(
          `UPDATE zalo_accounts
              SET proxy_url_cipher = $1,
                  proxy_url_iv     = $2,
                  proxy_url_tag    = $3
            WHERE id = $4
              AND proxy_url_cipher IS NULL`,
          blob.cipher,
          blob.iv,
          blob.tag,
          row.id,
        );
      }
      stats.rowsEncrypted += 1;
    } catch (err) {
      // EC-0007 — refuse to silently drop the value. Log + continue + exit 2.
      stats.rowsSkippedInvalid += 1;
      failedRowIds.push(row.id);
      log(
        `Row ${row.id} (org=${row.org_id}) skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return failedRowIds;
}

async function dropOldColumnIfSafe(
  prisma: PrismaClient,
  stats: MigrationStats,
  failedRowIds: string[],
): Promise<void> {
  if (DRY_RUN) {
    log('--dry-run: would DROP COLUMN proxy_url IF EXISTS (only if no failures)');
    return;
  }
  if (failedRowIds.length > 0) {
    log(
      `Refusing to drop old proxy_url column — ${failedRowIds.length} row(s) failed encryption. Investigate and re-run.`,
    );
    return;
  }
  // Sanity-check: cipher-NULL+proxy-NOT-NULL rows must be zero.
  const remaining: { count: bigint }[] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::bigint AS count
       FROM zalo_accounts
      WHERE proxy_url IS NOT NULL
        AND proxy_url_cipher IS NULL`,
  );
  if (Number(remaining[0]?.count ?? 0n) > 0) {
    log(
      `Refusing to drop old proxy_url column — ${remaining[0]?.count} plaintext row(s) still pending.`,
    );
    return;
  }
  await prisma.$executeRawUnsafe(
    `ALTER TABLE zalo_accounts DROP COLUMN IF EXISTS proxy_url`,
  );
  stats.oldColumnDropped = true;
  log('Dropped legacy plaintext proxy_url column.');
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();

  const stats: MigrationStats = {
    rowsScanned: 0,
    rowsEncrypted: 0,
    rowsAlreadyMigrated: 0,
    rowsSkippedInvalid: 0,
    rowsWithoutProxy: 0,
    oldColumnDropped: false,
  };
  let failedRowIds: string[] = [];

  try {
    const hasOldColumn = await columnExists(prisma, 'zalo_accounts', 'proxy_url');
    await ensureNewColumns(prisma);

    if (hasOldColumn) {
      failedRowIds = await backfill(prisma, stats);
      await dropOldColumnIfSafe(prisma, stats, failedRowIds);
    } else {
      log('Old proxy_url column not present — nothing to backfill.');
    }
  } finally {
    await prisma.$disconnect();
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      { dryRun: DRY_RUN, ...stats, failedRowIds },
      null,
      2,
    ),
  );

  process.exit(stats.rowsSkippedInvalid > 0 ? 2 : 0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    '[migrate-encrypt-proxy-url] FATAL:',
    err instanceof Error ? err.stack ?? err.message : String(err),
  );
  process.exit(1);
});
