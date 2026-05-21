/**
 * Feature 0044 — Master-key rotation CLI.
 *
 * Re-encrypts every row protected by the AES-256-GCM master key so that
 * subsequent reads use the CURRENT key exclusively (no fallback). Idempotent
 * via `isCurrentlyEncrypted` skip-vs-rewrite check, resumable via
 * `FOR UPDATE SKIP LOCKED` batches.
 *
 * Usage:
 *   pnpm rotate-master-key              # actually rotate
 *   pnpm rotate-master-key --dry-run    # report only — no UPDATEs
 *   pnpm rotate-master-key --batch-size 200   # tune batch size
 *
 * Exit codes:
 *   0 — every row successfully decrypted + re-encrypted (or skipped because
 *       already current).
 *   1 — fatal: missing env vars, identical keys, DB unavailable.
 *   2 — partial: at least one row failed to decrypt with BOTH keys. Failed
 *       row IDs logged for operator triage (likely corrupt blobs / third
 *       historical key).
 *
 * Tables processed (BR-0006, in order):
 *   1. ai_configs    — (api_key_cipher, api_key_iv, api_key_tag), skipping
 *                      rows where api_key_cipher = '' (Ollama-style).
 *   2. integrations  — (config_cipher, config_iv, config_tag).
 *   3. zalo_accounts — (proxy_url_cipher, proxy_url_iv, proxy_url_tag),
 *                      skipping rows where all three are NULL (no proxy).
 *
 * The dual-key helper in encrypt-config.ts handles the actual decrypt
 * fallback. This script's only job is iteration, idempotence, and progress
 * reporting.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  encryptForOrg,
  decryptForOrg,
  isCurrentlyEncrypted,
  assertAiMasterKey,
  type EncryptedBlob,
} from '../src/shared/crypto/encrypt-config.js';

const DRY_RUN = process.argv.includes('--dry-run');

function parseBatchSize(argv: string[]): number {
  const idx = argv.indexOf('--batch-size');
  if (idx >= 0 && argv[idx + 1]) {
    const n = parseInt(argv[idx + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 100;
}
const BATCH_SIZE = parseBatchSize(process.argv);

interface TableStats {
  total: number;
  reencrypted: number;
  skipped: number;
  failed: number;
  failedIds: string[];
}

function emptyStats(): TableStats {
  return { total: 0, reencrypted: 0, skipped: 0, failed: 0, failedIds: [] };
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[rotate] ${msg}`);
}

/**
 * Generic per-table rotator. Tables have different column shapes so we
 * thread the SELECT/UPDATE SQL via callbacks rather than reflection.
 */
interface RotateTableArgs<Row> {
  table: string;
  selectRowsForBatch: (
    prisma: PrismaClient,
    batchSize: number,
  ) => Promise<Row[]>;
  // Returns the encrypted blob for the row, or null when the row should
  // be skipped entirely (e.g. Ollama empty-key rows, no-proxy rows).
  extractBlob: (row: Row) => { orgId: string; blob: EncryptedBlob } | null;
  getRowId: (row: Row) => string;
  // Writes new cipher/iv/tag back to the DB.
  updateRow: (
    prisma: PrismaClient,
    rowId: string,
    blob: EncryptedBlob,
  ) => Promise<void>;
}

