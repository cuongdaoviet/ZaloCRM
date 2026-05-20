/**
 * contact-routes.ts — REST API for CRM contact management.
 * Supports list, detail, create, update, delete, pipeline view, and tag updates.
 * All routes require JWT auth and are scoped to user's org.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { logActivityAsync } from '../activity/activity-service.js';
import {
  setContactTags,
  legacyTagsByName,
} from '../crm-tags/crm-tag-service.js';

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

      const [contacts, total] = await Promise.all([
        prisma.contact.findMany({
          where,
          include: {
            assignedUser: { select: { id: true, fullName: true, email: true } },
            _count: { select: { conversations: true, appointments: true } },
          },
          orderBy: { updatedAt: 'desc' },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        }),
        prisma.contact.count({ where }),
      ]);

      return { contacts, total, page: pageNum, limit: limitNum };
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
        },
      });

      if (!contact) return reply.status(404).send({ error: 'Contact not found' });
      return contact;
    } catch (err) {
      logger.error('[contacts] Detail error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contact' });
    }
  });

  // ── POST /api/v1/contacts — create new contact ────────────────────────────
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
          tags: body.tags ?? [],
          metadata: body.metadata ?? {},
        },
      });

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
        tags: body.tags,
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
  // Feature 0019 Phase A — accepts BOTH body shapes:
  //   NEW:    { tagIds: string[] }  → setContactTags directly
  //   LEGACY: { tags:   string[] }  → upsert by name (case-folded) → setContactTags
  //
  // Both paths converge on setContactTags which writes ContactTag rows AND
  // mirrors the resulting tag NAMES into contact.tags (Json) so existing
  // readers (campaigns / KPI / Customer 360) keep working.
  app.put('/api/v1/contacts/:id/tags', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { tagIds?: unknown; tags?: unknown };

      const existing = await prisma.contact.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, tags: true },
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

      // Return the updated contact so the FE can refresh chips immediately.
      const updated = await prisma.contact.findUnique({ where: { id } });
      return updated;
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
