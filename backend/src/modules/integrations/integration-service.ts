/**
 * Integration service — orchestrates connector dispatch.
 *
 * Responsibilities:
 *  - Convert API-facing plain configs into encrypted DB rows (and back).
 *  - Run a sync (Sheets) end-to-end: open run row → call connector → close
 *    run row + Integration.lastSyncedAt/lastError.
 *  - Tee webhook events into Telegram-style connectors.
 *
 * The routes layer should treat this as the only entry point; it must not
 * touch `decryptConfig` or call connectors directly. That gives us one
 * place to harden when phase-2 adds connectors (Slack, Zapier, FB Messenger).
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { trackBackground } from '../../shared/utils/background-tasks.js';
import {
  encryptConfig,
  decryptConfig,
  type EncryptedConfig,
} from '../../shared/crypto/encrypt-config.js';
import { getConnector } from './connectors/index.js';
import type {
  IntegrationConnector,
  IntegrationEvent,
  SupportedEventType,
} from './connectors/types.js';

export interface IntegrationSummary {
  id: string;
  orgId: string;
  type: string;
  name: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  configured: boolean;
  createdAt: string;
  updatedAt: string;
}

interface IntegrationRow {
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

/**
 * Build the FE-facing JSON. The encrypted columns NEVER leave this module
 * — `configured: true` is the only signal admins need.
 */
export function toSummary(row: IntegrationRow): IntegrationSummary {
  return {
    id: row.id,
    orgId: row.orgId,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastError: row.lastError,
    // `configCipher` is required at create; an empty string means soft-deleted
    // (DELETE handler clears it). FE renders a "Reconfigure" CTA when false.
    configured: row.configCipher.length > 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Helper for callers that already have a partial integration row from
 * Prisma (with whatever select shape) — they only need the public fields.
 */
function decryptRowConfig(row: IntegrationRow): unknown {
  return decryptConfig({
    configCipher: row.configCipher,
    configIv: row.configIv,
    configTag: row.configTag,
  });
}

export interface CreateIntegrationInput {
  orgId: string;
  type: string;
  name: string;
  config: unknown;
}

export interface CreateResult {
  ok: boolean;
  integration?: IntegrationSummary;
  error?: string;
}

/**
 * Create a new integration. Steps:
 *  1. Resolve connector. Unknown type → 400.
 *  2. Validate config shape (cheap, no remote calls).
 *  3. Test connection (one remote call). Failure → 400 + provider error.
 *  4. Encrypt + persist.
 */
export async function createIntegration(input: CreateIntegrationInput): Promise<CreateResult> {
  const connector = getConnector(input.type);
  if (!connector) {
    return { ok: false, error: `Unsupported integration type: ${input.type}` };
  }
  const validate = connector.validateConfig(input.config);
  if (!validate.ok) {
    return { ok: false, error: validate.error ?? 'Invalid config' };
  }
  const probe = await connector.testConnection(input.config as never);
  if (!probe.ok) {
    return { ok: false, error: probe.error ?? 'Connection test failed' };
  }
  const enc = encryptConfig(input.config);
  const row = await prisma.integration.create({
    data: {
      orgId: input.orgId,
      type: input.type,
      name: input.name,
      configCipher: enc.configCipher,
      configIv: enc.configIv,
      configTag: enc.configTag,
      enabled: true,
    },
  });
  return { ok: true, integration: toSummary(row as IntegrationRow) };
}

export interface UpdateIntegrationInput {
  orgId: string;
  id: string;
  name?: string;
  enabled?: boolean;
  config?: unknown;
}

export async function updateIntegration(input: UpdateIntegrationInput): Promise<CreateResult> {
  const existing = await prisma.integration.findFirst({
    where: { id: input.id, orgId: input.orgId },
  });
  if (!existing) return { ok: false, error: 'Integration not found' };
  const connector = getConnector(existing.type);
  if (!connector) return { ok: false, error: `Unknown type: ${existing.type}` };

  let enc: EncryptedConfig | null = null;
  if (input.config !== undefined) {
    const validate = connector.validateConfig(input.config);
    if (!validate.ok) return { ok: false, error: validate.error ?? 'Invalid config' };
    const probe = await connector.testConnection(input.config as never);
    if (!probe.ok) return { ok: false, error: probe.error ?? 'Connection test failed' };
    enc = encryptConfig(input.config);
  }

  const row = await prisma.integration.update({
    where: { id: input.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(enc
        ? {
            configCipher: enc.configCipher,
            configIv: enc.configIv,
            configTag: enc.configTag,
            // Reset last error after successful reconfigure.
            lastError: null,
          }
        : {}),
    },
  });
  return { ok: true, integration: toSummary(row as IntegrationRow) };
}

/**
 * Soft-delete: clear the encrypted config (so the row can't be silently
 * re-enabled) and flip `enabled=false`. We leave the row in place so
 * IntegrationRun history is preserved for audit.
 */
export async function softDeleteIntegration(orgId: string, id: string): Promise<boolean> {
  const existing = await prisma.integration.findFirst({ where: { id, orgId } });
  if (!existing) return false;
  await prisma.integration.update({
    where: { id },
    data: {
      enabled: false,
      configCipher: '',
      configIv: '',
      configTag: '',
      lastError: null,
    },
  });
  return true;
}

/**
 * Open a "running" IntegrationRun row up-front, return its ID, then let the
 * caller hand the actual sync to `executeSyncRun(runId, integrationId)`
 * via trackBackground(). Two-phase so the HTTP route can return 202 with a
 * concrete runId before the sync completes.
 */
export async function openSyncRun(integrationId: string): Promise<{
  runId: string;
  row: IntegrationRow;
}> {
  const row = (await prisma.integration.findUnique({ where: { id: integrationId } })) as
    | IntegrationRow
    | null;
  if (!row) throw new Error('Integration not found');
  if (!row.enabled) throw new Error('Integration is disabled');
  if (row.configCipher.length === 0) throw new Error('Integration has no config');
  const connector = getConnector(row.type);
  if (!connector || !connector.sync) {
    throw new Error(`Connector ${row.type} does not support sync`);
  }
  const runRow = await prisma.integrationRun.create({
    data: { integrationId: row.id, status: 'running' },
  });
  return { runId: runRow.id, row };
}

/**
 * Execute the connector sync for an already-open run row and close it out.
 * Worker + manual-trigger route both go through here. Never throws — all
 * failures are recorded on the run row + parent Integration.
 */
export async function executeSyncRun(runId: string, row: IntegrationRow): Promise<void> {
  const connector = getConnector(row.type);
  if (!connector || !connector.sync) {
    await prisma.integrationRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        errorDetail: `Connector ${row.type} does not support sync`,
        completedAt: new Date(),
      },
    });
    return;
  }
  try {
    const config = decryptRowConfig(row);
    const result = await connector.sync(row.orgId, config as never);
    await prisma.integrationRun.update({
      where: { id: runId },
      data: {
        status: result.status,
        recordsProcessed: result.recordsProcessed,
        errorDetail: result.status === 'failed' ? result.error : null,
        completedAt: new Date(),
      },
    });
    await prisma.integration.update({
      where: { id: row.id },
      data: {
        lastSyncedAt: new Date(),
        lastError: result.status === 'failed' ? result.error.slice(0, 500) : null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.integrationRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        errorDetail: msg.slice(0, 500),
        completedAt: new Date(),
      },
    });
    await prisma.integration.update({
      where: { id: row.id },
      data: { lastError: msg.slice(0, 500) },
    });
    logger.error(`[integrations] executeSyncRun crashed for ${row.id}: ${msg}`);
  }
}