async function rotateTable<Row>(
  prisma: PrismaClient,
  args: RotateTableArgs<Row>,
): Promise<TableStats> {
  const stats = emptyStats();
  // We loop until the SELECT returns fewer than BATCH_SIZE rows that need
  // work. To stay idempotent + resumable we always re-query (SKIP LOCKED
  // ensures we don't deadlock with live writers).
  // We also use a "processed set" to avoid infinite-loop on dry-run (where
  // we never UPDATE so the same rows keep coming back).
  const seenIds = new Set<string>();

  while (true) {
    const rows = await args.selectRowsForBatch(prisma, BATCH_SIZE);
    if (rows.length === 0) break;

    let progressed = 0;
    for (const row of rows) {
      const rowId = args.getRowId(row);
      // Dry-run loop break: skip rows we've already inspected this run.
      if (DRY_RUN && seenIds.has(rowId)) continue;
      seenIds.add(rowId);
      stats.total += 1;
      progressed += 1;

      const extracted = args.extractBlob(row);
      if (!extracted) {
        // Row intentionally skipped — e.g. Ollama empty key, or no proxy.
        // We still count it via stats.total above; treat as "already
        // current" for reporting clarity? No — leave it untouched.
        // Adjust: undo the total increment because this row isn't actually
        // protected.
        stats.total -= 1;
        progressed -= 1;
        continue;
      }
      const { orgId, blob } = extracted;

      // BR-0007: skip rows that already decrypt with the CURRENT key.
      if (isCurrentlyEncrypted(orgId, blob)) {
        stats.skipped += 1;
        continue;
      }

      // Try a full decrypt → re-encrypt. The dual-key fallback inside
      // decryptForOrg will try the previous key for us.
      let plaintext: string;
      try {
        plaintext = decryptForOrg(orgId, blob);
      } catch (err) {
        // Both keys failed — record and continue. BR-0009 exit 2.
        stats.failed += 1;
        stats.failedIds.push(rowId);
        log(
          `${args.table}: row ${rowId} (org=${orgId}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      const fresh = encryptForOrg(orgId, plaintext);

      if (!DRY_RUN) {
        await args.updateRow(prisma, rowId, fresh);
      }
      stats.reencrypted += 1;
    }

    log(
      `${args.table} ${stats.total} (${stats.reencrypted} re-encrypted, ` +
        `${stats.skipped} skipped, ${stats.failed} failed)`,
    );

    // Loop termination: in dry-run we never UPDATE so the same rows keep
    // matching; bail when the latest batch had no NEW rows to inspect.
    if (DRY_RUN && progressed === 0) break;
    // Real run: if the batch was smaller than requested, we're done.
    if (rows.length < BATCH_SIZE) break;
  }

  return stats;
}

interface AiConfigRow {
  id: string;
  org_id: string;
  api_key_cipher: string;
  api_key_iv: string;
  api_key_tag: string;
}

async function rotateAiConfigs(prisma: PrismaClient): Promise<TableStats> {
  // Idempotence: we cannot use "WHERE not-yet-rotated" because the schema
  // doesn't carry a key-version marker. Instead we walk the whole table
  // and rely on `isCurrentlyEncrypted` skip. We do, however, lock with
  // SKIP LOCKED to avoid contention.
  let offset = 0;
  return rotateTable<AiConfigRow>(prisma, {
    table: 'ai_configs',
    selectRowsForBatch: async (p, batch) => {
      const rows: AiConfigRow[] = await p.$queryRawUnsafe(
        `SELECT id, org_id, api_key_cipher, api_key_iv, api_key_tag
           FROM ai_configs
           WHERE api_key_cipher <> ''
           ORDER BY id
           LIMIT $1 OFFSET $2
           FOR UPDATE SKIP LOCKED`,
        batch,
        offset,
      );
      offset += rows.length;
      return rows;
    },
    extractBlob: (row) => {
      // BR-0006: skip Ollama-style empty key rows (defensive — already
      // filtered in SELECT above, but cheap to double-check).
      if (!row.api_key_cipher) return null;
      return {
        orgId: row.org_id,
        blob: {
          cipher: row.api_key_cipher,
          iv: row.api_key_iv,
          tag: row.api_key_tag,
        },
      };
    },
    getRowId: (row) => row.id,
    updateRow: async (p, id, blob) => {
      await p.$executeRawUnsafe(
        `UPDATE ai_configs
           SET api_key_cipher = $1, api_key_iv = $2, api_key_tag = $3
         WHERE id = $4`,
        blob.cipher,
        blob.iv,
        blob.tag,
        id,
      );
    },
  });
}

interface IntegrationRow {
  id: string;
  org_id: string;
  config_cipher: string;
  config_iv: string;
  config_tag: string;
}

async function rotateIntegrations(prisma: PrismaClient): Promise<TableStats> {
  let offset = 0;
  return rotateTable<IntegrationRow>(prisma, {
    table: 'integrations',
    selectRowsForBatch: async (p, batch) => {
      const rows: IntegrationRow[] = await p.$queryRawUnsafe(
        `SELECT id, org_id, config_cipher, config_iv, config_tag
           FROM integrations
           ORDER BY id
           LIMIT $1 OFFSET $2
           FOR UPDATE SKIP LOCKED`,
        batch,
        offset,
      );
      offset += rows.length;
      return rows;
    },
    extractBlob: (row) => ({
      orgId: row.org_id,
      blob: {
        cipher: row.config_cipher,
        iv: row.config_iv,
        tag: row.config_tag,
      },
    }),
    getRowId: (row) => row.id,
    updateRow: async (p, id, blob) => {
      await p.$executeRawUnsafe(
        `UPDATE integrations
           SET config_cipher = $1, config_iv = $2, config_tag = $3
         WHERE id = $4`,
        blob.cipher,
        blob.iv,
        blob.tag,
        id,
      );
    },
  });
}

interface ZaloAccountRow {
  id: string;
  org_id: string;
  proxy_url_cipher: string | null;
  proxy_url_iv: string | null;
  proxy_url_tag: string | null;
}

async function rotateZaloAccounts(prisma: PrismaClient): Promise<TableStats> {
  let offset = 0;
  return rotateTable<ZaloAccountRow>(prisma, {
    table: 'zalo_accounts',
    selectRowsForBatch: async (p, batch) => {
      const rows: ZaloAccountRow[] = await p.$queryRawUnsafe(
        `SELECT id, org_id, proxy_url_cipher, proxy_url_iv, proxy_url_tag
           FROM zalo_accounts
           WHERE proxy_url_cipher IS NOT NULL
           ORDER BY id
           LIMIT $1 OFFSET $2
           FOR UPDATE SKIP LOCKED`,
        batch,
        offset,
      );
      offset += rows.length;
      return rows;
    },
    extractBlob: (row) => {
      if (!row.proxy_url_cipher || !row.proxy_url_iv || !row.proxy_url_tag) {
        return null;
      }
      return {
        orgId: row.org_id,
        blob: {
          cipher: row.proxy_url_cipher,
          iv: row.proxy_url_iv,
          tag: row.proxy_url_tag,
        },
      };
    },
    getRowId: (row) => row.id,
    updateRow: async (p, id, blob) => {
      await p.$executeRawUnsafe(
        `UPDATE zalo_accounts
           SET proxy_url_cipher = $1,
               proxy_url_iv     = $2,
               proxy_url_tag    = $3
         WHERE id = $4`,
        blob.cipher,
        blob.iv,
        blob.tag,
        id,
      );
    },
  });
}

async function main(): Promise<void> {
  // BR-0009 exit 1 — env validation up front. assertAiMasterKey throws
  // when both keys are identical or the previous key is malformed.
  assertAiMasterKey();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();

  log(`mode=${DRY_RUN ? 'DRY-RUN' : 'WRITE'} batchSize=${BATCH_SIZE}`);

  const summary: Record<string, TableStats> = {
    aiConfigs: emptyStats(),
    integrations: emptyStats(),
    zaloAccounts: emptyStats(),
  };

  try {
    summary.aiConfigs = await rotateAiConfigs(prisma);
    summary.integrations = await rotateIntegrations(prisma);
    summary.zaloAccounts = await rotateZaloAccounts(prisma);
  } finally {
    await prisma.$disconnect();
  }

  const totalFailed =
    summary.aiConfigs.failed +
    summary.integrations.failed +
    summary.zaloAccounts.failed;

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ dryRun: DRY_RUN, ...summary }, null, 2));

  // BR-0009 exit 2.
  process.exit(totalFailed > 0 ? 2 : 0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    '[rotate] FATAL:',
    err instanceof Error ? err.stack ?? err.message : String(err),
  );
  process.exit(1);
});
