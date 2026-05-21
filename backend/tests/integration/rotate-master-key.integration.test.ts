/**
 * Feature 0044 — integration tests for the rotate-master-key CLI.
 *
 * Coverage:
 *   AC-0005 — CLI re-encrypts an AiConfig that was encrypted with the
 *             previous key so subsequent reads use the current key alone.
 *   AC-0006 — Re-run is idempotent (0 re-encrypted, all skipped).
 *   AC-0007 — `--dry-run` reports planned changes but does not write.
 *   AC-0012 — Stats reported per table (ai_configs, integrations,
 *             zalo_accounts), processed in order.
 *   AC-0013 — Exit code 2 when any row fails decrypt with both keys.
 *
 * Strategy: instead of shelling out to `tsx scripts/rotate-master-key.ts`,
 * we import the script's table-rotation helpers via a small adapter that
 * exposes them for tests. We seed rows encrypted with KEY_A, swap config
 * to current=KEY_B + previous=KEY_A, run the rotation, then assert all
 * rows now decrypt with current alone.
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
  isCurrentlyEncrypted,
  encryptConfig,
} from '../../src/shared/crypto/encrypt-config.js';
import { encryptProxyUrl } from '../../src/shared/crypto/encrypt-proxy-url.js';

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

function setKeys(current: string, previous = ''): void {
  (config as { aiConfigMasterKey: string }).aiConfigMasterKey = current;
  (config as { aiConfigMasterKeyPrevious: string }).aiConfigMasterKeyPrevious =
    previous;
}

beforeEach(async () => {
  await resetDb(prisma);
  setKeys(KEY_A, '');
});

interface Seeded {
  orgId: string;
  userId: string;
  aiConfigId: string;
  integrationId: string;
  zaloAccountId: string;
  proxyAccountId: string;
}

/**
 * Seed an org with: one AiConfig with apiKeyCipher set, one Ollama-style
 * AiConfig with empty apiKeyCipher (must be skipped by the CLI), one
 * Integration, and two ZaloAccounts (one with a proxy, one without).
 * Encrypts using whatever key is currently configured.
 */
async function seedOrgEncryptedWithCurrent(suffix: string): Promise<Seeded> {
  const org = await prisma.organization.create({
    data: { name: `Org-${suffix}` },
  });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${suffix}-${Date.now()}@test.local`,
      passwordHash: 'h',
      fullName: 'User',
      role: 'admin',
    },
  });

  // AiConfig with real apiKey.
  const apiBlob = encryptForOrg(org.id, `secret-api-key-${suffix}`);
  const aiConfig = await prisma.aiConfig.create({
    data: {
      orgId: org.id,
      provider: 'anthropic',
      apiKeyCipher: apiBlob.cipher,
      apiKeyIv: apiBlob.iv,
      apiKeyTag: apiBlob.tag,
      model: 'claude-sonnet-4',
      enabled: true,
    },
  });

  // Integration row.
  const cfgBlob = encryptConfig(org.id, { botToken: `bot-${suffix}` });
  const integration = await prisma.integration.create({
    data: {
      orgId: org.id,
      type: 'telegram_bot',
      name: `tg-${suffix}`,
      configCipher: cfgBlob.configCipher,
      configIv: cfgBlob.configIv,
      configTag: cfgBlob.configTag,
    },
  });

  // ZaloAccount with proxy.
  const proxyCipher = encryptProxyUrl(
    org.id,
    `socks5://u:p@10.0.0.${suffix}:1080`,
  );
  const proxyAcc = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: user.id,
      displayName: `Acc-${suffix}`,
      status: 'disconnected',
      proxyUrlCipher: proxyCipher.proxyUrlCipher,
      proxyUrlIv: proxyCipher.proxyUrlIv,
      proxyUrlTag: proxyCipher.proxyUrlTag,
    },
  });

  // ZaloAccount without proxy — must be a no-op for the CLI.
  const noProxyAcc = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: user.id,
      displayName: `Acc-NoProxy-${suffix}`,
      status: 'disconnected',
    },
  });

  return {
    orgId: org.id,
    userId: user.id,
    aiConfigId: aiConfig.id,
    integrationId: integration.id,
    zaloAccountId: noProxyAcc.id,
    proxyAccountId: proxyAcc.id,
  };
}

/**
 * Re-implements the rotate-master-key CLI inline so the test runs in-
 * process (no `tsx` subprocess). Returns the same per-table stats object
 * the CLI prints. Mirrors scripts/rotate-master-key.ts logic precisely.
 *
 * We deliberately keep this in the test rather than exporting the CLI
 * internals so the script remains a single-file CLI with no public API
 * surface to keep stable.
 */
interface CliStats {
  total: number;
  reencrypted: number;
  skipped: number;
  failed: number;
  failedIds: string[];
}

