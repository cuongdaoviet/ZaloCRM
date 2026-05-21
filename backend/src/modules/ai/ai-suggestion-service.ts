/**
 * AI suggestion orchestration — Feature 0036.
 *
 * Pipeline:
 *   1. Load AiConfig (enabled? key set?) + last 40 messages (chronological).
 *   2. Validate trigger window (BR-0003 — inbound within 24h, last is contact).
 *   3. Cache lookup by (conversationId + lastMessageId). 5min TTL (BR-0005).
 *   4. Quota check inside a transaction (TOCTOU-safe — port from 3.0's
 *      ai-service.ts:151-154; SPEC §9 — verbatim pattern).
 *   5. Per-user hourly soft cap (BR-0016, deviation from 3.0).
 *   6. Decrypt API key, dispatch to adapter.
 *   7. Parse 3 suggestions from response. Insert AiSuggestionLog row WITHOUT
 *      suggestion content (BR-0014).
 *   8. Cache result; return.
 *
 * Errors map to typed sentinel strings; routes translate to HTTP codes.
 *
 * IMPORTANT: nothing in this module ever logs the plaintext API key or the
 * raw suggestion content. The `safeContext` helper builds the only log payload
 * we emit on success / failure.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { decryptForOrg, maskApiKey } from '../../shared/crypto/encrypt-config.js';
import { getProviderById, isKnownProvider } from './provider-registry.js';
import {
  buildReplyDraftSystemPrompt,
  buildReplyDraftUserPrompt,
  parseSuggestions,
  type TranscriptMessage,
} from './prompts/reply-draft.js';

// ── Constants ───────────────────────────────────────────────────────────────

/** BR-0005 cache TTL. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** BR-0003 — only show suggestions if last inbound message is within 24h. */
const INBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** BR-0016 — per-user soft cap. */
const PER_USER_HOURLY_CAP = 100;

// ── Error sentinels ─────────────────────────────────────────────────────────

export type AiErrorCode =
  | 'ai_disabled'
  | 'no_context'
  | 'rate_limit_org'
  | 'rate_limit_user'
  | 'provider_unconfigured'
  | 'provider_401'
  | 'provider_5xx'
  | 'provider_timeout'
  | 'provider_other'
  | 'no_inbound'
  | 'unknown_provider';

