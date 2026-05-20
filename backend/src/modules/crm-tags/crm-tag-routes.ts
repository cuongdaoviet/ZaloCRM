/**
 * CRM tag routes — feature 0019, Phase A.
 *
 * Endpoints:
 *   GET    /api/v1/crm-tags                 — list (filterable)
 *   POST   /api/v1/crm-tags                 — create (any authed user)
 *   PUT    /api/v1/crm-tags/:id             — update (owner/admin)
 *   DELETE /api/v1/crm-tags/:id             — soft delete (owner/admin)
 *   GET    /api/v1/crm-tag-groups           — list groups
 *   POST   /api/v1/crm-tag-groups           — create group (owner/admin)
 *
 * Tag creation is intentionally NOT admin-gated (BR-0004) — sales staff need
 * to create tags inline while chatting. Edit/delete/archive ARE admin-only.
 *
 * TODO (Phase A.1): POST /api/v1/zalo-accounts/:id/sync-labels — pulls Zalo
 * label catalog into ZaloLabel + CrmTagGroup + CrmTag(managedBy='zalo_sync').
 * Deferred from Phase A to keep this PR focused; see docs/features/0019-crm-tags/SPEC.md §4.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import {
  archiveTag,
  createTag,
  createTagGroup,
  listTagGroups,
  listTags,
  updateTag,
  type ServiceError,
} from './crm-tag-service.js';

function isPrivileged(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/** Map a ServiceError onto the HTTP shape we use across the codebase. */
function sendServiceError(reply: FastifyReply, err: ServiceError) {
  const base: Record<string, unknown> = { error: err.message, code: err.code };
  if (err.code === 'TAG_DUPLICATE') {
    return reply.status(409).send({ ...base, existingTagId: err.existingTagId });
  }
  if (err.code === 'NOT_FOUND') return reply.status(404).send(base);
  if (err.code === 'ZALO_MANAGED' || err.code === 'TAG_ARCHIVED') {
    return reply.status(400).send(base);
  }
  return reply.status(400).send(base);
}

export async function crmTagRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── GET /api/v1/crm-tags ──────────────────────────────────────────────────
  app.get(
    '/api/v1/crm-tags',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        const q = request.query as Record<string, string | undefined>;

        const managedByRaw = q.managedBy;
        const managedBy =
          managedByRaw === 'crm' || managedByRaw === 'zalo_sync' ? managedByRaw : undefined;

        const tags = await listTags(user.orgId, {
          groupId: q.groupId || undefined,
          includeArchived: q.includeArchived === 'true' || q.includeArchived === '1',
          managedBy,
          search: q.search || undefined,
        });
        return { tags };
      } catch (err) {
        logger.error('[crm-tags] list error:', err);
        return reply.status(500).send({ error: 'Không tải được danh sách nhãn' });
      }
    },
  );

  // ── POST /api/v1/crm-tags ─────────────────────────────────────────────────
  // BR-0004: any authenticated user with contact edit access can create.
  app.post(
    '/api/v1/crm-tags',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        const body = (request.body ?? {}) as Record<string, unknown>;

        const result = await createTag(user.orgId, {
          name: typeof body.name === 'string' ? body.name : '',
          color: typeof body.color === 'string' ? body.color : undefined,
          emoji: typeof body.emoji === 'string' ? body.emoji : null,
          description: typeof body.description === 'string' ? body.description : null,
          groupId: typeof body.groupId === 'string' ? body.groupId : null,
        });
        if (!result.ok) return sendServiceError(reply, result.error);

        logger.info(`[crm-tags] user ${user.id} created tag ${result.value.id}`);
        return reply.status(201).send(result.value);
      } catch (err) {
        logger.error('[crm-tags] create error:', err);
        return reply.status(500).send({ error: 'Không tạo được nhãn' });
      }
    },
  );

  // ── PUT /api/v1/crm-tags/:id ──────────────────────────────────────────────
  // BR-0005: owner/admin only.
  app.put(
    '/api/v1/crm-tags/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        if (!isPrivileged(user.role)) {
          return reply.status(403).send({ error: 'Không có quyền sửa nhãn' });
        }

        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as Record<string, unknown>;

        const patch: Parameters<typeof updateTag>[2] = {};
        if (body.name !== undefined) patch.name = body.name as string;
        if (body.color !== undefined) patch.color = body.color as string;
        if ('emoji' in body) patch.emoji = (body.emoji as string | null) ?? null;
        if ('description' in body) patch.description = (body.description as string | null) ?? null;
        if ('groupId' in body) patch.groupId = (body.groupId as string | null) ?? null;
        if (typeof body.order === 'number') patch.order = body.order;
        if ('archivedAt' in body) {
          // Allow un-archive (BR-0013) via explicit null.
          patch.archivedAt = body.archivedAt === null ? null : new Date(body.archivedAt as string);
        }

        const result = await updateTag(user.orgId, id, patch);
        if (!result.ok) return sendServiceError(reply, result.error);
        return result.value;
      } catch (err) {
        logger.error('[crm-tags] update error:', err);
        return reply.status(500).send({ error: 'Không cập nhật được nhãn' });
      }
    },
  );

  // ── DELETE /api/v1/crm-tags/:id ───────────────────────────────────────────
  // BR-0006: owner/admin only. Soft delete — set archivedAt. Idempotent.
  app.delete(
    '/api/v1/crm-tags/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        if (!isPrivileged(user.role)) {
          return reply.status(403).send({ error: 'Không có quyền lưu trữ nhãn' });
        }

        const { id } = request.params as { id: string };
        const result = await archiveTag(user.orgId, id);
        if (!result.ok) return sendServiceError(reply, result.error);
        return result.value;
      } catch (err) {
        logger.error('[crm-tags] archive error:', err);
        return reply.status(500).send({ error: 'Không lưu trữ được nhãn' });
      }
    },
  );

  // ── GET /api/v1/crm-tag-groups ────────────────────────────────────────────
  app.get(
    '/api/v1/crm-tag-groups',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        const q = request.query as Record<string, string | undefined>;
        const includeArchived = q.includeArchived === 'true' || q.includeArchived === '1';
        const groups = await listTagGroups(user.orgId, includeArchived);
        return { groups };
      } catch (err) {
        logger.error('[crm-tags] list groups error:', err);
        return reply.status(500).send({ error: 'Không tải được danh sách nhóm nhãn' });
      }
    },
  );

  // ── POST /api/v1/crm-tag-groups ───────────────────────────────────────────
  // BR-0007: owner/admin only.
  app.post(
    '/api/v1/crm-tag-groups',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        if (!isPrivileged(user.role)) {
          return reply.status(403).send({ error: 'Không có quyền tạo nhóm nhãn' });
        }

        const body = (request.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name : '';
        const result = await createTagGroup(user.orgId, name);
        if (!result.ok) return sendServiceError(reply, result.error);
        return reply.status(201).send(result.value);
      } catch (err) {
        logger.error('[crm-tags] create group error:', err);
        return reply.status(500).send({ error: 'Không tạo được nhóm nhãn' });
      }
    },
  );
}
