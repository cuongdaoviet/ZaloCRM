/**
 * contact-routes.ts — REST API for CRM contact management.
 * Supports list, detail, create, update, delete, pipeline view, and tag updates.
 * All routes require JWT auth and are scoped to user's org.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { logActivityAsync } from '../activity/activity-service.js';
import {
  setContactTags,
  legacyTagsByName,
} from '../crm-tags/crm-tag-service.js';
import {
  loadLeadScoreConfig,
  computeLeadScore,
  computeLeadScoresBatch,
  validateLeadScoreConfig,
  DEFAULT_LEAD_SCORE_CONFIG,
} from './lead-score-service.js';
import { requireRole } from '../auth/role-middleware.js';

type QueryParams = Record<string, string>;

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── GET /api/v1/contacts — list with filters and pagination ───────────────
  app.get('/api/v1/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const queryRaw = request.query as Record<string, string | string[] | undefined>;
      const {
        page = '1',
        limit = '50',
        search = '',
        source = '',
        status = '',
        assignedUserId = '',
      } = queryRaw as QueryParams;

      // Feature 0018: exclude contacts that have been merged into a primary.
      // List default omits them so the merged-secondary tombstones don't show
      // up in CRM tables / autocomplete.
      const where: any = { orgId: user.orgId, mergedIntoId: null };
      if (source) where.source = source;
      if (status) where.status = status;
      if (assignedUserId) where.assignedUserId = assignedUserId;
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }

      // Feature 0019 — filter by tagIds (OR semantics: any one of the tag ids matches).
      // Accepts a single string or an array; Fastify parses repeated `?tagIds=...`
      // params as an array, `?tagIds=A,B` as a string we split on comma.
      const tagIdsRaw = queryRaw.tagIds;
      let tagIds: string[] = [];
      if (Array.isArray(tagIdsRaw)) {
        tagIds = tagIdsRaw.filter((v): v is string => typeof v === 'string');
      } else if (typeof tagIdsRaw === 'string' && tagIdsRaw.length > 0) {
        tagIds = tagIdsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }
      if (tagIds.length > 0) {
        where.contactTags = { some: { tagId: { in: tagIds } } };
      }

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);

      // Feature 0040: optional ?sort=leadScore (default: updatedAt DESC).
      // Lead score sorting happens AFTER batch compute since the score
      // isn't persisted (BR-0009). For leadScore sort we widen the candidate
      // pool to org-wide-but-bounded (cap 1000 per page EC-0004) then sort
      // in-process. Other sorts use the existing DB orderBy.
      const sortParam = typeof queryRaw.sort === 'string' ? queryRaw.sort : '';
      const sortDir = queryRaw.order === 'asc' ? 'asc' : 'desc';
      const sortByLeadScore = sortParam === 'leadScore';

      const [contacts, total] = await Promise.all([
        prisma.contact.findMany({
          where,
          include: {
            assignedUser: { select: { id: true, fullName: true, email: true } },
            _count: { select: { conversations: true, appointments: true } },
          },
          orderBy: { updatedAt: 'desc' },
          // EC-0004: cap batch compute at 1000. If client asked for a wider
          // page the FE should paginate.
          skip: sortByLeadScore ? 0 : (pageNum - 1) * limitNum,
          take: sortByLeadScore ? Math.min(1000, Math.max(limitNum, pageNum * limitNum)) : limitNum,
        }),
        prisma.contact.count({ where }),
      ]);

      // Batch compute lead scores for the returned slice.
      const config = await loadLeadScoreConfig(user.orgId);
      const scoreMap = await computeLeadScoresBatch(
        contacts.map((c) => c.id),
        config,
      );
      let enriched = contacts.map((c) => {
        const r = scoreMap.get(c.id);
        return {
          ...c,
          leadScore: r?.score ?? 0,
          leadScoreBreakdown: r?.breakdown ?? {
            recency: 0,
            engagement: 0,
            status: 0,
            appointment: 0,
          },
        };
      });

      if (sortByLeadScore) {
        enriched.sort((a, b) =>
          sortDir === 'asc' ? a.leadScore - b.leadScore : b.leadScore - a.leadScore,
        );
        // Apply pagination AFTER sort-in-process.
        const start = (pageNum - 1) * limitNum;
        enriched = enriched.slice(start, start + limitNum);
      }

      return { contacts: enriched, total, page: pageNum, limit: limitNum };
    } catch (err) {
      logger.error('[contacts] List error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contacts' });
    }
  });

  // ── GET /api/v1/contacts/pipeline — kanban grouped by generic status ──────
  app.get('/api/v1/contacts/pipeline', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const orgId = user.orgId;

      const pipeline = await prisma.contact.groupBy({
        by: ['status'],
        where: { orgId, status: { not: null }, mergedIntoId: null },
        _count: true,
      });

      // Fetch contacts per status for kanban cards (limit 20 per column)
      const statuses = pipeline.map((g) => g.status ?? 'unknown');
      const contactsByStatus: Record<string, any[]> = {};

      await Promise.all(
        statuses.map(async (st) => {
          // Feature 0018: hide merged secondaries from pipeline columns.
          const where: any = { orgId, status: st ?? null, mergedIntoId: null };
          const contacts = await prisma.contact.findMany({
            where,
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
              avatarUrl: true,
              status: true,
              nextAppointment: true,
              assignedUser: { select: { id: true, fullName: true } },
            },
            orderBy: { updatedAt: 'desc' },
            take: 20,
          });
          contactsByStatus[st ?? 'unknown'] = contacts;
        }),
      );

      const result = pipeline.map((g) => ({
        status: g.status ?? 'unknown',
        count: g._count,
        contacts: contactsByStatus[g.status ?? 'unknown'] ?? [],
      }));

      return { pipeline: result };
    } catch (err) {
      logger.error('[contacts] Pipeline error:', err);
      return reply.status(500).send({ error: 'Failed to fetch pipeline' });
    }
  });

  // ── GET /api/v1/contacts/:id — detail with appointments + conversation count
  // Feature 0019 Phase C: junction table is the only source of truth for tags.
  // Returns a rich `tags: [{id, name, color, emoji}]` shape; the legacy
  // `tagNames` shim has been removed.
  // Archived tags are filtered out by default.
  app.get('/api/v1/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };

      const contact = await prisma.contact.findFirst({
        where: { id, orgId: user.orgId },
        include: {
          assignedUser: { select: { id: true, fullName: true, email: true } },
          appointments: { orderBy: { appointmentDate: 'desc' }, take: 10 },
          _count: { select: { conversations: true } },
          contactTags: {
            where: { tag: { archivedAt: null } },
            include: {
              tag: {
                select: { id: true, name: true, color: true, emoji: true },
              },
            },
            orderBy: { tag: { order: 'asc' } },
          },
        },
      });

      if (!contact) return reply.status(404).send({ error: 'Contact not found' });

      const enrichedTags = contact.contactTags.map((ct) => ({
        id: ct.tag.id,
        name: ct.tag.name,
        color: ct.tag.color,
        emoji: ct.tag.emoji,
      }));
      // Feature 0040: include leadScore + breakdown on detail (AC-0003).
      const leadConfig = await loadLeadScoreConfig(user.orgId);
      const leadResult = await computeLeadScore(contact.id, leadConfig);
      // Strip the heavy join out of the wire payload and replace `tags` with
      // the enriched shape.
      const { contactTags, ...rest } = contact;
      void contactTags;
      return {
        ...rest,
        tags: enrichedTags,
        leadScore: leadResult.score,
        leadScoreBreakdown: leadResult.breakdown,
      };
    } catch (err) {
      logger.error('[contacts] Detail error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contact' });
    }
  });

  // ── Feature 0040 — Lead score config endpoints ────────────────────────────
  // Defaults are exposed (AC-0007 paths assume `defaults` shape).
  //
  // GET /api/v1/settings/lead-score-config — read current org config (any auth
  //   user; settings UI is admin-gated on the FE, but reads are non-sensitive).
  // PUT /api/v1/settings/lead-score-config — admin/owner only (AC-0008).
  app.get(
    '/api/v1/settings/lead-score-config',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        const org = await prisma.organization.findUnique({
          where: { id: user.orgId },
          select: { leadScoreConfig: true },
        });
        const stored = (org?.leadScoreConfig ?? null) as unknown;
        // Hand back the resolved config (defaults if unset/corrupt) plus
        // the raw stored value so the FE can show "still on defaults" hint.
        const resolved = stored === null ? DEFAULT_LEAD_SCORE_CONFIG : (() => {
          const v = validateLeadScoreConfig(stored);
          return v.ok ? v.value : DEFAULT_LEAD_SCORE_CONFIG;
        })();
        return {
          config: resolved,
          isCustom: stored !== null,
          defaults: DEFAULT_LEAD_SCORE_CONFIG,
        };
      } catch (err) {
        logger.error('[lead-score] GET config error:', err);
        return reply.status(500).send({ error: 'Failed to fetch lead score config' });
      }
    },
  );

  app.put(
    '/api/v1/settings/lead-score-config',
    { preHandler: [requireRole('owner', 'admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        const body = request.body as unknown;
        const result = validateLeadScoreConfig(body);
        if (!result.ok) {
          return reply.status(400).send({ error: result.error });
        }
        // Persist the validated/normalised config — sorted buckets, trimmed
        // status map. This is the round-tripped shape that GET returns.
        await prisma.organization.update({
          where: { id: user.orgId },
          data: { leadScoreConfig: result.value as object },
        });
        return { config: result.value, isCustom: true, defaults: DEFAULT_LEAD_SCORE_CONFIG };
      } catch (err) {
        logger.error('[lead-score] PUT config error:', err);
        return reply.status(500).send({ error: 'Failed to save lead score config' });
      }
    },
  );

  app.delete(
    '/api/v1/settings/lead-score-config',
    { preHandler: [requireRole('owner', 'admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        await prisma.organization.update({
          where: { id: user.orgId },
          data: { leadScoreConfig: Prisma.JsonNull },
        });
        return { config: DEFAULT_LEAD_SCORE_CONFIG, isCustom: false, defaults: DEFAULT_LEAD_SCORE_CONFIG };
      } catch (err) {
        logger.error('[lead-score] DELETE config error:', err);
        return reply.status(500).send({ error: 'Failed to reset lead score config' });
      }
    },
  );

  // ── POST /api/v1/contacts — create new contact ────────────────────────────
  // Feature 0019 Phase C: `tags` is no longer a column on Contact. Callers
  // that supply a legacy `tags: string[]` field get them upserted onto the
  // ContactTag junction; new clients should use `tagIds` instead.
  app.post('/api/v1/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const body = request.body as Record<string, any>;

      const contact = await prisma.contact.create({
        data: {
          orgId: user.orgId,
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          zaloUid: body.zaloUid,
          avatarUrl: body.avatarUrl,
          source: body.source,
          sourceDate: body.sourceDate ? new Date(body.sourceDate) : undefined,
          status: body.status ?? 'new',
          nextAppointment: body.nextAppointment ? new Date(body.nextAppointment) : undefined,
          assignedUserId: body.assignedUserId,
          notes: body.notes,
          metadata: body.metadata ?? {},
        },
      });

      // Attach tags via the junction if either body shape is supplied.
      let tagIds: string[] = [];
      if (Array.isArray(body.tagIds)) {
        tagIds = (body.tagIds as unknown[]).filter((s): s is string => typeof s === 'string');
      } else if (Array.isArray(body.tags)) {
        tagIds = await legacyTagsByName(user.orgId, body.tags as unknown[], user.id);
      }
      if (tagIds.length > 0) {
        await setContactTags(user.orgId, contact.id, tagIds, user.id);
      }

      return reply.status(201).send(contact);
    } catch (err) {
      logger.error('[contacts] Create error:', err);
      return reply.status(500).send({ error: 'Failed to create contact' });
    }
  });

  // ── PUT /api/v1/contacts/:id — update CRM fields ─────────────────────────
  app.put('/api/v1/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, any>;

      const existing = await prisma.contact.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, status: true, assignedUserId: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Contact not found' });

      // Feature 0019 Phase C: `tags` is no longer a column. Use
      // PUT /contacts/:id/tags for tag mutations. If a legacy caller sends
      // `tags: string[]` here we ignore it silently — they should migrate.
      //
      // Feature 0024 (BR-0007): `zaloDisplayName` is auto-synced from inbound
      // messages and is read-only over this endpoint. If a client sends it in
      // the body it's silently ignored (we never copy it into updateData).
      const updateData: any = {
        fullName: body.fullName,
        phone: body.phone,
        email: body.email,
        avatarUrl: body.avatarUrl,
        source: body.source,
        sourceDate: body.sourceDate ? new Date(body.sourceDate) : undefined,
        status: body.status,
        nextAppointment: body.nextAppointment ? new Date(body.nextAppointment) : undefined,
        assignedUserId: body.assignedUserId,
        notes: body.notes,
        metadata: body.metadata,
      };
      if (body.firstContactDate !== undefined) {
        updateData.firstContactDate = body.firstContactDate ? new Date(body.firstContactDate) : null;
      }

      const updated = await prisma.contact.update({
        where: { id },
        data: updateData,
        include: {
          assignedUser: { select: { id: true, fullName: true, email: true } },
          appointments: { orderBy: { appointmentDate: 'desc' }, take: 10 },
          _count: { select: { conversations: true } },
        },
      });

      if (body.status !== undefined && body.status !== existing.status) {
        logActivityAsync({
          orgId: user.orgId,
          userId: user.id,
          action: 'contact.status_changed',
          entityType: 'contact',
          entityId: id,
          details: { from: existing.status, to: body.status },
        });
      }
      if (
        body.assignedUserId !== undefined &&
        body.assignedUserId !== existing.assignedUserId
      ) {
        logActivityAsync({
          orgId: user.orgId,
          userId: user.id,
          action: 'contact.assigned',
          entityType: 'contact',
          entityId: id,
          details: { from: existing.assignedUserId, to: body.assignedUserId },
        });
      }

      return updated;
    } catch (err) {
      logger.error('[contacts] Update error:', err);
      return reply.status(500).send({ error: 'Failed to update contact' });
    }
  });

  // ── PUT /api/v1/contacts/:id/tags — update tags only ─────────────────────
  // Feature 0019 Phase C — accepts BOTH body shapes:
  //   NEW:    { tagIds: string[] }  → setContactTags directly
  //   LEGACY: { tags:   string[] }  → upsert by name (case-folded) → setContactTags
  //
  // Both paths converge on setContactTags which writes ContactTag rows on the
  // junction (single source of truth — the legacy Json column was dropped).
  app.put('/api/v1/contacts/:id/tags', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { tagIds?: unknown; tags?: unknown };

      const existing = await prisma.contact.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Contact not found' });

      let tagIds: string[];
      if (Array.isArray(body.tagIds)) {
        tagIds = body.tagIds.filter((s): s is string => typeof s === 'string');
      } else if (Array.isArray(body.tags)) {
        // Legacy path — log a single deprecation warning and convert.
        logger.warn(
          '[crm-tags] legacy {tags} body received on PUT /contacts/:id/tags — ' +
            'caller should migrate to {tagIds}',
        );
        tagIds = await legacyTagsByName(user.orgId, body.tags as unknown[], user.id);
      } else {
        return reply
          .status(400)
          .send({ error: 'Phải truyền tagIds (string[]) hoặc tags (string[])' });
      }

      const result = await setContactTags(user.orgId, id, tagIds, user.id);
      if (!result.ok) {
        const code = result.error.code;
        const status =
          code === 'NOT_FOUND' ? 404 : code === 'INVALID_TAG_ID' || code === 'TAG_ARCHIVED' ? 400 : 400;
        return reply.status(status).send({ error: result.error.message, code });
      }

      // Return the updated contact so the FE can refresh chips immediately,
      // including the enriched tag shape so chips render with color/emoji.
      const updated = await prisma.contact.findUnique({
        where: { id },
        include: {
          contactTags: {
            where: { tag: { archivedAt: null } },
            include: {
              tag: { select: { id: true, name: true, color: true, emoji: true } },
            },
            orderBy: { tag: { order: 'asc' } },
          },
        },
      });
      if (!updated) return reply.status(404).send({ error: 'Contact not found' });
      const enrichedTags = updated.contactTags.map((ct) => ({
        id: ct.tag.id,
        name: ct.tag.name,
        color: ct.tag.color,
        emoji: ct.tag.emoji,
      }));
      const { contactTags, ...rest } = updated;
      void contactTags;
      return {
        ...rest,
        tags: enrichedTags,
      };
    } catch (err) {
      logger.error('[contacts] Update tags error:', err);
      return reply.status(500).send({ error: 'Failed to update tags' });
    }
  });

  // ── DELETE /api/v1/contacts/:id ───────────────────────────────────────────
  app.delete('/api/v1/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };

      const existing = await prisma.contact.findFirst({ where: { id, orgId: user.orgId }, select: { id: true } });
      if (!existing) return reply.status(404).send({ error: 'Contact not found' });

      await prisma.contact.delete({ where: { id } });
      return { success: true };
    } catch (err) {
      logger.error('[contacts] Delete error:', err);
      return reply.status(500).send({ error: 'Failed to delete contact' });
    }
  });
}
