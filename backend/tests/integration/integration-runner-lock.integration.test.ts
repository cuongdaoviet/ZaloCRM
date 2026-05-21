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

describe('AC-0007: per-row error isolation inside the integration batch', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    isDueMock.mockReturnValue(true);
  });

  /**
   * SPEC 0045 §6 AC-0007 + BR-0005 — a single connector failure inside
   * the batch must NOT roll back the whole transaction. The two
   * surrounding integrations still get their `lastSyncedAt` updated and
   * a 'succeeded' IntegrationRun row; the failing integration commits
   * with `lastError` populated and a 'failed' run row.
   *
   * Test shape: seed 3 enabled google_sheets integrations, force the
   * middle row's `connector.sync` to reject, drive one
   * `runDueIntegrations()`. Assert all three rows show post-batch
   * state — proving the worker's per-row try/catch + transaction
   * commit semantics work end-to-end.
   */
  it(
    'one failing connector does not poison the other rows in the batch',
    async () => {
      const org = await prisma.organization.create({ data: { name: 'IsoOrg' } });
      // Stagger lastSyncedAt so the worker's ORDER BY last_synced_at
      // ASC NULLS FIRST claim returns them in (ok1, fail, ok2) order.
      const okId1 = (
        await prisma.integration.create({
          data: {
            orgId: org.id,
            type: 'google_sheets',
            name: 'IsoOk1',
            configCipher: 'cipher',
            configIv: 'iv',
            configTag: 'tag',
            enabled: true,
            lastSyncedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          },
        })
      ).id;
      const failId = (
        await prisma.integration.create({
          data: {
            orgId: org.id,
            type: 'google_sheets',
            name: 'IsoFail',
            configCipher: 'cipher',
            configIv: 'iv',
            configTag: 'tag',
            enabled: true,
            lastSyncedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        })
      ).id;
      const okId2 = (
        await prisma.integration.create({
          data: {
            orgId: org.id,
            type: 'google_sheets',
            name: 'IsoOk2',
            configCipher: 'cipher',
            configIv: 'iv',
            configTag: 'tag',
            enabled: true,
            lastSyncedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
          },
        })
      ).id;

      // Sequence syncMock per-call: rows 1 + 3 succeed, row 2 throws.
      // We can't rely on call order being stable across implementations,
      // so we resolve based on which row the connector is being asked
      // to sync. Connector receives (orgId, config) — both identical
      // across rows because decryptConfig is mocked. Use call counter
      // instead: row 1 = call #1, fail = call #2, row 3 = call #3.
      syncMock.mockImplementation(async () => {
        const callIdx = syncMock.mock.calls.length;
        if (callIdx === 2) {
          throw new Error('connector blew up on middle row');
        }
        return { status: 'succeeded', recordsProcessed: 7 };
      });

      const { runDueIntegrations } = await import(
        '../../src/workers/integration-runner.js'
      );
      await runDueIntegrations();

      // Sync was attempted for all three rows.
      expect(syncMock).toHaveBeenCalledTimes(3);

      // Row 1 (ok) — lastSyncedAt fresh, lastError cleared.
      const ok1 = await prisma.integration.findUnique({ where: { id: okId1 } });
      expect(ok1?.lastSyncedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(ok1?.lastError).toBeNull();

      // Row 2 (failed) — lastError populated. lastSyncedAt is NOT
      // updated by executeSyncRun's failure branch (only `lastError`
      // is written), so it remains at the original ~2h-old value.
      const fail = await prisma.integration.findUnique({ where: { id: failId } });
      expect(fail?.lastError).toContain('connector blew up on middle row');
      expect(fail?.lastSyncedAt?.getTime()).toBeLessThan(Date.now() - 60 * 60 * 1000);

      // Row 3 (ok) — fresh lastSyncedAt. THIS is the key assertion:
      // the row AFTER the failing one still got committed, proving the
      // batch was not unwound by row 2's throw.
      const ok2 = await prisma.integration.findUnique({ where: { id: okId2 } });
      expect(ok2?.lastSyncedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(ok2?.lastError).toBeNull();

      // Belt-and-suspenders: the IntegrationRun ledger reflects the
      // same picture — two 'succeeded' rows and one 'failed' row,
      // all committed in the same batch transaction.
      const runs = await prisma.integrationRun.findMany({
        orderBy: { startedAt: 'asc' },
      });
      expect(runs).toHaveLength(3);
      const byIntegration = new Map(runs.map((r) => [r.integrationId, r.status]));
      expect(byIntegration.get(okId1)).toBe('succeeded');
      expect(byIntegration.get(failId)).toBe('failed');
      expect(byIntegration.get(okId2)).toBe('succeeded');
    },
    30_000,
  );
});
