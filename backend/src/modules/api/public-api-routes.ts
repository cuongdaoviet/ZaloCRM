/**
 * public-api-routes.ts — External REST API authenticated via API key (X-Api-Key header).
 * Provides read/write access to contacts, conversations, appointments, and message sending.
 * All routes prefixed /api/public/ — no JWT required, orgId injected from API key lookup.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { trackBackground } from '../../shared/utils/background-tasks.js';
import {
  hashApiKey,
  isHashedApiKey,
  verifyApiKeyHash,
} from '../../shared/crypto/hash-api-key.js';
import {
  legacyTagsByName,
  setContactTags,
} from '../crm-tags/crm-tag-service.js';

// ── API key auth middleware ────────────────────────────────────────────────────

/**
 * Authenticate the request against a `public_api_key` row in `app_settings`.
 *
 * Feature 0046 BR-0014/BR-0015: two acceptance paths, both constant-time:
 *   (a) The presented key hashes to the stored value (already migrated).
 *   (b) The presented key equals the stored value verbatim (legacy
 *       plaintext from pre-0046 deployments).
 *
 * On a legacy-plaintext hit (path b), the row is rewritten with the hash
 * via a fire-and-forget background task — idempotent because subsequent
 * lookups take path (a) and the row is already in the migrated shape.
 *
 * The scan is O(N) over all `public_api_key` rows (one per org). That
 * was already the case before this change — we only added per-row
 * hashing, not a new dimension of fanout. With ~thousands of orgs this
 * is still sub-ms per request.
 */
async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'] as string;
  if (!apiKey) return reply.status(401).send({ error: 'API key required' });

  // Hash once, compare against every row in constant time.
  const presentedHash = hashApiKey(apiKey);

  const candidates = await prisma.appSetting.findMany({
    where: { settingKey: 'public_api_key' },
    select: { id: true, orgId: true, valuePlain: true },
  });

  for (const row of candidates) {
    const stored = row.valuePlain ?? '';
    if (!stored) continue;

    if (isHashedApiKey(stored)) {
      // Path (a) — already migrated. Constant-time hash compare.
      if (verifyApiKeyHash(presentedHash, stored)) {
        (request as any).orgId = row.orgId;
        return;
      }
    } else {
      // Path (b) — legacy plaintext. Use timingSafeEqual on equal-length
      // buffers to avoid leaking the position of the first divergent
      // byte across orgs.
      if (
        stored.length === apiKey.length &&
        timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(apiKey, 'utf8'))
      ) {
        (request as any).orgId = row.orgId;
        // Fire-and-forget lazy migration. Idempotent — if another
        // concurrent request triggers the same write, both end up with
        // the same hash.
        trackBackground(
          prisma.appSetting
            .update({
              where: { id: row.id },
              data: { valuePlain: presentedHash },
            })
            .then(() => {
              logger.info(
                `[public-api] migrated plaintext API key → SHA-256 hash for org ${row.orgId}`,
              );
            })
            .catch((err) => {
              logger.warn(
                `[public-api] lazy hash migration failed for org ${row.orgId}:`,
                err,
              );
            }),
        );
        return;
      }
    }
  }

  return reply.status(401).send({ error: 'Invalid API key' });
}

