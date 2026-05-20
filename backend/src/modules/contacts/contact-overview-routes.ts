/**
 * Customer 360 overview — feature 0013.
 *
 * One endpoint returns everything the UI needs to render the customer page:
 * profile, lifetime stats, active conversation snippet, orders, appointments,
 * notes, and activity timeline filtered to this contact.
 *
 * Permission model (BR-0002):
 * - owner/admin can see any contact in their org
 * - member can see only contacts assigned to them OR contacts whose primary
 *   conversation lives on a Zalo account they have read access to
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';

const REVENUE_STATUSES = ['confirmed', 'paid', 'shipped', 'completed'] as const;
const RECENT_MESSAGES_LIMIT = 5;
const ACTIVITY_LIMIT = 50;
const SNIPPET_MAX = 200;

function truncate(text: string | null | undefined, max: number): string | null {
  if (!text) return text ?? null;
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export async function contactOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get<{ Params: { id: string } }>(
    '/api/v1/contacts/:id/overview',
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      // Feature 0018: if the contact has been merged into a primary, return
      // the PRIMARY's overview with `mergedFrom` set so the FE can redirect.
      // We resolve up to one hop — merge is one-way so chains shouldn't exist,
      // but be defensive.
      let targetId = id;
      let mergedFrom: string | null = null;
      const lookupContact = await prisma.contact.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, mergedIntoId: true },
      });
      if (!lookupContact) return reply.status(404).send({ error: 'Không tồn tại' });
      if (lookupContact.mergedIntoId) {
        targetId = lookupContact.mergedIntoId;
        mergedFrom = lookupContact.id;
      }

      // Feature 0019 Phase B: read tags from the junction with full color/emoji.
      // Archived tags are filtered out by default so the chip list matches what
      // the user actually has live.
      const contact = await prisma.contact.findFirst({
        where: { id: targetId, orgId: user.orgId },
        include: {
          assignedUser: { select: { id: true, fullName: true } },
          contactTags: {
            where: { tag: { archivedAt: null } },
            include: {
              tag: { select: { id: true, name: true, color: true, emoji: true } },
            },
            orderBy: { tag: { order: 'asc' } },
          },
        },
      });
      if (!contact) return reply.status(404).send({ error: 'Không tồn tại' });

      const enrichedTags = contact.contactTags.map((ct) => ({
        id: ct.tag.id,
        name: ct.tag.name,
        color: ct.tag.color,
        emoji: ct.tag.emoji,
      }));

      // Pick the most-recently-active conversation for primaryConversation
      const primaryConv = await prisma.conversation.findFirst({
        where: { contactId: contact.id, orgId: user.orgId },
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
        select: { id: true, zaloAccountId: true, lastMessageAt: true, unreadCount: true },
      });

      // Member gate: assigned OR has read access on primary conv's zalo account
      if (user.role === 'member') {
        const isAssigned = contact.assignedUserId === user.id;
        let hasZaloAccess = false;
        if (!isAssigned && primaryConv) {
          const access = await prisma.zaloAccountAccess.findFirst({
            where: { zaloAccountId: primaryConv.zaloAccountId, userId: user.id },
            select: { id: true },
          });
          hasZaloAccess = !!access;
        }
        if (!isAssigned && !hasZaloAccess) {
          return reply.status(403).send({ error: 'Không có quyền xem khách hàng này' });
        }
      }

      const [
        recentMessages,
        orders,
        appointments,
        notes,
        activity,
        orderStats,
        appointmentStats,
        totalMessages,
      ] = await Promise.all([
        primaryConv
          ? prisma.message.findMany({
              where: { conversationId: primaryConv.id, isDeleted: false },
              orderBy: { sentAt: 'desc' },
              take: RECENT_MESSAGES_LIMIT,
              select: { id: true, senderType: true, content: true, contentType: true, sentAt: true },
            })
          : Promise.resolve([] as any[]),

        prisma.order.findMany({
          where: { contactId: contact.id, orgId: user.orgId },
          orderBy: { createdAt: 'desc' },
          include: { createdBy: { select: { id: true, fullName: true } } },
        }),

        prisma.appointment.findMany({
          where: { contactId: contact.id, orgId: user.orgId },
          orderBy: { appointmentDate: 'desc' },
          include: { assignedUser: { select: { id: true, fullName: true } } },
        }),

        primaryConv
          ? prisma.conversationNote.findMany({
              where: { conversationId: primaryConv.id },
              orderBy: { createdAt: 'desc' },
              include: { author: { select: { id: true, fullName: true } } },
            })
          : Promise.resolve([] as any[]),

        prisma.activityLog.findMany({
          where: { orgId: user.orgId, entityType: 'contact', entityId: contact.id },
          orderBy: { createdAt: 'desc' },
          take: ACTIVITY_LIMIT,
          include: { user: { select: { id: true, fullName: true } } },
        }),

        prisma.order.aggregate({
          where: {
            contactId: contact.id,
            orgId: user.orgId,
            status: { in: [...REVENUE_STATUSES] },
          },
          _sum: { totalAmount: true },
          _count: { _all: true },
        }),

        prisma.appointment.groupBy({
          by: ['status'],
          where: { contactId: contact.id, orgId: user.orgId },
          _count: { _all: true },
        }),

        primaryConv
          ? prisma.message.count({ where: { conversationId: primaryConv.id, isDeleted: false } })
          : Promise.resolve(0),
      ]);

      const upcomingAppointmentCount = appointmentStats
        .filter((a) => a.status === 'scheduled')
        .reduce((sum, a) => sum + a._count._all, 0);
      const totalAppointmentCount = appointmentStats.reduce((sum, a) => sum + a._count._all, 0);

      return {
        // Feature 0018: when present, FE should `router.replace` to the
        // primary contact's URL. `mergedFrom` is the original id the caller
        // asked for; `contact.id` is the primary that owns the payload.
        mergedInto: mergedFrom ? contact.id : null,
        mergedFrom,
        contact: {
          id: contact.id,
          fullName: contact.fullName,
          phone: contact.phone,
          email: contact.email,
          avatarUrl: contact.avatarUrl,
          source: contact.source,
          status: contact.status,
          // Phase C: rich tag objects with color/emoji. The legacy
          // `tagNames: string[]` shim has been removed.
          tags: enrichedTags,
          nextAppointment: contact.nextAppointment,
          assignedUser: contact.assignedUser,
          createdAt: contact.createdAt,
          firstContactDate: contact.firstContactDate,
        },
        stats: {
          lifetimeRevenue: orderStats._sum.totalAmount ?? 0,
          orderCount: orders.length,
          completedOrderCount: orderStats._count._all,
          appointmentCount: totalAppointmentCount,
          upcomingAppointmentCount,
          totalMessages,
        },
        primaryConversation: primaryConv
          ? {
              id: primaryConv.id,
              zaloAccountId: primaryConv.zaloAccountId,
              lastMessageAt: primaryConv.lastMessageAt,
              unreadCount: primaryConv.unreadCount,
              recentMessages: recentMessages.map((m) => ({
                ...m,
                content: truncate(m.content, SNIPPET_MAX),
              })),
            }
          : null,
        orders,
        appointments,
        notes,
        activity,
      };
    },
  );
}