/**
 * Convenience wrapper: open + execute in one call. Used by tests and any
 * caller that doesn't need the 202-with-runId pattern.
 */
export async function runSync(integrationId: string): Promise<string> {
  const { runId, row } = await openSyncRun(integrationId);
  await executeSyncRun(runId, row);
  return runId;
}

/**
 * Tee a webhook event into every event-driven connector that subscribed to
 * it. Called from the webhook-service emitWebhook helper (and from tests).
 *
 * Fire-and-forget: caller wraps with trackBackground() so test teardown can
 * drain in-flight deliveries before TRUNCATE.
 */
export async function dispatchEvent(event: IntegrationEvent): Promise<void> {
  try {
    const candidates = await prisma.integration.findMany({
      where: {
        orgId: event.orgId,
        enabled: true,
        type: { in: ['telegram_bot'] }, // Only event-driven connectors today.
      },
    });
    for (const row of candidates) {
      if (row.configCipher.length === 0) continue; // soft-deleted
      const connector = getConnector(row.type);
      if (!connector || !connector.onEvent) continue;
      let config: unknown;
      try {
        config = decryptRowConfig(row as IntegrationRow);
      } catch (err) {
        logger.warn(
          `[integrations] dispatchEvent: cannot decrypt config for ${row.id}: ${(err as Error).message}`,
        );
        continue;
      }
      // Filter by subscription. Connector also defends against this, but the
      // dispatcher is the cheaper place to skip work.
      const typed = config as { eventTypes?: SupportedEventType[] };
      if (!Array.isArray(typed.eventTypes) || !typed.eventTypes.includes(event.type as SupportedEventType)) {
        continue;
      }
      // Each delivery is its own fire-and-forget so a slow Telegram chat
      // doesn't block a faster one.
      trackBackground(
        connector.onEvent(event, config as never).catch((err) => {
          logger.warn(`[integrations] onEvent error (${row.id}): ${(err as Error).message}`);
        }),
      );
    }
  } catch (err) {
    logger.error('[integrations] dispatchEvent failed:', err);
  }
}

/**
 * Look up an integration + decrypt its config in one place. Tests and
 * workers use this to avoid repeating the encryption plumbing.
 */
export async function getIntegrationWithConfig(
  orgId: string,
  id: string,
): Promise<{ row: IntegrationRow; config: unknown } | null> {
  const row = (await prisma.integration.findFirst({
    where: { id, orgId },
  })) as IntegrationRow | null;
  if (!row || row.configCipher.length === 0) return null;
  return { row, config: decryptRowConfig(row) };
}

// Re-export for tests + worker.
export type { IntegrationConnector };