// ── Route registration ────────────────────────────────────────────────────────

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', apiKeyAuth);

  // ── Contacts ─────────────────────────────────────────────────────────────

  app.get('/api/public/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { search = '', status = '', limit = '20' } = request.query as Record<string, string>;

      const where: any = { orgId };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }

      // Feature 0019 Phase C: tags come from the ContactTag junction. We
      // return a string[] of tag NAMES so external callers keep the same
      // wire shape they had with the legacy Json column.
      const contacts = await prisma.contact.findMany({
        where,
        select: {
          id: true, fullName: true, phone: true, email: true,
          source: true, status: true, notes: true,
          contactTags: {
            where: { tag: { archivedAt: null } },
            include: { tag: { select: { name: true } } },
            orderBy: { tag: { order: 'asc' } },
          },
          createdAt: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(parseInt(limit) || 20, 100),
      });

      const shaped = contacts.map((c) => {
        const { contactTags, ...rest } = c;
        return { ...rest, tags: contactTags.map((ct) => ct.tag.name) };
      });

      return { contacts: shaped };
    } catch (err) {
      logger.error('[public-api] GET /contacts error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contacts' });
    }
  });

  app.get('/api/public/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };

      // Feature 0019 Phase C: include enriched tags through the junction
      // so the response carries `tags: string[]` (back-compat).
      const contact = await prisma.contact.findFirst({
        where: { id, orgId },
        include: {
          appointments: { orderBy: { appointmentDate: 'desc' }, take: 5 },
          _count: { select: { conversations: true } },
          contactTags: {
            where: { tag: { archivedAt: null } },
            include: { tag: { select: { name: true } } },
            orderBy: { tag: { order: 'asc' } },
          },
        },
      });

      if (!contact) return reply.status(404).send({ error: 'Contact not found' });
      const { contactTags, ...rest } = contact;
      return { ...rest, tags: contactTags.map((ct) => ct.tag.name) };
    } catch (err) {
      logger.error('[public-api] GET /contacts/:id error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contact' });
    }
  });

  app.post('/api/public/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.fullName && !body?.phone) {
        return reply.status(400).send({ error: 'fullName or phone is required' });
      }

      const contact = await prisma.contact.create({
        data: {
          orgId,
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          source: body.source,
          status: body.status ?? 'new',
          notes: body.notes,
        },
      });

      // Feature 0019 Phase C: `tags: string[]` on the create body is still
      // accepted for backward compatibility (external partners depend on it).
      // We upsert by case-folded name → CrmTag rows, then attach via the
      // ContactTag junction.
      let appliedTags: string[] = [];
      if (Array.isArray(body.tags) && body.tags.length > 0) {
        const tagIds = await legacyTagsByName(orgId, body.tags as unknown[], null);
        if (tagIds.length > 0) {
          const result = await setContactTags(orgId, contact.id, tagIds, null);
          if (result.ok) {
            // Reload tag names to confirm what was actually attached.
            const links = await prisma.contactTag.findMany({
              where: { contactId: contact.id },
              include: { tag: { select: { name: true } } },
            });
            appliedTags = links.map((l) => l.tag.name);
          }
        }
      }

      return reply.status(201).send({ ...contact, tags: appliedTags });
    } catch (err) {
      logger.error('[public-api] POST /contacts error:', err);
      return reply.status(500).send({ error: 'Failed to create contact' });
    }
  });

  app.put('/api/public/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, any>;

      const existing = await prisma.contact.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!existing) return reply.status(404).send({ error: 'Contact not found' });

      const updated = await prisma.contact.update({
        where: { id },
        data: {
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          source: body.source,
          status: body.status,
          notes: body.notes,
        },
      });

      // Feature 0019 Phase C: when `tags` is supplied, replace the full tag
      // set through the junction — mirrors the JWT endpoint's behavior.
      if (Array.isArray(body.tags)) {
        const tagIds = await legacyTagsByName(orgId, body.tags as unknown[], null);
        await setContactTags(orgId, id, tagIds, null);
      }

      const links = await prisma.contactTag.findMany({
        where: { contactId: id },
        include: { tag: { select: { name: true } } },
        orderBy: { tag: { order: 'asc' } },
      });
      return { ...updated, tags: links.map((l) => l.tag.name) };
    } catch (err) {
      logger.error('[public-api] PUT /contacts/:id error:', err);
      return reply.status(500).send({ error: 'Failed to update contact' });
    }
  });

  // ── Conversations ─────────────────────────────────────────────────────────

  app.get('/api/public/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { limit = '20' } = request.query as Record<string, string>;

      const conversations = await prisma.conversation.findMany({
        where: { orgId },
        select: {
          id: true, threadType: true, externalThreadId: true,
          lastMessageAt: true, unreadCount: true, isReplied: true,
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: Math.min(parseInt(limit) || 20, 100),
      });

      return { conversations };
    } catch (err) {
      logger.error('[public-api] GET /conversations error:', err);
      return reply.status(500).send({ error: 'Failed to fetch conversations' });
    }
  });

  app.get('/api/public/conversations/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const { limit = '50' } = request.query as Record<string, string>;

      const conv = await prisma.conversation.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!conv) return reply.status(404).send({ error: 'Conversation not found' });

      const messages = await prisma.message.findMany({
        where: { conversationId: id, isDeleted: false },
        orderBy: { sentAt: 'desc' },
        take: Math.min(parseInt(limit) || 50, 200),
        select: {
          id: true, senderType: true, senderName: true,
          content: true, contentType: true, sentAt: true, attachments: true,
        },
      });

      return { messages };
    } catch (err) {
      logger.error('[public-api] GET /conversations/:id/messages error:', err);
      return reply.status(500).send({ error: 'Failed to fetch messages' });
    }
  });

  // ── Appointments ──────────────────────────────────────────────────────────

  app.get('/api/public/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { from, to } = request.query as Record<string, string>;

      const where: any = { orgId };
      if (from || to) {
        where.appointmentDate = {};
        if (from) where.appointmentDate.gte = new Date(from);
        if (to) where.appointmentDate.lte = new Date(to);
      }

      const appointments = await prisma.appointment.findMany({
        where,
        include: { contact: { select: { id: true, fullName: true, phone: true } } },
        orderBy: { appointmentDate: 'asc' },
        take: 100,
      });

      return { appointments };
    } catch (err) {
      logger.error('[public-api] GET /appointments error:', err);
      return reply.status(500).send({ error: 'Failed to fetch appointments' });
    }
  });

  app.post('/api/public/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.contactId || !body?.appointmentDate) {
        return reply.status(400).send({ error: 'contactId and appointmentDate are required' });
      }

      const contact = await prisma.contact.findFirst({ where: { id: body.contactId, orgId }, select: { id: true } });
      if (!contact) return reply.status(404).send({ error: 'Contact not found' });

      const appointment = await prisma.appointment.create({
        data: {
          orgId,
          contactId: body.contactId,
          appointmentDate: new Date(body.appointmentDate),
          appointmentTime: body.appointmentTime,
          type: body.type,
          notes: body.notes,
        },
      });

      return reply.status(201).send(appointment);
    } catch (err) {
      logger.error('[public-api] POST /appointments error:', err);
      return reply.status(500).send({ error: 'Failed to create appointment' });
    }
  });

  // ── Messages send ─────────────────────────────────────────────────────────

  app.post('/api/public/messages/send', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.zaloAccountId || !body?.threadId || !body?.content) {
        return reply.status(400).send({ error: 'zaloAccountId, threadId, and content are required' });
      }

      // Verify account belongs to org
      const account = await prisma.zaloAccount.findFirst({
        where: { id: body.zaloAccountId, orgId },
        select: { id: true, status: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account not found' });
      if (account.status !== 'connected') {
        return reply.status(422).send({ error: 'Zalo account is not connected' });
      }

      // Dynamically import zaloPool to avoid circular deps
      const { zaloPool } = await import('../zalo/zalo-pool.js');
      const api = zaloPool.getApi(body.zaloAccountId);
      if (!api) return reply.status(422).send({ error: 'Zalo account not active in pool' });

      const threadType = body.threadType === 'group' ? 1 : 0;
      await api.sendMessage(body.content, body.threadId, threadType);

      return { success: true };
    } catch (err) {
      logger.error('[public-api] POST /messages/send error:', err);
      return reply.status(500).send({ error: 'Failed to send message' });
    }
  });
}
