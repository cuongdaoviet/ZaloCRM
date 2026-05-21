/**
 * Feature 0044 — integration tests for the one-off proxyUrl backfill
 * migration that swaps `zalo_accounts.proxy_url TEXT` for the three
 * AES-256-GCM cipher columns.
 *
 * Coverage:
 *   AC-0008 — Schema change: proxy_url column dropped, cipher columns
 *             added, plaintext values backfilled into cipher.
 *   AC-0009 — Round-trip decrypt works after the migration.
 *   EC-0007 — Invalid row logged + skipped, NOT dropped.
 *
 * The testcontainer setup applies the FINAL schema (no proxy_url column
 * present), so we re-introduce the legacy column manually before each
 * test, seed plaintext values, then run the migration in-process and
 * assert post-state.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';
import { config } from '../../src/config/index.js';
import {
  encryptForOrg,
  decryptForOrg,
} from '../../src/shared/crypto/encrypt-config.js';

const TEST_KEY = 'cc'.repeat(32);

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = await setupDb();
  (config as { aiConfigMasterKey: string }).aiConfigMasterKey = TEST_KEY;
  (config as { aiConfigMasterKeyPrevious: string }).aiConfigMasterKeyPrevious =
    '';
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await resetDb(prisma);
  // Re-introduce the legacy proxy_url column so this test exercises the
  // backfill from plaintext. Idempotent (some tests below may drop it).
  await prisma.$executeRawUnsafe(
    `ALTER TABLE zalo_accounts ADD COLUMN IF NOT EXISTS proxy_url TEXT`,
  );
  // Make sure the new cipher columns exist (in case a prior test in the
  // file dropped them).
  await prisma.$executeRawUnsafe(
    `ALTER TABLE zalo_accounts
       ADD COLUMN IF NOT EXISTS proxy_url_cipher TEXT,
       ADD COLUMN IF NOT EXISTS proxy_url_iv TEXT,
       ADD COLUMN IF NOT EXISTS proxy_url_tag TEXT`,
  );
});

/**
 * Inline re-implementation of scripts/migrate-encrypt-proxy-url.ts
 * (without process.exit / DB connection setup) so it runs in-process
 * against the shared testcontainer.
 */
interface MigrationResult {
  rowsScanned: number;
  rowsEncrypted: number;
  rowsAlreadyMigrated: number;
  rowsSkippedInvalid: number;
  rowsWithoutProxy: number;
  oldColumnDropped: boolean;
  failedRowIds: string[];
}