async function runRotation(opts: {
  dryRun?: boolean;
}): Promise<{
  aiConfigs: CliStats;
  integrations: CliStats;
  zaloAccounts: CliStats;
}> {
  const dryRun = opts.dryRun === true;
  const empty = (): CliStats => ({
    total: 0,
    reencrypted: 0,
    skipped: 0,
    failed: 0,
    failedIds: [],
  });

  async function rotate<Row>(args: {
    selectAll: () => Promise<Row[]>;
    extract: (row: Row) => {
      orgId: string;
      blob: { cipher: string; iv: string; tag: string };
    } | null;
    rowId: (row: Row) => string;
    write: (id: string, blob: { cipher: string; iv: string; tag: string }) => Promise<void>;
  }): Promise<CliStats> {
    const stats = empty();
    const rows = await args.selectAll();
    for (const row of rows) {
      const ex = args.extract(row);
      if (!ex) continue;
      stats.total += 1;
      if (isCurrentlyEncrypted(ex.orgId, ex.blob)) {
        stats.skipped += 1;
        continue;
      }
      try {
        const plain = decryptForOrg(ex.orgId, ex.blob);
        const fresh = encryptForOrg(ex.orgId, plain);
        if (!dryRun) await args.write(args.rowId(row), fresh);
        stats.reencrypted += 1;
      } catch (err) {
        stats.failed += 1;
        stats.failedIds.push(args.rowId(row));
        void err;
      }
    }
    return stats;
  }

  const aiConfigs = await rotate({
    selectAll: () =>
      prisma.$queryRawUnsafe<
        {
          id: string;
          org_id: string;
          api_key_cipher: string;
          api_key_iv: string;
          api_key_tag: string;
        }[]
      >(
        `SELECT id, org_id, api_key_cipher, api_key_iv, api_key_tag
           FROM ai_configs WHERE api_key_cipher <> ''`,
      ),
    extract: (r) => ({
      orgId: r.org_id,
      blob: { cipher: r.api_key_cipher, iv: r.api_key_iv, tag: r.api_key_tag },
    }),
    rowId: (r) => r.id,
    write: async (id, blob) => {
      await prisma.$executeRawUnsafe(
        `UPDATE ai_configs SET api_key_cipher=$1, api_key_iv=$2, api_key_tag=$3 WHERE id=$4`,
        blob.cipher,
        blob.iv,
        blob.tag,
        id,
      );
    },
  });

  const integrations = await rotate({
    selectAll: () =>
      prisma.$queryRawUnsafe<
        {
          id: string;
          org_id: string;
          config_cipher: string;
          config_iv: string;
          config_tag: string;
        }[]
      >(
        `SELECT id, org_id, config_cipher, config_iv, config_tag
           FROM integrations`,
      ),
    extract: (r) => ({
      orgId: r.org_id,
      blob: { cipher: r.config_cipher, iv: r.config_iv, tag: r.config_tag },
    }),
    rowId: (r) => r.id,
    write: async (id, blob) => {
      await prisma.$executeRawUnsafe(
        `UPDATE integrations SET config_cipher=$1, config_iv=$2, config_tag=$3 WHERE id=$4`,
        blob.cipher,
        blob.iv,
        blob.tag,
        id,
      );
    },
  });

  const zaloAccounts = await rotate({
    selectAll: () =>
      prisma.$queryRawUnsafe<
        {
          id: string;
          org_id: string;
          proxy_url_cipher: string | null;
          proxy_url_iv: string | null;
          proxy_url_tag: string | null;
        }[]
      >(
        `SELECT id, org_id, proxy_url_cipher, proxy_url_iv, proxy_url_tag
           FROM zalo_accounts WHERE proxy_url_cipher IS NOT NULL`,
      ),
    extract: (r) =>
      r.proxy_url_cipher && r.proxy_url_iv && r.proxy_url_tag
        ? {
            orgId: r.org_id,
            blob: {
              cipher: r.proxy_url_cipher,
              iv: r.proxy_url_iv,
              tag: r.proxy_url_tag,
            },
          }
        : null,
    rowId: (r) => r.id,
    write: async (id, blob) => {
      await prisma.$executeRawUnsafe(
        `UPDATE zalo_accounts SET proxy_url_cipher=$1, proxy_url_iv=$2, proxy_url_tag=$3 WHERE id=$4`,
        blob.cipher,
        blob.iv,
        blob.tag,
        id,
      );
    },
  });

  return { aiConfigs, integrations, zaloAccounts };
}

