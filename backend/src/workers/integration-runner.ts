/**
 * Integration runner — Feature 0038.
 *
 * Cron tick every 5 minutes. Finds enabled `google_sheets` integrations
 * whose schedule (hourly/daily) says they're due, opens a run row, and
 * dispatches the sync via the integration-service.
 *
 * Concurrency: module-level `tickRunning` flag prevents reentry (same
 * pattern as workflow-runner — Feature 0037). Phase 2 upgrade is
 * `FOR UPDATE SKIP LOCKED` per integration row when we run multiple
 * workers.
 *
 * Errors are absorbed by `executeSyncRun` (writes a failed run row + sets
 * lastError). The worker itself just iterates and never throws so a single
 * misbehaving integration can't poison the loop.
 */
import cron from 'node-cron';
import { prisma } from '../shared/database/prisma-client.js';
import { logger } from '../shared/utils/logger.js';
import { decryptConfig } from '../shared/crypto/encrypt-config.js';
import { getConnector } from '../modules/integrations/connectors/index.js';
import {
  openSyncRun,
  executeSyncRun,
} from '../modules/integrations/integration-service.js';

const BATCH_SIZE = 25;
let tickRunning = false;
let started = false;

export function startIntegrationRunner(): void {
  if (started) {
    logger.warn('[integration-runner] already started, skipping');
    return;
  }
  // Every 5 min: minute hour dom mon dow.
  cron.schedule('*/5 * * * *', () => {
    runDueIntegrations().catch((err) =>
      logger.error('[integration-runner] tick error:', err),
    );
  });
  started = true;
  logger.info('[integration-runner] started (tick every 5 min)');
}

/**
 * Single tick. Idempotent and exported so tests can drive it deterministically.
 *
 * The query is intentionally permissive (only filtering by `enabled` + type)
 * because the "due-ness" check lives on the connector. Sheets uses
 * `isDue(config, lastSyncedAt)` which we evaluate here in JS to keep DB
 * indexes simple; phase 2 may move cron expressions to a column.
 */
export async function runDueIntegrations(): Promise<void> {
  if (tickRunning) {
    logger.debug('[integration-runner] tick already in progress, skipping');
    return;
  }
  tickRunning = true;
  try {
    const candidates = await prisma.integration.findMany({
      where: {
        enabled: true,
        type: 'google_sheets',
      },
      take: BATCH_SIZE,
      // Oldest lastSyncedAt first so a backlog drains FIFO.
      orderBy: { lastSyncedAt: 'asc' },
    });

    if (candidates.length === 0) return;

    let dispatched = 0;
    for (const row of candidates) {
      if (row.configCipher.length === 0) continue; // soft-deleted
      const connector = getConnector(row.type);
      if (!connector || !connector.sync || !connector.isDue) continue;
      let config: unknown;
      try {
        config = decryptConfig(row.orgId, {
          configCipher: row.configCipher,
          configIv: row.configIv,
          configTag: row.configTag,
        });
      } catch (err) {
        // Bad ciphertext is a hard failure — surface it on the row so
        // admin notices instead of silently retrying forever.
        logger.warn(
          `[integration-runner] decrypt failed for ${row.id}: ${(err as Error).message}`,
        );
        await prisma.integration.update({
          where: { id: row.id },
          data: { lastError: 'Cannot decrypt config — please reconfigure' },
        });
        continue;
      }
      if (!connector.isDue(config as never, row.lastSyncedAt)) continue;

      try {
        const { runId, row: refreshed } = await openSyncRun(row.id);
        // Run sequentially to keep DB load predictable in phase 1.
        await executeSyncRun(runId, refreshed);
        dispatched += 1;
      } catch (err) {
        // openSyncRun can throw if the row was deleted between query and
        // execution — log + move on.
        logger.warn(
          `[integration-runner] open failed for ${row.id}: ${(err as Error).message}`,
        );
      }
    }

    if (dispatched > 0) {
      logger.info(`[integration-runner] processed ${dispatched} integration(s)`);
    }
  } finally {
    tickRunning = false;
  }
}

/** Exposed for tests so they can assert on the singleton flag. */
export function _isTickRunning(): boolean {
  return tickRunning;
}
