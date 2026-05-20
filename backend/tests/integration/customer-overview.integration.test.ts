/**
 * Integration tests for customer 360 overview — feature 0013.
 * Covers AC-0001..AC-0009 from docs/features/0013-customer-360/SPEC.md.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    if (!req.user) req.user = { id: 't', orgId: 'o', role: 'owner' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { contactOverviewRoutes } = await import(
    '../../src/modules/contacts/contact-overview-routes.js'
  );
  await app.register(contactOverviewRoutes);
  return app;
}

async function seedFullScenario(label: string) {
  const org = await prisma.organization.create({ data: { name: `${label} Org` } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h', fullName: `Owner ${label}`, role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h', fullName: `Member ${label}`, role: 'member',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
  });
  const contact = await prisma.contact.create({
    data: {
      orgId: org.id,
      fullName: `Cust ${label}`,
      phone: '0900000000',
      status: 'interested',
      assignedUserId: owner.id,
    },
  });
  const conv = await prisma.conversation.create({
    data: {
      orgId: org.id, zaloAccountId: account.id, contactId: contact.id,
      threadType: 'user', externalThreadId: `uid-${label}`,
      lastMessageAt: new Date('2026-05-15T10:00:00Z'),
      unreadCount: 2,
    },
  });
  return { org, owner, member, account, contact, conv };
}

describe('Customer 360 overview', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: returns full overview with all 6 sections', async () => {
    const { org, owner, contact, conv } = await seedFullScenario('A');
    // Add data to each section
    await prisma.message.create({
      data: {
        conversationId: conv.id, senderType: 'contact', content: 'Hi there',
        contentType: 'text', sentAt: new Date('2026-05-15T10:00:00Z'),
      },
    });
    await prisma.order.create({
      data: {
        orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
        orderCode: 'ORD-A1', totalAmount: 500_000, status: 'completed',
      },
    });
    await prisma.appointment.create({
      data: {
        orgId: org.id, contactId: contact.id,
        appointmentDate: new Date('2026-05-21T09:00:00Z'),
        appointmentTime: '09:00', status: 'scheduled',
      },
    });
    await prisma.conversationNote.create({
      data: { conversationId: conv.id, authorId: owner.id, content: 'VIP customer' },
    });
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'contact.status_changed',
        entityType: 'contact', entityId: contact.id,
        details: { from: 'new', to: 'interested' },
      },
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.contact.fullName).toBe('Cust A');
    expect(body.stats.lifetimeRevenue).toBe(500_000);
    expect(body.stats.completedOrderCount).toBe(1);
    expect(body.stats.totalMessages).toBe(1);
    expect(body.primaryConversation.unreadCount).toBe(2);
    expect(body.primaryConversation.recentMessages).toHaveLength(1);
    expect(body.orders).toHaveLength(1);
    expect(body.appointments).toHaveLength(1);
    expect(body.notes).toHaveLength(1);
    expect(body.activity).toHaveLength(1);
    await app.close();
  });

  it('AC-0002: cross-org → 404', async () => {
    const { contact: contactA } = await seedFullScenario('B1');
    const { org: orgB, owner: ownerB } = await seedFullScenario('B2');

    const app = await buildApp({ id: ownerB.id, orgId: orgB.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contactA.id}/overview`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('AC-0003: member without assignment + no zalo access → 403', async () => {
    const { org, contact, member } = await seedFullScenario('C');
    // Reassign contact away from member
    await prisma.contact.update({
      where: { id: contact.id }, data: { assignedUserId: null },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0004: member assigned to contact → 200', async () => {
    const { org, contact, member } = await seedFullScenario('D');
    await prisma.contact.update({
      where: { id: contact.id }, data: { assignedUserId: member.id },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('AC-0004: member with zalo read access → 200 (even if not assigned)', async () => {
    const { org, contact, member, account } = await seedFullScenario('E');
    await prisma.contact.update({
      where: { id: contact.id }, data: { assignedUserId: null },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('AC-0005: owner can see any contact in org', async () => {
    const { org, contact, owner } = await seedFullScenario('F');
    await prisma.contact.update({
      where: { id: contact.id }, data: { assignedUserId: null },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('AC-0006: lifetimeRevenue excludes new and cancelled', async () => {
    const { org, owner, contact } = await seedFullScenario('G');
    await prisma.order.createMany({
      data: [
        { orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
          orderCode: 'O1', totalAmount: 100_000, status: 'new' },           // excluded
        { orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
          orderCode: 'O2', totalAmount: 200_000, status: 'cancelled' },     // excluded
        { orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
          orderCode: 'O3', totalAmount: 300_000, status: 'confirmed' },
        { orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
          orderCode: 'O4', totalAmount: 400_000, status: 'paid' },
        { orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
          orderCode: 'O5', totalAmount: 500_000, status: 'shipped' },
        { orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
          orderCode: 'O6', totalAmount: 600_000, status: 'completed' },
      ],
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    const body = JSON.parse(res.payload);
    // 300k + 400k + 500k + 600k = 1.8M
    expect(body.stats.lifetimeRevenue).toBe(1_800_000);
    expect(body.stats.completedOrderCount).toBe(4);
    expect(body.stats.orderCount).toBe(6);
    await app.close();
  });

  it('AC-0007: recentMessages ≤ 5 sorted DESC', async () => {
    const { org, owner, contact, conv } = await seedFullScenario('H');
    for (let i = 0; i < 8; i++) {
      await prisma.message.create({
        data: {
          conversationId: conv.id, senderType: 'contact', content: `msg-${i}`,
          contentType: 'text',
          sentAt: new Date(`2026-05-${10 + i}T10:00:00Z`),
        },
      });
    }
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    const body = JSON.parse(res.payload);
    expect(body.primaryConversation.recentMessages).toHaveLength(5);
    const contents = body.primaryConversation.recentMessages.map((m: any) => m.content);
    expect(contents).toEqual(['msg-7', 'msg-6', 'msg-5', 'msg-4', 'msg-3']);
    await app.close();
  });

  it('AC-0008: orders sorted createdAt DESC', async () => {
    const { org, owner, contact } = await seedFullScenario('I');
    await prisma.order.create({
      data: {
        orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
        orderCode: 'OLD', totalAmount: 100, status: 'completed',
        createdAt: new Date('2026-01-01'),
      },
    });
    await prisma.order.create({
      data: {
        orgId: org.id, contactId: contact.id, createdByUserId: owner.id,
        orderCode: 'NEW', totalAmount: 200, status: 'completed',
        createdAt: new Date('2026-05-01'),
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    const body = JSON.parse(res.payload);
    expect(body.orders.map((o: any) => o.orderCode)).toEqual(['NEW', 'OLD']);
    await app.close();
  });

  it('AC-0009: activity filtered to this contact only', async () => {
    const { org, owner, contact } = await seedFullScenario('J');
    const { contact: otherContact } = await seedFullScenario('J2');
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'contact.status_changed',
        entityType: 'contact', entityId: contact.id,
      },
    });
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'note.created',
        entityType: 'conversation_note', entityId: 'random',
      },
    });
    // Different contact's activity — must NOT appear
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'contact.assigned',
        entityType: 'contact', entityId: otherContact.id,
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    const body = JSON.parse(res.payload);
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0].entityId).toBe(contact.id);
    await app.close();
  });

  it('contact with no conversation returns primaryConversation=null', async () => {
    const org = await prisma.organization.create({ data: { name: 'NoConv Org' } });
    const owner = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `o-noconv-${Date.now()}@test.local`,
        passwordHash: 'h', fullName: 'Owner', role: 'owner',
      },
    });
    const contact = await prisma.contact.create({
      data: { orgId: org.id, fullName: 'No Chat', status: 'new' },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.primaryConversation).toBeNull();
    expect(body.notes).toEqual([]);
    expect(body.stats.totalMessages).toBe(0);
    await app.close();
  });

  it('truncates long message content in snippet', async () => {
    const { org, owner, contact, conv } = await seedFullScenario('K');
    await prisma.message.create({
      data: {
        conversationId: conv.id, senderType: 'contact',
        content: 'x'.repeat(500), contentType: 'text',
        sentAt: new Date(),
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    const body = JSON.parse(res.payload);
    const msg = body.primaryConversation.recentMessages[0];
    // 200 chars + '…' marker
    expect(msg.content.length).toBe(201);
    expect(msg.content.endsWith('…')).toBe(true);
    await app.close();
  });

  it('contact.status_changed activity logged on PUT', async () => {
    // Wire up the PUT route and verify the side effect
    const { contactRoutes } = await import('../../src/modules/contacts/contact-routes.js');
    const { org, owner, contact } = await seedFullScenario('L');
    const app = Fastify();
    app.addHook('onRequest', async (req: any) => {
      req.user = { id: owner.id, orgId: org.id, role: 'owner' };
    });
    await app.register(contactRoutes);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}`,
      payload: { status: 'converted' },
    });
    expect(res.statusCode).toBe(200);

    // Fire-and-forget — give it a beat
    await new Promise((r) => setTimeout(r, 100));
    const activities = await prisma.activityLog.findMany({
      where: { entityType: 'contact', entityId: contact.id, action: 'contact.status_changed' },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0].details).toEqual({ from: 'interested', to: 'converted' });
    await app.close();
  });

  it('contact.assigned activity logged on assignedUserId change', async () => {
    const { contactRoutes } = await import('../../src/modules/contacts/contact-routes.js');
    const { org, owner, member, contact } = await seedFullScenario('M');
    const app = Fastify();
    app.addHook('onRequest', async (req: any) => {
      req.user = { id: owner.id, orgId: org.id, role: 'owner' };
    });
    await app.register(contactRoutes);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}`,
      payload: { assignedUserId: member.id },
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 100));
    const activities = await prisma.activityLog.findMany({
      where: { entityType: 'contact', entityId: contact.id, action: 'contact.assigned' },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0].details).toEqual({ from: owner.id, to: member.id });
    await app.close();
  });

  // ── Feature 0019 Phase B: read-path switch on overview ────────────────────
  it('Phase B: tags returned as enriched [{id,name,color,emoji}] from junction', async () => {
    const { org, owner, contact } = await seedFullScenario('Tags');
    const tagHot = await prisma.crmTag.create({
      data: {
        orgId: org.id,
        name: 'Hot',
        normalizedName: 'hot',
        color: '#FF5722',
        emoji: '🔥',
      },
    });
    const tagVip = await prisma.crmTag.create({
      data: {
        orgId: org.id,
        name: 'VIP',
        normalizedName: 'vip',
        color: '#FFD700',
        emoji: '⭐',
      },
    });
    await prisma.contactTag.createMany({
      data: [
        { contactId: contact.id, tagId: tagHot.id },
        { contactId: contact.id, tagId: tagVip.id },
      ],
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(Array.isArray(body.contact.tags)).toBe(true);
    expect(body.contact.tags).toHaveLength(2);
    const byName = new Map<string, any>(body.contact.tags.map((t: any) => [t.name, t]));
    expect(byName.get('Hot')).toMatchObject({
      id: tagHot.id,
      color: '#FF5722',
      emoji: '🔥',
    });
    expect(byName.get('VIP')).toMatchObject({
      id: tagVip.id,
      color: '#FFD700',
      emoji: '⭐',
    });
    // Phase C: legacy `tagNames` shim has been removed.
    expect(body.contact.tagNames).toBeUndefined();
    await app.close();
  });

  it('Phase B: archived tags are excluded from the overview tag list', async () => {
    const { org, owner, contact } = await seedFullScenario('Archived');
    const liveTag = await prisma.crmTag.create({
      data: { orgId: org.id, name: 'Active', normalizedName: 'active' },
    });
    const archivedTag = await prisma.crmTag.create({
      data: {
        orgId: org.id,
        name: 'Stale',
        normalizedName: 'stale',
        archivedAt: new Date('2026-01-01'),
        isActive: false,
      },
    });
    await prisma.contactTag.createMany({
      data: [
        { contactId: contact.id, tagId: liveTag.id },
        { contactId: contact.id, tagId: archivedTag.id },
      ],
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/overview`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const names = body.contact.tags.map((t: any) => t.name);
    expect(names).toEqual(['Active']);
    expect(body.contact.tagNames).toBeUndefined();
    await app.close();
  });
});