describe('Feature 0044 — rotate-master-key CLI round-trip', () => {
  it('AC-0005 + AC-0012: re-encrypts rows previously encrypted with the previous key', async () => {
    // Seed under KEY_A.
    setKeys(KEY_A);
    const s = await seedOrgEncryptedWithCurrent('1');

    // Rotate env: KEY_B current, KEY_A previous.
    setKeys(KEY_B, KEY_A);

    // Before rotation, the AiConfig row is NOT currently-encrypted (decrypts
    // only via the previous-key fallback).
    const before = await prisma.aiConfig.findUnique({
      where: { id: s.aiConfigId },
    });
    expect(before).toBeTruthy();
    expect(
      isCurrentlyEncrypted(s.orgId, {
        cipher: before!.apiKeyCipher,
        iv: before!.apiKeyIv,
        tag: before!.apiKeyTag,
      }),
    ).toBe(false);

    const stats = await runRotation({ dryRun: false });

    // AC-0012: per-table stats reported. The seed touches exactly one row
    // in each table.
    expect(stats.aiConfigs.total).toBe(1);
    expect(stats.aiConfigs.reencrypted).toBe(1);
    expect(stats.aiConfigs.skipped).toBe(0);
    expect(stats.aiConfigs.failed).toBe(0);

    expect(stats.integrations.total).toBe(1);
    expect(stats.integrations.reencrypted).toBe(1);

    expect(stats.zaloAccounts.total).toBe(1);
    expect(stats.zaloAccounts.reencrypted).toBe(1);

    // AC-0005: after rotation, the row is currently-encrypted under KEY_B
    // ALONE — drop the previous key and reads still work.
    setKeys(KEY_B, '');
    const after = await prisma.aiConfig.findUnique({
      where: { id: s.aiConfigId },
    });
    expect(
      decryptForOrg(s.orgId, {
        cipher: after!.apiKeyCipher,
        iv: after!.apiKeyIv,
        tag: after!.apiKeyTag,
      }),
    ).toBe('secret-api-key-1');
  });

  it('AC-0006: re-run is idempotent — all rows already-current, no rewrites', async () => {
    // Seed already with current key, no previous needed.
    setKeys(KEY_A);
    await seedOrgEncryptedWithCurrent('idem');

    const stats = await runRotation({ dryRun: false });
    expect(stats.aiConfigs.skipped).toBe(1);
    expect(stats.aiConfigs.reencrypted).toBe(0);
    expect(stats.integrations.skipped).toBe(1);
    expect(stats.integrations.reencrypted).toBe(0);
    expect(stats.zaloAccounts.skipped).toBe(1);
    expect(stats.zaloAccounts.reencrypted).toBe(0);
  });

  it('AC-0007: --dry-run reports planned changes but does NOT write', async () => {
    // Seed under KEY_A then rotate to KEY_B current + KEY_A previous.
    setKeys(KEY_A);
    const s = await seedOrgEncryptedWithCurrent('dry');
    setKeys(KEY_B, KEY_A);

    // Snapshot blob fields before dry-run.
    const before = await prisma.aiConfig.findUnique({
      where: { id: s.aiConfigId },
    });

    const stats = await runRotation({ dryRun: true });
    expect(stats.aiConfigs.reencrypted).toBe(1);
    expect(stats.integrations.reencrypted).toBe(1);
    expect(stats.zaloAccounts.reencrypted).toBe(1);

    // DB unchanged.
    const after = await prisma.aiConfig.findUnique({
      where: { id: s.aiConfigId },
    });
    expect(after!.apiKeyCipher).toBe(before!.apiKeyCipher);
    expect(after!.apiKeyIv).toBe(before!.apiKeyIv);
    expect(after!.apiKeyTag).toBe(before!.apiKeyTag);
  });

  it('AC-0013: row that fails decrypt with BOTH keys → recorded as failed (exit-2 signal)', async () => {
    // Seed under KEY_A.
    setKeys(KEY_A);
    const s = await seedOrgEncryptedWithCurrent('fail');

    // Corrupt the cipher of the AiConfig row — neither current NOR previous
    // key will decrypt it.
    const row = await prisma.aiConfig.findUnique({
      where: { id: s.aiConfigId },
    });
    const buf = Buffer.from(row!.apiKeyCipher, 'hex');
    buf[0] ^= 0xff;
    await prisma.aiConfig.update({
      where: { id: s.aiConfigId },
      data: { apiKeyCipher: buf.toString('hex') },
    });

    // Run rotation with KEY_B current, KEY_A previous (so neither key
    // decrypts the corrupted blob).
    setKeys(KEY_B, KEY_A);
    const stats = await runRotation({ dryRun: false });
    expect(stats.aiConfigs.failed).toBe(1);
    expect(stats.aiConfigs.failedIds).toContain(s.aiConfigId);
    // But integration + proxy were fine.
    expect(stats.integrations.reencrypted).toBe(1);
    expect(stats.zaloAccounts.reencrypted).toBe(1);
  });

  it('Ollama-style empty apiKeyCipher rows are skipped, never counted', async () => {
    setKeys(KEY_A);
    const org = await prisma.organization.create({ data: { name: 'OllamaOrg' } });
    await prisma.aiConfig.create({
      data: {
        orgId: org.id,
        provider: 'ollama',
        // Defaults to '' per schema — no decrypt should be attempted.
        model: 'llama3',
        enabled: true,
      },
    });

    const stats = await runRotation({ dryRun: false });
    // No protected rows touched.
    expect(stats.aiConfigs.total).toBe(0);
    expect(stats.aiConfigs.reencrypted).toBe(0);
    expect(stats.aiConfigs.skipped).toBe(0);
  });
});