export class AiServiceError extends Error {
  constructor(public code: AiErrorCode, message: string, public retryAfterSec?: number) {
    super(message);
    this.name = 'AiServiceError';
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  suggestions: string[];
  cachedAt: number;
  cachedUntil: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(conversationId: string, lastMessageId: string): string {
  return `${conversationId}:${lastMessageId}`;
}

/** Test-visible cache clear — never used in production. */
export function clearSuggestionCache(): void {
  cache.clear();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeContext(extra: Record<string, unknown>): Record<string, unknown> {
  // Drop anything that looks like a key. Defense in depth — callers never
  // pass these in, but it's cheap to be explicit.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (/key|secret|cipher|token/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function isoStartOfDayUtc(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function hourAgo(now = new Date()): Date {
  return new Date(now.getTime() - 60 * 60 * 1000);
}

// ── Main entry point ─────────────────────────────────────────────────────────

export interface SuggestionRequest {
  orgId: string;
  userId: string;
  conversationId: string;
  /** Optional override — primarily for testing. */
  now?: Date;
  /** Optional prisma client override — for tests. */
  prismaClient?: PrismaClient;
}

export interface SuggestionResponse {
  suggestions: string[];
  fromCache: boolean;
  cachedUntil: string; // ISO
  provider: string;
  model: string;
}

export async function generateSuggestions(
  req: SuggestionRequest,
): Promise<SuggestionResponse> {
  const db = (req.prismaClient ?? prisma) as PrismaClient;
  const now = req.now ?? new Date();

  // ── 1. Load AiConfig + conversation context ────────────────────────────
  const aiConfig = await db.aiConfig.findUnique({ where: { orgId: req.orgId } });
  if (!aiConfig || !aiConfig.enabled) {
    throw new AiServiceError('ai_disabled', 'AI suggestions are disabled for this organization');
  }
  if (!isKnownProvider(aiConfig.provider)) {
    throw new AiServiceError('unknown_provider', `Unknown provider: ${aiConfig.provider}`);
  }
  const providerDef = getProviderById(aiConfig.provider)!;
  if (providerDef.requiresApiKey && !aiConfig.apiKeyCipher) {
    throw new AiServiceError('provider_unconfigured', 'Provider API key not configured');
  }

  const conversation = await db.conversation.findFirst({
    where: { id: req.conversationId, orgId: req.orgId },
    include: {
      contact: { select: { fullName: true } },
      messages: {
        where: { isDeleted: false },
        orderBy: { sentAt: 'desc' },
        take: 40,
        select: {
          id: true,
          senderType: true,
          senderName: true,
          content: true,
          sentAt: true,
        },
      },
    },
  });
  if (!conversation) {
    throw new AiServiceError('no_context', 'Conversation not found');
  }
  const ordered = [...conversation.messages].reverse();
  if (ordered.length === 0) {
    throw new AiServiceError('no_context', 'Conversation has no messages');
  }
  const lastMessage = ordered[ordered.length - 1];
  if (lastMessage.senderType !== 'contact') {
    throw new AiServiceError('no_inbound', 'Last message must be from the contact');
  }
  if (now.getTime() - lastMessage.sentAt.getTime() > INBOUND_WINDOW_MS) {
    throw new AiServiceError('no_inbound', 'Last inbound message is older than 24h');
  }

  // ── 2. Cache lookup ─────────────────────────────────────────────────────
  const key = cacheKey(req.conversationId, lastMessage.id);
  const hit = cache.get(key);
  if (hit && hit.cachedUntil > now.getTime()) {
    logger.info(
      '[ai-suggest] cache hit',
      safeContext({ orgId: req.orgId, conversationId: req.conversationId }),
    );
    return {
      suggestions: hit.suggestions,
      fromCache: true,
      cachedUntil: new Date(hit.cachedUntil).toISOString(),
      provider: aiConfig.provider,
      model: aiConfig.model,
    };
  }

  // ── 3. Quota checks (org daily + user hourly) ──────────────────────────
  // SPEC §9.d — transactional TOCTOU-safe daily quota check.
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const startOfDay = isoStartOfDayUtc(now);
    const orgUsed = await tx.aiSuggestionLog.count({
      where: { orgId: req.orgId, createdAt: { gte: startOfDay } },
    });
    if (orgUsed >= aiConfig.maxSuggestionsPerDay) {
      const nextDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
      const retryAfterSec = Math.max(1, Math.ceil((nextDay.getTime() - now.getTime()) / 1000));
      throw new AiServiceError('rate_limit_org', 'Org daily quota exceeded', retryAfterSec);
    }
    const userUsed = await tx.aiSuggestionLog.count({
      where: { userId: req.userId, createdAt: { gte: hourAgo(now) } },
    });
    if (userUsed >= PER_USER_HOURLY_CAP) {
      throw new AiServiceError('rate_limit_user', 'User hourly quota exceeded', 60 * 60);
    }
  });

  // ── 4. Decrypt API key (never logged) ───────────────────────────────────
  let apiKey = '';
  if (providerDef.requiresApiKey) {
    try {
      apiKey = decryptForOrg(req.orgId, {
        cipher: aiConfig.apiKeyCipher,
        iv: aiConfig.apiKeyIv,
        tag: aiConfig.apiKeyTag,
      });
    } catch (err) {
      logger.error(
        '[ai-suggest] decrypt failed',
        safeContext({ orgId: req.orgId, err: err instanceof Error ? err.message : 'err' }),
      );
      throw new AiServiceError('provider_unconfigured', 'Failed to decrypt API key');
    }
  }

  // ── 5. Build prompt + call provider ─────────────────────────────────────
  const customerName = conversation.contact?.fullName ?? 'customer';
  const transcript: TranscriptMessage[] = ordered.map((m) => ({
    senderType: m.senderType,
    senderName: m.senderName,
    content: m.content,
    sentAt: m.sentAt,
  }));
  const system = buildReplyDraftSystemPrompt(aiConfig.systemPrompt);
  const userPrompt = buildReplyDraftUserPrompt(transcript, customerName);

  const startedAt = now.getTime();
  let tokensIn = 0;
  let tokensOut = 0;
  let suggestions: string[] = [];
  let errorCode: AiErrorCode | null = null;

  try {
    const result = await providerDef.adapter.generate({
      apiKey,
      apiEndpoint: aiConfig.apiEndpoint ?? undefined,
      model: aiConfig.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: 800,
    });
    tokensIn = result.tokensIn;
    tokensOut = result.tokensOut;
    suggestions = parseSuggestions(result.text);
    // EC-0004 — if we couldn't parse anything, surface as provider_other.
    if (suggestions.length === 0) {
      throw new Error('Provider returned no parseable suggestions');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(msg)) errorCode = 'provider_timeout';
    else if (/\b401\b|unauthor/i.test(msg)) errorCode = 'provider_401';
    else if (/\b5\d{2}\b/.test(msg)) errorCode = 'provider_5xx';
    else if (/not reachable/i.test(msg)) errorCode = 'provider_5xx';
    else errorCode = 'provider_other';

    // EC-0003 — 401 auto-disables the config (so admin sees the banner) and
    // we never quietly burn through quota with a bad key.
    if (errorCode === 'provider_401') {
      try {
        await db.aiConfig.update({
          where: { orgId: req.orgId },
          data: { enabled: false },
        });
      } catch (updateErr) {
        logger.warn(
          '[ai-suggest] failed to auto-disable on 401',
          safeContext({ orgId: req.orgId, err: updateErr instanceof Error ? updateErr.message : 'err' }),
        );
      }
    }

    logger.warn(
      '[ai-suggest] provider error',
      safeContext({
        orgId: req.orgId,
        provider: aiConfig.provider,
        model: aiConfig.model,
        // mask the api key in logs as belt-and-suspenders; not the actual
        // key value anywhere because we throw before re-logging.
        apiKeyHint: apiKey ? maskApiKey(apiKey) : '(none)',
        errorCode,
      }),
    );

    // Log the failure row (BR-0014 — no content stored) before rethrowing.
    await db.aiSuggestionLog
      .create({
        data: {
          orgId: req.orgId,
          userId: req.userId,
          conversationId: req.conversationId,
          triggerMsgId: lastMessage.id,
          provider: aiConfig.provider,
          model: aiConfig.model,
          tokensIn,
          tokensOut,
          costEstimate: 0,
          latencyMs: Date.now() - startedAt,
          errorCode,
        },
      })
      .catch((logErr) => {
        logger.error(
          '[ai-suggest] failed to write error log',
          safeContext({ orgId: req.orgId, err: logErr instanceof Error ? logErr.message : 'err' }),
        );
      });

    throw new AiServiceError(errorCode, msg);
  }

  // ── 6. Success: write log + populate cache ─────────────────────────────
  const cost = providerDef.adapter.estimateCost(tokensIn, tokensOut, aiConfig.model);
  await db.aiSuggestionLog.create({
    data: {
      orgId: req.orgId,
      userId: req.userId,
      conversationId: req.conversationId,
      triggerMsgId: lastMessage.id,
      provider: aiConfig.provider,
      model: aiConfig.model,
      tokensIn,
      tokensOut,
      costEstimate: cost,
      latencyMs: Date.now() - startedAt,
      errorCode: null,
    },
  });

  const cachedUntilMs = now.getTime() + CACHE_TTL_MS;
  cache.set(key, {
    suggestions,
    cachedAt: now.getTime(),
    cachedUntil: cachedUntilMs,
  });

  logger.info(
    '[ai-suggest] generated',
    safeContext({
      orgId: req.orgId,
      userId: req.userId,
      conversationId: req.conversationId,
      provider: aiConfig.provider,
      model: aiConfig.model,
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - startedAt,
      count: suggestions.length,
    }),
  );

  return {
    suggestions,
    fromCache: false,
    cachedUntil: new Date(cachedUntilMs).toISOString(),
    provider: aiConfig.provider,
    model: aiConfig.model,
  };
}

// ── Usage aggregate ────────────────────────────────────────────────────────

export interface UsageAggregate {
  total: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  errorCount: number;
  topUsers: Array<{ userId: string; count: number }>;
  byProvider: Array<{ provider: string; count: number }>;
}

export async function getUsageAggregate(
  orgId: string,
  from?: Date,
  to?: Date,
  db: PrismaClient = prisma as PrismaClient,
): Promise<UsageAggregate> {
  const where = {
    orgId,
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };

  const rows = await db.aiSuggestionLog.findMany({
    where,
    select: {
      userId: true,
      provider: true,
      tokensIn: true,
      tokensOut: true,
      costEstimate: true,
      errorCode: true,
    },
  });

  const userCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCost = 0;
  let errorCount = 0;

  for (const row of rows) {
    userCounts.set(row.userId, (userCounts.get(row.userId) ?? 0) + 1);
    providerCounts.set(row.provider, (providerCounts.get(row.provider) ?? 0) + 1);
    totalTokensIn += row.tokensIn;
    totalTokensOut += row.tokensOut;
    totalCost += row.costEstimate;
    if (row.errorCode) errorCount += 1;
  }

  const topUsers = Array.from(userCounts.entries())
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const byProvider = Array.from(providerCounts.entries())
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total: rows.length,
    totalTokensIn,
    totalTokensOut,
    totalCost,
    errorCount,
    topUsers,
    byProvider,
  };
}