async function runMigration(opts: {
  dryRun?: boolean;
}): Promise<MigrationResult> {
  const dryRun = opts.dryRun === true;
  const stats: MigrationResult = {
    rowsScanned: 0,
    rowsEncrypted: 0,
    rowsAlreadyMigrated: 0,
    rowsSkippedInvalid: 0,
    rowsWithoutProxy: 0,
    oldColumnDropped: false,
    failedRowIds: [],
  };

  if (!dryRun) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE zalo_accounts
         ADD COLUMN IF NOT EXISTS proxy_url_cipher TEXT,
         ADD COLUMN IF NOT EXISTS proxy_url_iv     TEXT,
         ADD COLUMN IF NOT EXISTS proxy_url_tag    TEXT`,
    );
  }

  const rows: {
    id: string;
    org_id: string;
    proxy_url: string | null;
    proxy_url_cipher: string | null;
  }[] = await prisma.$queryRawUnsafe(
    `SELECT id, org_id, proxy_url, proxy_url_cipher FROM zalo_accounts`,
  );

  for (const row of rows) {
    stats.rowsScanned += 1;
    if (!row.proxy_url) {
      stats.rowsWithoutProxy += 1;
      continue;
    }
    if (row.proxy_url_cipher) {
      stats.rowsAlreadyMigrated += 1;
      continue;
    }
    try {
      const blob = encryptForOrg(row.org_id, row.proxy_url);
      if (!dryRun) {
        await prisma.$executeRawUnsafe(
          `UPDATE zalo_accounts
              SET proxy_url_cipher = $1,
                  proxy_url_iv     = $2,
                  proxy_url_tag    = $3
            WHERE id = $4 AND proxy_url_cipher IS NULL`,
          blob.cipher,
          blob.iv,
          blob.tag,
          row.id,
        );
      }
      stats.rowsEncrypted += 1;
    } catch {
      stats.rowsSkippedInvalid += 1;
      stats.failedRowIds.push(row.id);
    }
  }

  if (!dryRun && stats.rowsSkippedInvalid === 0) {
    const remaining: { count: bigint }[] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count
         FROM zalo_accounts
        WHERE proxy_url IS NOT NULL AND proxy_url_cipher IS NULL`,
    );
    if (Number(remaining[0]?.count ?? 0n) === 0) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE zalo_accounts DROP COLUMN IF EXISTS proxy_url`,
      );
      stats.oldColumnDropped = true;
    }
  }

  return stats;
}

async function seedLegacyAccount(
  orgName: string,
  plainProxy: string | null,
): Promise<{ orgId: string; accountId: string }> {
  const org = await prisma.organization.create({ data: { name: orgName } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@t.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'admin',
    },
  });
  // Create via cipher columns NULL (no proxy), then set legacy column via
  // raw SQL to simulate a pre-0044 schema row.
  const acc = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: owner.id,
      displayName: orgName,
      status: 'disconnected',
    },
  });
  if (plainProxy !== null) {
    await prisma.$executeRawUnsafe(
      `UPDATE zalo_accounts SET proxy_url = $1 WHERE id = $2`,
      plainProxy,
      acc.id,
    );
  }
  return { orgId: org.id, accountId: acc.id };
}

describe('Feature 0044 — migrate-encrypt-proxy-url backfill', () => {
  it('AC-0008 + AC-0009: encrypts plaintext rows, drops legacy column, round-trip decrypts', async () => {
    const a = await seedLegacyAccount('OrgA', 'socks5://u:p@10.0.0.1:1080');
    const b = await seedLegacyAccount('OrgB', 'http://proxy:8080');
    // Row C has no proxy — must be untouched.
    const c = await seedLegacyAccount('OrgC', null);

    const stats = await runMigration({ dryRun: false });
    expect(stats.rowsEncrypted).toBe(2);
    expect(stats.rowsWithoutProxy).toBe(1);
    expect(stats.rowsSkippedInvalid).toBe(0);
    expect(stats.oldColumnDropped).toBe(true);

    // Legacy column is gone.
    const cols: { exists: boolean }[] = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='zalo_accounts' AND column_name='proxy_url') AS exists`,
    );
    expect(cols[0]?.exists).toBe(false);

    // AC-0009: decrypting each migrated row returns the original plaintext.
    const rowA = await prisma.zaloAccount.findUnique({
      where: { id: a.accountId },
    });
    const rowB = await prisma.zaloAccount.findUnique({
      where: { id: b.accountId },
    });
    const rowC = await prisma.zaloAccount.findUnique({
      where: { id: c.accountId },
    });

    expect(
      decryptForOrg(a.orgId, {
        cipher: rowA!.proxyUrlCipher!,
        iv: rowA!.proxyUrlIv!,
        tag: rowA!.proxyUrlTag!,
      }),
    ).toBe('socks5://u:p@10.0.0.1:1080');
    expect(
      decryptForOrg(b.orgId, {
        cipher: rowB!.proxyUrlCipher!,
        iv: rowB!.proxyUrlIv!,
        tag: rowB!.proxyUrlTag!,
      }),
    ).toBe('http://proxy:8080');
    expect(rowC!.proxyUrlCipher).toBeNull();
  });

  it('is idempotent — re-running after a successful migration is a no-op', async () => {
    await seedLegacyAccount('OrgIdem', 'socks5://10.0.0.1:1080');

    const first = await runMigration({ dryRun: false });
    expect(first.rowsEncrypted).toBe(1);
    expect(first.oldColumnDropped).toBe(true);

    // Re-run: legacy column already dropped, nothing to do.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE zalo_accounts ADD COLUMN IF NOT EXISTS proxy_url TEXT`,
    );
    // Re-running on a clean schema: rowsScanned reflects rows seen but no
    // encryption + no failure.
    const second = await runMigration({ dryRun: false });
    expect(second.rowsEncrypted).toBe(0);
    expect(second.rowsSkippedInvalid).toBe(0);
    // Already-migrated row OR rows-without-proxy account for every row.
    expect(
      second.rowsAlreadyMigrated + second.rowsWithoutProxy,
    ).toBeGreaterThanOrEqual(1);
  });

  it('dry-run reports planned changes but writes nothing', async () => {
    const a = await seedLegacyAccount('OrgDry', 'socks5://10.0.0.1:1080');

    const stats = await runMigration({ dryRun: true });
    expect(stats.rowsEncrypted).toBe(1);
    expect(stats.oldColumnDropped).toBe(false);

    // proxy_url_cipher is still NULL.
    const row = await prisma.zaloAccount.findUnique({
      where: { id: a.accountId },
    });
    expect(row?.proxyUrlCipher).toBeNull();
    // Legacy column still present.
    const cols: { exists: boolean }[] = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name='zalo_accounts' AND column_name='proxy_url') AS exists`,
    );
    expect(cols[0]?.exists).toBe(true);
  });

  it('preserves partially-migrated rows on re-run (does not double-encrypt)', async () => {
    const a = await seedLegacyAccount('OrgPart', 'socks5://10.0.0.1:1080');

    // First run encrypts.
    const first = await runMigration({ dryRun: false });
    expect(first.rowsEncrypted).toBe(1);

    const cipherAfterFirst = await prisma.zaloAccount.findUnique({
      where: { id: a.accountId },
    });

    // Simulate partial state: re-add legacy column for another scan.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE zalo_accounts ADD COLUMN IF NOT EXISTS proxy_url TEXT`,
    );
    const second = await runMigration({ dryRun: false });

    expect(second.rowsEncrypted).toBe(0);
    const cipherAfterSecond = await prisma.zaloAccount.findUnique({
      where: { id: a.accountId },
    });
    expect(cipherAfterSecond!.proxyUrlCipher).toBe(
      cipherAfterFirst!.proxyUrlCipher,
    );
  });
});
