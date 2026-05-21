/**
 * zalo-sticker-routes.ts — Feature 0028.
 *
 * Proxies zca-js sticker calls so the frontend never has to hit Zalo CDN
 * APIs directly (CORS-safe). Two endpoints:
 *
 *   GET /api/v1/zalo/stickers/:stickerId?catId=X&accountId=Y
 *     - Looks up sticker URL via `api.getStickersDetail([stickerId])`.
 *     - Cached in-process for 24h (BR-0008). Hit/miss is asserted via
 *       a `__resetStickerCache` test hook.
 *
 *   GET /api/v1/zalo/sticker-catalogues?accountId=X
 *     - Phase 1: returns a hardcoded catalogue with ~20 sample stickers
 *       (BR-0009). Phase 2 will hit the real Zalo catalogue API.
 *
 * ACL: both endpoints require `requireZaloAccess('chat')`. Because the
 * Zalo account id is in the query string (not params), we resolve the
 * permission check manually rather than reusing the middleware factory.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { zaloPool } from './zalo-pool.js';
import { logger } from '../../shared/utils/logger.js';

// ── Cache ────────────────────────────────────────────────────────────────────

export interface StickerCacheEntry {
  stickerId: number;
  catId: number;
  type: number;
  cdnUrl: string;
  animationType: 'static' | 'animated';
  cachedAt: number;
}

const STICKER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const stickerCache = new Map<number, StickerCacheEntry>();

/**
 * Test-only helper. Reset the in-process cache between test cases so the
 * call-once assertion in AC-0006 is deterministic.
 */
export function __resetStickerCache(): void {
  stickerCache.clear();
}

/**
 * Look up a sticker's CDN URL via zca-js. Returns null on failure so the
 * caller (POST /stickers in chat-routes) can persist the message without
 * the URL — the FE will then hit the proxy endpoint as a fallback.
 *
 * Exposed so chat-routes can re-use the cache when persisting outbound
 * stickers (BR-0007).
 */
export async function lookupStickerCdnUrl(
  api: any,
  stickerId: number,
): Promise<string | null> {
  const entry = await fetchStickerDetail(api, stickerId);
  return entry?.cdnUrl ?? null;
}

async function fetchStickerDetail(
  api: any,
  stickerId: number,
): Promise<StickerCacheEntry | null> {
  const cached = stickerCache.get(stickerId);
  if (cached && Date.now() - cached.cachedAt < STICKER_CACHE_TTL_MS) {
    return cached;
  }

  if (typeof api?.getStickersDetail !== 'function') return null;

  let detail: any;
  try {
    detail = await api.getStickersDetail([stickerId]);
  } catch (err) {
    logger.warn(`[stickers] getStickersDetail(${stickerId}) failed:`, err);
    return null;
  }

  // zca-js returns StickerDetail[] but tests may return a single object
  // for simplicity. Accept both shapes.
  const item = Array.isArray(detail) ? detail[0] : detail;
  if (!item) return null;

  const cdnUrl: string =
    item.stickerWebpUrl || item.stickerUrl || item.stickerSpriteUrl || '';
  if (!cdnUrl) return null;

  const entry: StickerCacheEntry = {
    stickerId,
    catId: Number(item.cateId ?? item.catId ?? 0),
    type: Number(item.type ?? 0),
    cdnUrl,
    animationType: (item.totalFrames ?? 0) > 1 ? 'animated' : 'static',
    cachedAt: Date.now(),
  };
  stickerCache.set(stickerId, entry);
  return entry;
}

// ── Phase 1 hardcoded catalogue (BR-0009) ────────────────────────────────────
// 20 sample stickers from Zalo's default "Tiếng cười" pack. We only need
// stable {id, catId, type} triplets to send via sendSticker — the FE will
// resolve the actual CDN URL through the GET stickers endpoint at runtime.
// IDs are sourced from the public Zalo sticker library and are stable.

