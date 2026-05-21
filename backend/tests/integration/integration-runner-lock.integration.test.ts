/**
 * Feature 0045 — integration-runner row-level lock (AC-0006).
 *
 * Mirror of `workflow-runner-lock.integration.test.ts`. Asserts the
 * integration-runner's `FOR UPDATE SKIP LOCKED` claim skips rows that
 * another transaction has already locked.
 *
 * The connector is mocked at the module boundary so we don't reach
 * out to Google Sheets — only the lock mechanic is being tested here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// vitest hoists vi.mock() so any closed-over mocks must live behind
// vi.hoisted (same pattern as integrations.integration.test.ts).
const { syncMock, isDueMock } = vi.hoisted(() => ({
  syncMock: vi.fn(),
  isDueMock: vi.fn(),
}));

const connectorMock = {
  validateConfig: vi.fn(() => ({ ok: true })),
  testConnection: vi.fn(async () => ({ ok: true })),
  sync: syncMock,
  isDue: isDueMock,
};

vi.mock('../../src/modules/integrations/connectors/index.js', () => ({
  getConnector: (type: string) => (type === 'google_sheets' ? connectorMock : null),
}));

vi.mock('../../src/shared/crypto/encrypt-config.js', () => ({
  encryptConfig: () => ({
    configCipher: 'cipher',
    configIv: 'iv',
    configTag: 'tag',
  }),
  decryptConfig: () => ({ schedule: 'hourly', spreadsheetId: 'sheet' }),
}));

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedIntegration(orgId: string, name: string): Promise<string> {
  const row = await prisma.integration.create({
    data: {
      orgId,
      type: 'google_sheets',
      name,
      configCipher: 'cipher',
      configIv: 'iv',
      configTag: 'tag',
      enabled: true,
      // Old lastSyncedAt so `isDue` returns true (mocked anyway, but
      // matches the SQL `ORDER BY last_synced_at ASC` semantics).
      lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  return row.id;
}

describe('AC-0006: integration-runner uses FOR UPDATE SKIP LOCKED', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    isDueMock.mockReturnValue(true);
    syncMock.mockResolvedValue({ status: 'succeeded', recordsProcessed: 0 });
  });

  it('skips a row that is already locked by a competing transaction', async () => {
    const org = await prisma.organization.create({ data: { name: 'IntLockOrg' } });
    const lockedId = await seedIntegration(org.id, 'Locked');
    const freeId = await seedIntegration(org.id, 'Free');

    // Open a competing Prisma transaction that explicitly locks the
    // first integration row via `FOR UPDATE`. Hold for ~1.5s.
    let competingDone = false;
    const competing = prisma
      .$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM integrations
          WHERE id = ${lockedId}
          FOR UPDATE
        `;
        await sleep(1500);
        competingDone = true;
      })
      .catch((err) => {
        throw err;
      });

    // Give the competing tx a beat to actually acquire its lock.
    await sleep(200);

    const { runDueIntegrations } = await import(
      '../../src/workers/integration-runner.js'
    );
    await runDueIntegrations();

    expect(competingDone).toBe(false);

    // Only the free row should have been sync'd. The locked row's
    // sync mock is never reached because SKIP LOCKED filtered it out.
    expect(syncMock).toHaveBeenCalledTimes(1);

    // IntegrationRun rows: exactly one for the free integration.
    const runs = await prisma.integrationRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0].integrationId).toBe(freeId);
    expect(runs[0].status).toBe('succeeded');

    // Locked row untouched.
    const lockedAfter = await prisma.integration.findUnique({
      where: { id: lockedId },
    });
    expect(lockedAfter?.lastSyncedAt?.getTime()).toBeLessThan(Date.now() - 30 * 60 * 1000);

    // Free row's lastSyncedAt advanced to now.
    const freeAfter = await prisma.integration.findUnique({
      where: { id: freeId },
    });
    expect(freeAfter?.lastSyncedAt?.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);

    // Wait for competing tx to release; next tick claims the row.
    await competing;
    expect(competingDone).toBe(true);

    // After release, the locked row's `lastSyncedAt` is still 1h old
    // → isDue returns true → it gets sync'd this tick. The freshly-
    // synced free row was just updated to NOW, so when we wire isDue
    // to flip false for already-recently-synced rows it would be
    // skipped — but since isDueMock is unconditional, both rows could
    // be picked up. Use the `lastSyncedAt` re-fetch as the source of
    // truth that the previously-locked row was finally processed.
    syncMock.mockClear();
    await runDueIntegrations();

    const lockedFinal = await prisma.integration.findUnique({
      where: { id: lockedId },
    });
    expect(lockedFinal?.lastSyncedAt?.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
    // syncMock was called at least once for the previously-locked row
    // (may be 2 if isDue also said the just-synced free row is due).
    expect(syncMock).toHaveBeenCalled();
  }, 30_000);
});
