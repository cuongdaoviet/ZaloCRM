/**
 * webhook-service.ts — fire-and-forget webhook delivery for org-configured endpoints.
 *
 * Feature 0014 adds persistence: every attempt writes a `WebhookDelivery` row
 * with the payload, signature, response status, duration, and any error.
 * Admins read these via the debug panel and can replay failed deliveries.
 *
 * Feature 0038 — same event is tee'd to the Integration Hub so Telegram bots
 * (and future Slack/Zapier connectors) can deliver formatted notifications.
 * The tee runs even when no `webhook_url` is configured, since the two
 * destinations are independent.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { trackBackground } from '../../shared/utils/background-tasks.js';
import { dispatchEvent as dispatchIntegrationEvent } from '../integrations/integration-service.js';
import crypto from 'node:crypto';

const MAX_DELIVERIES_PER_ORG = 1000;
const FETCH_TIMEOUT_MS = 10_000;

export async function emitWebhook(orgId: string, event: string, data: any): Promise<void> {
  // Tee to Integration Hub first — these are independent paths and we want
  // Telegram notifications even when no generic webhook URL is configured.
  trackBackground(
    dispatchIntegrationEvent({
      orgId,
      type: event,
      payload: data ?? {},
      emittedAt: new Date(),
    }).catch((err) => logger.warn('[webhook] integration tee failed:', err)),
  );

  try {
    const [urlConfig, secretConfig] = await Promise.all([
      prisma.appSetting.findFirst({ where: { orgId, settingKey: 'webhook_url' } }),
      prisma.appSetting.findFirst({ where: { orgId, settingKey: 'webhook_secret' } }),
    ]);
    if (!urlConfig?.valuePlain) return;

    const payload = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
    const signature = secretConfig?.valuePlain
      ? crypto.createHmac('sha256', secretConfig.valuePlain).update(payload).digest('hex')
      : null;

    // Fire-and-forget on the I/O, but synchronously schedule the delivery row.
    trackBackground(deliverAndPersist({ orgId, event, url: urlConfig.valuePlain, payload, signature }));
  } catch (err) {
    logger.error('[webhook] Error emitting webhook:', err);
  }
}

interface DeliverArgs {
  orgId: string;
  event: string;
  url: string;
  payload: string;
  signature: string | null;
}

export async function deliverAndPersist(args: DeliverArgs): Promise<string> {
  const { orgId, event, url, payload, signature } = args;
  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let errorMessage: string | null = null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature ?? '',
        'X-Webhook-Event': event,
      },
      body: payload,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    responseStatus = res.status;
  } catch (err) {
    errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.warn(`[webhook] Failed to deliver ${event}: ${errorMessage}`);
  }

  const durationMs = Date.now() - startedAt;

  let deliveryId = '';
  try {
    const row = await prisma.webhookDelivery.create({
      data: {
        orgId,
        event,
        url,
        payload,
        signature,
        responseStatus,
        durationMs,
        errorMessage,
      },
      select: { id: true },
    });
    deliveryId = row.id;
    // Best-effort prune. Failure here must not break the caller.
    void pruneOldDeliveries(orgId).catch((err) => {
      logger.warn('[webhook] Prune failed:', err);
    });
  } catch (err) {
    logger.error('[webhook] Failed to persist delivery row:', err);
  }
  return deliveryId;
}

async function pruneOldDeliveries(orgId: string): Promise<void> {
  const total = await prisma.webhookDelivery.count({ where: { orgId } });
  if (total <= MAX_DELIVERIES_PER_ORG) return;

  const excess = total - MAX_DELIVERIES_PER_ORG;
  const victims = await prisma.webhookDelivery.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    take: excess,
    select: { id: true },
  });
  await prisma.webhookDelivery.deleteMany({
    where: { id: { in: victims.map((v) => v.id) } },
  });
}