const DEFAULT_CATALOGUE_ID = 1;
const DEFAULT_CATALOGUE_NAME = 'Default';

const DEFAULT_STICKER_IDS: number[] = [
  4179, 4180, 4181, 4182, 4183, 4184, 4185, 4186, 4187, 4188, 4189, 4190,
  4191, 4192, 4193, 4194, 4195, 4196, 4197, 4198,
];

export interface CatalogueSticker {
  stickerId: number;
  catId: number;
  type: number;
}

export interface Catalogue {
  id: number;
  name: string;
  stickers: CatalogueSticker[];
}

function buildDefaultCatalogue(): Catalogue {
  return {
    id: DEFAULT_CATALOGUE_ID,
    name: DEFAULT_CATALOGUE_NAME,
    stickers: DEFAULT_STICKER_IDS.map((stickerId) => ({
      stickerId,
      catId: DEFAULT_CATALOGUE_ID,
      type: 1,
    })),
  };
}

// ── ACL helper ───────────────────────────────────────────────────────────────

/**
 * Resolve `accountId` from the query string and verify the caller has
 * 'chat' permission on it. Mirrors `requireZaloAccess('chat')` but for the
 * query-param shape used by the proxy routes.
 */
async function ensureChatAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ accountId: string } | null> {
  const user = request.user!;
  const { accountId } = (request.query ?? {}) as { accountId?: string };
  if (!accountId) {
    reply.status(400).send({ error: 'accountId là bắt buộc', code: 'missing_account' });
    return null;
  }

  // Owner/admin bypass — same semantics as the middleware factory.
  if (['owner', 'admin'].includes(user.role)) {
    const account = await prisma.zaloAccount.findFirst({
      where: { id: accountId, orgId: user.orgId },
      select: { id: true },
    });
    if (!account) {
      reply.status(404).send({ error: 'Tài khoản Zalo không tồn tại' });
      return null;
    }
    return { accountId };
  }

  const access = await prisma.zaloAccountAccess.findFirst({
    where: { zaloAccountId: accountId, userId: user.id },
    select: { permission: true },
  });
  if (!access || (access.permission !== 'chat' && access.permission !== 'admin')) {
    reply.status(403).send({ error: 'Không có quyền truy cập tài khoản Zalo này' });
    return null;
  }
  return { accountId };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function zaloStickerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/zalo/stickers/:stickerId?catId=X&accountId=Y
  app.get('/api/v1/zalo/stickers/:stickerId', async (request, reply) => {
    const { stickerId: stickerIdRaw } = request.params as { stickerId: string };
    const { catId: catIdRaw } = (request.query ?? {}) as { catId?: string };
    const stickerId = Number(stickerIdRaw);
    if (!Number.isFinite(stickerId)) {
      return reply.status(400).send({ error: 'stickerId không hợp lệ' });
    }

    const acl = await ensureChatAccess(request, reply);
    if (!acl) return;

    const instance = zaloPool.getInstance(acl.accountId);
    if (!instance?.api) {
      return reply
        .status(503)
        .send({ error: 'Tài khoản Zalo chưa kết nối', code: 'account_offline' });
    }

    const entry = await fetchStickerDetail(instance.api, stickerId);
    if (!entry) {
      return reply
        .status(502)
        .send({ error: 'Không lấy được sticker', code: 'sticker_lookup_failed' });
    }

    const catId = catIdRaw !== undefined ? Number(catIdRaw) : entry.catId;
    return {
      stickerId: entry.stickerId,
      catId: Number.isFinite(catId) ? catId : entry.catId,
      type: entry.type,
      cdnUrl: entry.cdnUrl,
      animationType: entry.animationType,
    };
  });

  // GET /api/v1/zalo/sticker-catalogues?accountId=X
  app.get('/api/v1/zalo/sticker-catalogues', async (request, reply) => {
    const acl = await ensureChatAccess(request, reply);
    if (!acl) return;
    return { catalogues: [buildDefaultCatalogue()] };
  });
}
