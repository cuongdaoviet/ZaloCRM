/**
 * Duplicate contact REST routes — feature 0018.
 *
 * Endpoints:
 *   POST /api/v1/contacts/scan-duplicates       — owner/admin
 *   GET  /api/v1/duplicate-groups               — owner/admin
 *   GET  /api/v1/duplicate-groups/:id           — owner/admin
 *   POST /api/v1/duplicate-groups/:id/merge     — owner/admin
 *   POST /api/v1/duplicate-groups/:id/dismiss   — owner/admin
 *
 * Decisions (SPEC §Decisions):
 *  - D-0001 — On-demand scan. Sync ≤ 5000 contacts, otherwise fire-and-forget
 *             via setImmediate(). Track in-memory per-org via runningScans Map
 *             with a 60s debounce window (429 if same org rescans within 60s).
 *  - D-0002 — No undo endpoint. Merge is one-way; only mergedIntoId/mergedAt
 *             carries the audit trail.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { trackBackground } from '../../shared/utils/background-tasks.js';
import {
  scanDuplicates,
  dismissGroup,
  mergeContacts,
  ALL_LEVELS,
} from './duplicate-service.js';
import type { DuplicateLevel } from './duplicate-detection.js';

const SYNC_SCAN_CONTACT_THRESHOLD = 5000;
const SCAN_DEBOUNCE_MS = 60_000;

// In-memory scan debounce: orgId → timestamp when scan started.
// Used both to enforce 429 (already running) and the 60s flood window.
const runningScans = new Map<string, number>();

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const STATUS_VALUES = new Set(['pending', 'merged', 'dismissed', 'all']);

export async function duplicateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/v1/contacts/scan-duplicates ─────────────────────────────────
  app.post(
    '/api/v1/contacts/scan-duplicates',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const body = (request.body as Record<string, unknown>) ?? {};
      const requestedLevels = Array.isArray(body.levels) ? (body.levels as unknown[]) : null;
      let levels: DuplicateLevel[] = ALL_LEVELS;
      if (requestedLevels) {
        const valid = requestedLevels.filter((l) =>
          typeof l === 'string' && (ALL_LEVELS as string[]).includes(l),
        ) as DuplicateLevel[];
        if (valid.length === 0) {
          return reply.status(400).send({ error: 'levels không hợp lệ' });
        }
        levels = valid;
      }

      const orgId = user.orgId;
      const now = Date.now();
      const last = runningScans.get(orgId);
      if (last && now - last < SCAN_DEBOUNCE_MS) {
        return reply.status(429).send({
          error: 'Đang quét — vui lòng đợi 60s rồi thử lại',
        });
      }

      // Decide sync vs. async based on population size
      const contactCount = await prisma.contact.count({
        where: { orgId, mergedIntoId: null },
      });

      if (contactCount > SYNC_SCAN_CONTACT_THRESHOLD) {
        const jobId = randomUUID();
        runningScans.set(orgId, now);
        // Fire and forget; trackBackground so test teardown waits for the write.
        trackBackground(
          (async () => {
            try {
              await scanDuplicates(orgId, levels);
            } catch (err) {
              logger.error('[duplicate-scan] async scan failed:', err);
            } finally {
              runningScans.delete(orgId);
            }
          })(),
        );
        return reply.status(202).send({
          status: 'queued',
          jobId,
          estimatedSeconds: Math.ceil(contactCount / 2000),
        });
      }

      runningScans.set(orgId, now);
      try {
        const result = await scanDuplicates(orgId, levels);
        return result;
      } catch (err) {
        logger.error('[duplicate-scan] sync scan failed:', err);
        return reply.status(500).send({ error: 'Quét thất bại' });
      } finally {
        // Keep the entry briefly so a flood within 60s still 429s; the scan
        // itself only takes ~1s so leaving the timestamp is fine.
        setTimeout(() => runningScans.delete(orgId), SCAN_DEBOUNCE_MS).unref?.();
      }
    },
  );

  // ── GET /api/v1/duplicate-groups ──────────────────────────────────────────
  app.get(
    '/api/v1/duplicate-groups',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;
      const statusParam = q.status ?? 'pending';
      if (!STATUS_VALUES.has(statusParam)) {
        return reply.status(400).send({ error: 'status không hợp lệ' });
      }
      const levelParam = q.level;
      if (levelParam && !(ALL_LEVELS as string[]).includes(levelParam)) {
        return reply.status(400).send({ error: 'level không hợp lệ' });
      }
      const page = Math.max(1, Number(q.page) || 1);
      const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(q.limit) || LIST_LIMIT_DEFAULT));

      const where: Record<string, unknown> = { orgId: user.orgId };
      if (statusParam !== 'all') where.status = statusParam;
      if (levelParam) where.level = levelParam;

      const [rows, total] = await Promise.all([
        prisma.duplicateGroup.findMany({
          where: where as never,
          orderBy: { detectedAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.duplicateGroup.count({ where: where as never }),
      ]);

      // Build a preview (≤ 2 contacts per group) using a single bulk fetch
      // across all group ids. Skip preview contacts that were merged after
      // detection (EC-0001).
      const allContactIds = new Set<string>();
      for (const r of rows) {
        for (const id of (r.contactIds as string[]) ?? []) allContactIds.add(id);
      }
      const contacts = await prisma.contact.findMany({
        where: { id: { in: Array.from(allContactIds) }, orgId: user.orgId },
        select: { id: true, fullName: true, phone: true, mergedIntoId: true },
      });
      const contactById = new Map(contacts.map((c) => [c.id, c]));

      const groups = rows.map((r) => {
        const ids = (r.contactIds as string[]) ?? [];
        const live = ids
          .map((id) => contactById.get(id))
          .filter((c): c is { id: string; fullName: string | null; phone: string | null; mergedIntoId: string | null } => !!c && c.mergedIntoId == null);
        return {
          id: r.id,
          level: r.level,
          confidence: r.confidence,
          status: r.status,
          contactCount: ids.length,
          contactsPreview: live.slice(0, 2).map((c) => ({
            id: c.id,
            fullName: c.fullName,
            phone: c.phone,
          })),
          detectedAt: r.detectedAt,
          resolvedAt: r.resolvedAt,
          primaryContactId: r.primaryContactId,
        };
      });

      return { groups, total, page, limit };
    },
  );

  // ── GET /api/v1/duplicate-groups/:id ──────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/duplicate-groups/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      const group = await prisma.duplicateGroup.findFirst({
        where: { id, orgId: user.orgId },
      });
      if (!group) return reply.status(404).send({ error: 'Không tồn tại' });

      const contactIds = (group.contactIds as string[]) ?? [];
      const contacts = await prisma.contact.findMany({
        where: { id: { in: contactIds }, orgId: user.orgId },
        include: {
          assignedUser: { select: { id: true, fullName: true } },
        },
      });

      // Per-contact counts (conversations / orders / appointments / notes-via-conv)
      const [convCounts, orderCounts, apptCounts, noteCountsByConv] = await Promise.all([
        prisma.conversation.groupBy({
          by: ['contactId'],
          where: { contactId: { in: contactIds }, orgId: user.orgId },
          _count: { _all: true },
        }),
        prisma.order.groupBy({
          by: ['contactId'],
          where: { contactId: { in: contactIds }, orgId: user.orgId },
          _count: { _all: true },
        }),
        prisma.appointment.groupBy({
          by: ['contactId'],
          where: { contactId: { in: contactIds }, orgId: user.orgId },
          _count: { _all: true },
        }),
        prisma.conversation.findMany({
          where: { contactId: { in: contactIds }, orgId: user.orgId },
          select: { id: true, contactId: true, _count: { select: { notes: true } } },
        }),
      ]);
      const convByContact = new Map<string, number>(convCounts.map((r) => [r.contactId ?? '', r._count._all]));
      const ordByContact = new Map<string, number>(orderCounts.map((r) => [r.contactId, r._count._all]));
      const apptByContact = new Map<string, number>(apptCounts.map((r) => [r.contactId, r._count._all]));
      const notesByContact = new Map<string, number>();
      for (const c of noteCountsByConv) {
        if (!c.contactId) continue;
        notesByContact.set(c.contactId, (notesByContact.get(c.contactId) ?? 0) + c._count.notes);
      }

      // EC-0001: filter contacts already merged in a different group.
      const live = contacts.filter((c) => c.mergedIntoId == null);

      const resolvedBy = group.resolvedByUserId
        ? await prisma.user.findUnique({
            where: { id: group.resolvedByUserId },
            select: { id: true, fullName: true },
          })
        : null;

      // EC-0001: auto-dismiss if ≤ 1 live contact remains in a pending group.
      let effectiveStatus = group.status;
      let effectiveResolvedAt = group.resolvedAt;
      if (group.status === 'pending' && live.length <= 1) {
        await prisma.duplicateGroup
          .updateMany({
            where: { id: group.id, status: 'pending' },
            data: { status: 'dismissed', resolvedAt: new Date() },
          })
          .catch((err) => logger.warn('[duplicate-groups] auto-dismiss failed:', err));
        effectiveStatus = 'dismissed';
        effectiveResolvedAt = new Date();
      }

      return {
        id: group.id,
        level: group.level,
        confidence: group.confidence,
        status: effectiveStatus,
        contacts: live.map((c) => ({
          id: c.id,
          fullName: c.fullName,
          phone: c.phone,
          email: c.email,
          source: c.source,
          status: c.status,
          tags: c.tags,
          createdAt: c.createdAt,
          assignedUser: c.assignedUser,
          stats: {
            conversations: convByContact.get(c.id) ?? 0,
            orders: ordByContact.get(c.id) ?? 0,
            appointments: apptByContact.get(c.id) ?? 0,
            notes: notesByContact.get(c.id) ?? 0,
          },
        })),
        detectedAt: group.detectedAt,
        resolvedAt: effectiveResolvedAt,
        resolvedBy,
        primaryContactId: group.primaryContactId,
      };
    },
  );

  // ── POST /api/v1/duplicate-groups/:id/merge ───────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/duplicate-groups/:id/merge',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;
      const body = (request.body as Record<string, unknown>) ?? {};
      const primaryContactId = body.primaryContactId as string | undefined;
      const fieldsToKeep = body.fieldsToKeep as
        | Record<string, string>
        | undefined;

      if (!primaryContactId || typeof primaryContactId !== 'string') {
        return reply.status(400).send({ error: 'primaryContactId là bắt buộc' });
      }

      const result = await mergeContacts(
        user.orgId,
        id,
        primaryContactId,
        { fieldsToKeep },
        user.id,
      );
      if ('status' in result) {
        return result;
      }
      if (result.error === 'not_found') {
        return reply.status(404).send({ error: 'Không tồn tại' });
      }
      if (result.error === 'conflict') {
        return reply.status(409).send({ error: 'Nhóm đang được xử lý song song' });
      }
      return reply.status(400).send({ error: result.message });
    },
  );

  // ── POST /api/v1/duplicate-groups/:id/dismiss ─────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/duplicate-groups/:id/dismiss',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;
      const body = (request.body as Record<string, unknown>) ?? {};
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      if (reason && reason.length > 500) {
        return reply.status(400).send({ error: 'Lý do quá dài (≤ 500 ký tự)' });
      }
      const result = await dismissGroup(user.orgId, id, user.id, reason);
      if ('status' in result) return result;
      if (result.error === 'not_found') {
        return reply.status(404).send({ error: 'Không tồn tại' });
      }
      return reply.status(400).send({ error: 'Nhóm đã được xử lý' });
    },
  );
}
