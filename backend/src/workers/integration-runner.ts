/**
 * Integration runner — Feature 0038 (claim mechanic refactored in Feature 0045).
 *
 * Cron tick every 5 minutes. Finds enabled `google_sheets` integrations
 * whose schedule (hourly/daily) says they're due, opens a run row, and
 * dispatches the sync via the integration-service.
 *
 * Concurrency safety has TWO layers (same shape as workflow-runner):
 *
 *   1. Cross-process: a Prisma `$transaction` claims the batch via
 *      `$queryRaw` with `FOR UPDATE SKIP LOCKED LIMIT 25`. Another
 *      backend process running the same cron sees zero rows for the
 *      duration of our batch and exits cleanly — no double-sync.
 *      See SPEC 0045 §3 BR-0001..BR-0006.
 *
 *   2. Within-process: a module-level `tickRunning` flag prevents the
 *      cron from re-entering the same tick if a previous tick is still
 *      draining (e.g. a slow Sheets sync). Per SPEC 0045 BR-0003.
 *
 * The `isDue(config, lastSyncedAt)` check still lives in JS because
 * the schedule lives inside the encrypted config blob, not a column —
 * we can't predicate on it in SQL. We therefore claim rows on the
 * cheaper `enabled = true AND type = 'google_sheets'` predicate and
 * filter to truly-due rows in the loop. Worst-case waste is ~25 rows'
 * worth of lock time on an idle deployment, which is fine.
 *
 * Errors are absorbed by `executeSyncRun` (writes a failed run row +
 * sets lastError). The worker itself catches per-row exceptions so a
 * single misbehaving integration can't poison the loop (BR-0005).
 */
import cron from 'node-cron';
import type { Prisma } from '@prisma/client';
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

/**
 * Raw row shape returned by `$queryRaw`. Prisma does NOT camelCase raw
 * query results, so we map snake_case → camelCase explicitly. Column
 * list is enumerated (no `SELECT *`) so the type stays stable when the
 * schema grows columns (SPEC 0045 §8 Risk #1).
 */
interface IntegrationRow {
  id: string;
  org_id: string;
  type: string;
  name: string;
  config_cipher: string;
  config_iv: string;
  config_tag: string;
  enabled: boolean;
  last_synced_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MappedIntegration {
  id: string;
  orgId: string;
  type: string;
  name: string;
  configCipher: string;
  configIv: string;
  configTag: string;
  enabled: boolean;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToIntegration(row: IntegrationRow): MappedIntegration {
  return {
    id: row.id,
    orgId: row.org_id,
    type: row.type,
    name: row.name,
    configCipher: row.config_cipher,
    configIv: row.config_iv,
    configTag: row.config_tag,
    enabled: row.enabled,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
  // BR-0009 — make the locking strategy explicit in logs.
  logger.info(
    `[integration-runner] started, lock=postgres-skip-locked, batch=${BATCH_SIZE}`,
  );
}

/**
 * Single tick. Idempotent and exported so tests can drive it deterministically.
 *
 * The SQL predicate is intentionally permissive (`enabled = true AND
 * type = 'google_sheets'`) because the "due-ness" check lives on the
 * connector and depends on the encrypted config's `schedule` field. We
 * evaluate `isDue` in JS *after* locking — this can claim more rows
 * than we actually sync, but the wasted lock time is bounded by the
 * BATCH_SIZE and acceptable in phase 1.
 */
export async function runDueIntegrations(): Promise<void> {
  if (tickRunning) {
    logger.debug('[integration-runner] tick already in progress, skipping');
    return;
  }
  tickRunning = true;
  try {
    // The whole batch lives in ONE Prisma interactive transaction. Row-
    // level locks taken via `FOR UPDATE SKIP LOCKED` are held until
    // commit at the bottom of this block. We pass `tx` through to
    // `openSyncRun` + `executeSyncRun` so the Integration row's
    // lastSyncedAt/lastError writes stay inside the locking tx (BR-0001).
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const rawRows = await tx.$queryRaw<IntegrationRow[]>`
        SELECT id, org_id, type, name, config_cipher, config_iv,
               config_tag, enabled, last_synced_at, last_error,
               created_at, updated_at
        FROM integrations
        WHERE enabled = true
          AND type = 'google_sheets'
        ORDER BY last_synced_at ASC NULLS FIRST
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;

      // AC-0009 — observability: ops can see if rows are being claimed
      // by another process (steady-state count drops unexpectedly).
      logger.info(
        `[integration-runner] tick: claimed ${rawRows.length} row(s)`,
      );

      if (rawRows.length === 0) return;

      let dispatched = 0;
      for (const raw of rawRows) {
        const row = rowToIntegration(raw);
        // BR-0005 — per-row error isolation. A misbehaving row throws,
        // gets logged, and the next row in the batch keeps going. The
        // transaction commits at the end and releases all locks.
        try {
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
            // Bad ciphertext is a hard failure — surface it on the row
            // via tx so the write commits with the rest of the batch.
            logger.warn(
              `[integration-runner] decrypt failed for ${row.id}: ${(err as Error).message}`,
            );
            await tx.integration.update({
              where: { id: row.id },
              data: { lastError: 'Cannot decrypt config — please reconfigure' },
            });
            continue;
          }
          if (!connector.isDue(config as never, row.lastSyncedAt)) continue;

          const { runId, row: refreshed } = await openSyncRun(row.id, tx);
          // Run sequentially to keep DB load predictable in phase 1.
          await executeSyncRun(runId, refreshed, tx);
          dispatched += 1;
        } catch (err) {
          logger.warn(
            `[integration-runner] dispatch failed for ${row.id}: ${(err as Error).message}`,
          );
        }
      }

      if (dispatched > 0) {
        logger.info(`[integration-runner] processed ${dispatched} integration(s)`);
      }
    });
  } finally {
    tickRunning = false;
  }
}

/** Exposed for tests so they can assert on the singleton flag. */
export function _isTickRunning(): boolean {
  return tickRunning;
}
