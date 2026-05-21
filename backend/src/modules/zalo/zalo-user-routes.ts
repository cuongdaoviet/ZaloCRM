/**
 * zalo-user-routes.ts — Feature 0030: Zalo user info popup.
 *
 * GET /api/v1/zalo/users/:uid?accountId=X
 *
 * Fetches Zalo user info (displayName, avatar, gender, phone) via the
 * connected Zalo account's zca-js `api.getUserInfo(uid)`. Cross-references
 * the org's Contact table by `zaloUid` so the FE can show "Tạo Contact"
 * (when contactId is null) or "Xem trong CRM" (when contactId exists).
 *
 * Caching: in-module Map keyed by `${accountId}:${uid}`, 10 min TTL.
 * Permission: `requireZaloAccess('chat')` — same level as chat messages
 * because user-info IS Zalo data attached to a Zalo account.
 *
 * Degraded behavior:
 *   - Account offline → 200 with `online: false` + cached data or stub.
 *   - zca-js throws (privacy, network) → 200 with `displayName='Unknown'`
 *     and `online: true` so the FE still renders a popover (BR-EC-0001).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { zaloPool } from './zalo-pool.js';

/** Public response shape for the popover endpoint. */
export interface ZaloUserInfoResponse {
  uid: string;
  displayName: string;
  avatarUrl: string | null;
  gender: string | null;
  phone: string | null;
  contactId: string | null;
  /** False when the underlying Zalo account is not connected. */
  online: boolean;
  /** True when the payload came from the in-memory cache. */
  cached: boolean;
}

interface CacheEntry {
  data: Omit<ZaloUserInfoResponse, 'cached' | 'contactId'>;
  cachedAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/** Test helper — flush the in-memory cache. Not exported via barrel. */
export function clearZaloUserInfoCache(): void {
  cache.clear();
}

/**
 * Parse the zca-js `getUserInfo` response into a normalized stub.
 * `getUserInfo` returns `{ changed_profiles: { [uid]: profile, [uid_0]: profile } }`.
 */
function parseProfile(uid: string, raw: unknown): {
  displayName: string;
  avatarUrl: string | null;
  gender: string | null;
  phone: string | null;
} {
  const result = raw as { changed_profiles?: Record<string, Record<string, unknown>> } | null;
  const profiles = result?.changed_profiles ?? {};
  const profile = profiles[uid] ?? profiles[`${uid}_0`] ?? null;
  if (!profile) {
    return { displayName: 'Unknown', avatarUrl: null, gender: null, phone: null };
  }
  const displayName =
    (profile.zaloName as string | undefined) ||
    (profile.zalo_name as string | undefined) ||
    (profile.displayName as string | undefined) ||
    (profile.display_name as string | undefined) ||
    'Unknown';
  const avatarUrl = (profile.avatar as string | undefined) || null;
  const genderRaw = profile.gender;
  let gender: string | null = null;
  if (typeof genderRaw === 'string') gender = genderRaw;
  else if (genderRaw === 0) gender = 'male';
  else if (genderRaw === 1) gender = 'female';
  const phone = (profile.phoneNumber as string | undefined) || null;
  return { displayName, avatarUrl, gender, phone };
}

export async function zaloUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get(
    '/api/v1/zalo/users/:uid',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { uid } = request.params as { uid: string };
      const { accountId } = (request.query ?? {}) as { accountId?: string };

      // ── Input validation ────────────────────────────────────────────────
      if (!accountId) {
        return reply.status(400).send({ error: 'missing_account_id' });
      }
      if (!uid || !/^[0-9]+$/.test(uid)) {
        return reply.status(400).send({ error: 'invalid_uid' });
      }

      // ── Cross-org → 404 (no leak) ───────────────────────────────────────
      const account = await prisma.zaloAccount.findFirst({
        where: { id: accountId, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      // ── ACL — requireZaloAccess('chat') equivalent, inlined because the
      //     middleware reads accountId from `params.id` or
      //     `params.zaloAccountId`, not from the query string. ────────────
      if (!['owner', 'admin'].includes(user.role)) {
        const access = await prisma.zaloAccountAccess.findFirst({
          where: { zaloAccountId: accountId, userId: user.id },
          select: { permission: true },
        });
        if (!access) {
          return reply
            .status(403)
            .send({ error: 'Không có quyền truy cập tài khoản Zalo này' });
        }
        const level: Record<string, number> = { read: 1, chat: 2, admin: 3 };
        if ((level[access.permission] ?? 0) < level.chat) {
          return reply.status(403).send({ error: 'Không đủ quyền' });
        }
      }

      // ── Contact cross-reference (BR-0007) ───────────────────────────────
      const contact = await prisma.contact.findFirst({
        where: { zaloUid: uid, orgId: user.orgId },
        select: { id: true },
      });
      const contactId = contact?.id ?? null;

      // ── Cache lookup ────────────────────────────────────────────────────
      const cacheKey = `${accountId}:${uid}`;
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        const body: ZaloUserInfoResponse = {
          ...cached.data,
          contactId,
          cached: true,
        };
        return reply.send(body);
      }

      // ── Account pool lookup ─────────────────────────────────────────────
      const instance = zaloPool.getInstance(accountId);
      const api = instance?.status === 'connected' ? instance.api : null;

      if (!api) {
        // EC-0003 — account offline. Return cached if any, else stub.
        const stub: Omit<ZaloUserInfoResponse, 'cached' | 'contactId'> = {
          uid,
          displayName: 'Unknown',
          avatarUrl: null,
          gender: null,
          phone: null,
          online: false,
        };
        const body: ZaloUserInfoResponse = {
          ...(cached ? cached.data : stub),
          online: false,
          contactId,
          cached: !!cached,
        };
        return reply.send(body);
      }

      // ── Live fetch (mocked in tests) ────────────────────────────────────
      let parsed: ReturnType<typeof parseProfile>;
      try {
        const raw = await api.getUserInfo(uid);
        parsed = parseProfile(uid, raw);
      } catch {
        // EC-0001 — privacy / network. Degrade to stub but still 200.
        parsed = {
          displayName: 'Unknown',
          avatarUrl: null,
          gender: null,
          phone: null,
        };
      }

      const entry: CacheEntry = {
        data: { uid, ...parsed, online: true },
        cachedAt: Date.now(),
      };
      cache.set(cacheKey, entry);

      const body: ZaloUserInfoResponse = {
        ...entry.data,
        contactId,
        cached: false,
      };
      return reply.send(body);
    },
  );
}
