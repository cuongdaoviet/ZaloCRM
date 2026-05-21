/**
 * Main application entry point.
 * Bootstraps Fastify server with all plugins, Socket.IO, and route handlers.
 * The process never exits — all errors are caught and logged.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma } from '@prisma/client';
import { config } from './config/index.js';
import { prisma } from './shared/database/prisma-client.js';
import { ensureBucket } from './shared/storage/minio-client.js';
import { logger } from './shared/utils/logger.js';
import { authRoutes } from './modules/auth/auth-routes.js';
import { zaloRoutes } from './modules/zalo/zalo-routes.js';
import { zaloUserRoutes } from './modules/zalo/zalo-user-routes.js';
import { chatRoutes } from './modules/chat/chat-routes.js';
import { contactRoutes } from './modules/contacts/contact-routes.js';
import { crmTagRoutes } from './modules/crm-tags/crm-tag-routes.js';
import { zaloLabelSyncRoutes } from './modules/crm-tags/zalo-label-sync-routes.js';
import { contactSubResourceRoutes } from './modules/contacts/contact-sub-resource-routes.js';
import { contactOverviewRoutes } from './modules/contacts/contact-overview-routes.js';
import { duplicateRoutes } from './modules/contacts/duplicate-routes.js';
import { appointmentRoutes } from './modules/contacts/appointment-routes.js';
import { appointmentParseRoutes } from './modules/contacts/appointment-parse-routes.js';
import { startAppointmentReminder } from './modules/contacts/appointment-reminder.js';
import { dashboardRoutes } from './modules/dashboard/dashboard-routes.js';
import { reportRoutes } from './modules/dashboard/report-routes.js';
import { userRoutes } from './modules/auth/user-routes.js';
import { userPreferenceRoutes } from './modules/auth/user-preference-routes.js';
import { teamRoutes } from './modules/auth/team-routes.js';
import { orgRoutes } from './modules/auth/org-routes.js';
import { zaloAccessRoutes } from './modules/zalo/zalo-access-routes.js';
import { zaloSyncRoutes } from './modules/zalo/zalo-sync-routes.js';
import { zaloPool } from './modules/zalo/zalo-pool.js';
import { registerZaloSocketHandlers } from './modules/zalo/zalo-socket.js';
import { notificationRoutes } from './modules/notifications/notification-routes.js';
import { searchRoutes } from './modules/search/search-routes.js';
import { startZaloHealthCheck } from './modules/zalo/zalo-health-check.js';
import { publicApiRoutes } from './modules/api/public-api-routes.js';
import { webhookSettingsRoutes } from './modules/api/webhook-settings-routes.js';
import { webhookDebugRoutes } from './modules/api/webhook-debug-routes.js';
import { orderRoutes } from './modules/orders/order-routes.js';
import { quickReplyRoutes } from './modules/quick-replies/quick-reply-routes.js';
import { autoReplyRoutes } from './modules/auto-reply/auto-reply-routes.js';
import { kpiRoutes } from './modules/kpi/kpi-routes.js';
import { analyticsRoutes } from './modules/analytics/analytics-routes.js';
import { campaignRoutes } from './modules/campaigns/campaign-routes.js';
import { startCampaignWorker } from './modules/campaigns/campaign-worker.js';
import { friendshipRoutes } from './modules/friendship/friendship-routes.js';
import { startFriendshipWorker } from './modules/friendship/friendship-worker.js';
import { keywordRuleRoutes } from './modules/keyword-rules/keyword-rule-routes.js';
import { conversationNoteRoutes } from './modules/conversation-notes/conversation-note-routes.js';
import { pinConversationRoutes } from './modules/conversations/pin-routes.js';
import { activityRoutes } from './modules/activity/activity-routes.js';
import { reactionRoutes } from './modules/reactions/reaction-routes.js';
// Feature 0037 — Workflow automation engine
import { workflowDefinitionRoutes } from './modules/workflow/definition-routes.js';
import { workflowExecutionRoutes } from './modules/workflow/execution-routes.js';
import { startWorkflowRunner } from './workers/workflow-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bootstrap() {
  const app = Fastify({ logger: false });

  // ── Plugins ──────────────────────────────────────────────────────────────

  await app.register(cors, {
    origin: config.isProduction ? config.appUrl : true,
    credentials: true,
  });

  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
  });

  // Multipart for file uploads (chat attachments — feature 0003)
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20 MB per file (Zalo client limit)
      files: 1,
    },
  });

  // Rate limiting with higher limits and per-key tracking
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
    // Use different limits for different clients
    keyGenerator: (request) => {
      // Use API key for authenticated requests
      const apiKey = request.headers['x-api-key'] as string;
      if (apiKey) {
        return `api:${apiKey}`;
      }
      // Use IP for other requests
      return request.ip;
    },
  });

  // Serve compiled frontend assets in production
  if (config.isProduction) {
    await app.register(fastifyStatic, {
      root: path.join(__dirname, '../static'),
      prefix: '/',
    });
  }

  // ── Socket.IO ─────────────────────────────────────────────────────────────

  const io = new Server(app.server, {
    cors: {
      origin: config.isProduction ? config.appUrl : '*',
      credentials: true,
    },
  });

  // Attach io to app so route handlers can emit events
  app.decorate('io', io);

  // Pass io to zalo pool for real-time event emission
  zaloPool.setIO(io);

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);
    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
    });
  });

  // Register Zalo Socket.IO event handlers
  registerZaloSocketHandlers(io);

  // ── Routes ────────────────────────────────────────────────────────────────

  await app.register(authRoutes);
  await app.register(zaloRoutes);
  await app.register(zaloUserRoutes);
  await app.register(chatRoutes);
  await app.register(contactRoutes);
  await app.register(crmTagRoutes);
  await app.register(zaloLabelSyncRoutes);
  await app.register(contactSubResourceRoutes);
  await app.register(contactOverviewRoutes);
  await app.register(duplicateRoutes);
  await app.register(appointmentRoutes);
  await app.register(appointmentParseRoutes);
  await app.register(dashboardRoutes);
  await app.register(reportRoutes);
  await app.register(userRoutes);
  await app.register(userPreferenceRoutes);
  await app.register(teamRoutes);
  await app.register(orgRoutes);
  await app.register(zaloAccessRoutes);
  await app.register(zaloSyncRoutes);
  await app.register(notificationRoutes);
  await app.register(searchRoutes);
  await app.register(publicApiRoutes);
  await app.register(webhookSettingsRoutes);
  await app.register(webhookDebugRoutes);
  await app.register(orderRoutes);
  await app.register(quickReplyRoutes);
  await app.register(autoReplyRoutes);
  await app.register(kpiRoutes);
  await app.register(analyticsRoutes);
  await app.register(campaignRoutes);
  await app.register(friendshipRoutes);
  await app.register(keywordRuleRoutes);
  await app.register(conversationNoteRoutes);
  await app.register(pinConversationRoutes);
  await app.register(activityRoutes);
  await app.register(reactionRoutes);
  await app.register(workflowDefinitionRoutes);
  await app.register(workflowExecutionRoutes);

  // Liveness/readiness probe — also checks DB connectivity
  app.get('/health', async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'connected', timestamp: new Date().toISOString() };
    } catch {
      return { status: 'error', db: 'disconnected', timestamp: new Date().toISOString() };
    }
  });

  // API version banner
  app.get('/api/v1/status', async () => {
    return { version: '1.0.0', name: 'Zalo CRM' };
  });

  // SPA fallback — serve index.html for non-API routes in production
  if (config.isProduction) {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // ── Error handler ─────────────────────────────────────────────────────────

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    logger.error('Request error:', error.message);
    reply.status(error.statusCode ?? 500).send({
      error: error.message || 'Internal Server Error',
    });
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  // Feature 0027 — verify MinIO is reachable and the attachments bucket
  // exists BEFORE we accept any requests. If MinIO is down, crashing on
  // startup is preferable to silently accepting uploads that vanish.
  // EC-0001: this is the gate that turns "uploads vanish" into "deploy fails".
  try {
    await ensureBucket();
    logger.info(`[minio] bucket ${config.s3Bucket} ready`);
  } catch (err) {
    logger.error('[minio] ensureBucket failed — refusing to start:', err);
    process.exit(1);
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`Zalo CRM running on http://${config.host}:${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    startAppointmentReminder(io);
    startZaloHealthCheck();
    startCampaignWorker(io);
    startFriendshipWorker(io);
    startWorkflowRunner();
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }

  // Reconnect Zalo accounts that have saved sessions (staggered to avoid rate limits)
  try {
    const accounts = await prisma.zaloAccount.findMany({
      where: { sessionData: { not: Prisma.JsonNull } },
      select: { id: true, sessionData: true },
    });
    logger.info(`Attempting reconnect for ${accounts.length} Zalo account(s)`);
    for (const account of accounts) {
      const session = account.sessionData as {
        cookie: any;
        imei: string;
        userAgent: string;
      } | null;
      if (session?.imei) {
        // Stagger reconnects: 10 seconds between each account to avoid rate limits
        await new Promise((r) => setTimeout(r, 10_000));
        zaloPool.reconnect(account.id, session).catch((err) => {
          logger.warn(`Auto-reconnect failed for account ${account.id}:`, err);
        });
      }
    }
  } catch (err) {
    logger.error('Failed to load accounts for reconnect:', err);
  }
}

// Keep process alive — log but never crash on unhandled errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

bootstrap();
