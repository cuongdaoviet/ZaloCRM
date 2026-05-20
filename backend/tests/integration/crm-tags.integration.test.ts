/**
 * Integration tests for feature 0019 — CRM tags as relational model.
 *
 * Covers AC-0001..AC-0011 from docs/features/0019-crm-tags/SPEC.md.
 * Phase C: the legacy `contact.tags` Json column has been dropped — the
 * ContactTag junction is the only source of truth.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
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

async function buildTagApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { crmTagRoutes } = await import('../../src/modules/crm-tags/crm-tag-routes.js');
  await app.register(crmTagRoutes);
  return app;
}

async function buildContactApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { contactRoutes } = await import('../../src/modules/contacts/contact-routes.js');
  await app.register(contactRoutes);
  return app;
}

async function seedOrgAndUsers() {
  const org = await prisma.organization.create({ data: { name: 'Tag Org' } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  return { org, owner, member };
}

async function seedContact(orgId: string) {
  return prisma.contact.create({
    data: { orgId, fullName: 'Khách test', phone: '0900000001' },
  });
}

describe('CRM tag CRUD', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: POST tag "VIP" + valid color → 201 with normalizedName="vip"', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const app = await buildTagApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/crm-tags',
      payload: { name: 'VIP', color: '#FF0000' },
    });
    expect(res.statusCode).toBe(201);
    const tag = JSON.parse(res.payload);
    expect(tag.name).toBe('VIP');
    expect(tag.normalizedName).toBe('vip');
    expect(tag.color).toBe('#FF0000');
    expect(tag.managedBy).toBeNull();
    await app.close();
  });

  it('AC-0002: POST "vip" after "VIP" → 409 TAG_DUPLICATE with existingTagId', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const app = await buildTagApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/crm-tags',
      payload: { name: 'VIP' },
    });
    expect(first.statusCode).toBe(201);
    const firstTag = JSON.parse(first.payload);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/crm-tags',
      payload: { name: 'vip' },
    });
    expect(dup.statusCode).toBe(409);
    const body = JSON.parse(dup.payload);
    expect(body.code).toBe('TAG_DUPLICATE');
    expect(body.existingTagId).toBe(firstTag.id);
    await app.close();
  });

  it('AC-0003: POST with invalid color #XYZ → 400 INVALID_COLOR', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const app = await buildTagApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/crm-tags',
      payload: { name: 'Hot', color: '#XYZ' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('INVALID_COLOR');
    await app.close();
  });

  it('AC-0004: PUT name on a managedBy=zalo_sync tag → 400 ZALO_MANAGED', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const tag = await prisma.crmTag.create({
      data: {
        orgId: org.id,
        name: 'Zalo VIP',
        normalizedName: 'zalo vip',
        managedBy: 'zalo_sync',
      },
    });
    const app = await buildTagApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/crm-tags/${tag.id}`,
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('ZALO_MANAGED');
    await app.close();
  });

  it('AC-0004 extra: order/groupId mutations DO work on a zalo-managed tag', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const tag = await prisma.crmTag.create({
      data: {
        orgId: org.id,
        name: 'Zalo VIP',
        normalizedName: 'zalo vip',
        managedBy: 'zalo_sync',
      },
    });
    const app = await buildTagApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/crm-tags/${tag.id}`,
      payload: { order: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).order).toBe(5);
    await app.close();
  });

  it('AC-0005: DELETE sets archivedAt without removing row; idempotent', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const tag = await prisma.crmTag.create({
      data: { orgId: org.id, name: 'Hot', normalizedName: 'hot' },
    });
    const app = await buildTagApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const first = await app.inject({ method: 'DELETE', url: `/api/v1/crm-tags/${tag.id}` });
    expect(first.statusCode).toBe(200);
    let stored = await prisma.crmTag.findUnique({ where: { id: tag.id } });
    expect(stored).not.toBeNull();
    expect(stored?.archivedAt).not.toBeNull();
    expect(stored?.isActive).toBe(false);

    const second = await app.inject({ method: 'DELETE', url: `/api/v1/crm-tags/${tag.id}` });
    expect(second.statusCode).toBe(200);
    stored = await prisma.crmTag.findUnique({ where: { id: tag.id } });
    expect(stored).not.toBeNull();
    await app.close();
  });

  it('AC-0006: member CAN create a tag but CANNOT update one', async () => {
    const { org, member } = await seedOrgAndUsers();
    const app = await buildTagApp({ id: member.id, orgId: org.id, role: 'member' });

    // Create — allowed for any authed user
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/crm-tags',
      payload: { name: 'CreatedByMember' },
    });
    expect(create.statusCode).toBe(201);
    const tag = JSON.parse(create.payload);

    // Update — admin-only
    const update = await app.inject({
      method: 'PUT',
      url: `/api/v1/crm-tags/${tag.id}`,
      payload: { name: 'Renamed' },
    });
    expect(update.statusCode).toBe(403);

    // Archive — admin-only
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/crm-tags/${tag.id}` });
    expect(del.statusCode).toBe(403);
    await app.close();
  });
});

describe('PUT /contacts/:id/tags — new tagIds body', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0007: tagIds=[A,B] creates 2 junction links, increments usageCount', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const contact = await seedContact(org.id);
    const tagA = await prisma.crmTag.create({
      data: { orgId: org.id, name: 'A', normalizedName: 'a' },
    });
    const tagB = await prisma.crmTag.create({
      data: { orgId: org.id, name: 'B', normalizedName: 'b' },
    });
    const app = await buildContactApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}/tags`,
      payload: { tagIds: [tagA.id, tagB.id] },
    });
    expect(res.statusCode).toBe(200);
    // Phase C: response carries enriched `tags` only; `tagNames` is gone.
    const body = JSON.parse(res.payload);
    expect(body.tagNames).toBeUndefined();
    expect(body.tags).toHaveLength(2);

    const links = await prisma.contactTag.findMany({ where: { contactId: contact.id } });
    expect(links).toHaveLength(2);

    const refreshedA = await prisma.crmTag.findUnique({ where: { id: tagA.id } });
    const refreshedB = await prisma.crmTag.findUnique({ where: { id: tagB.id } });
    expect(refreshedA?.usageCount).toBe(1);
    expect(refreshedB?.usageCount).toBe(1);
    await app.close();
  });

  it('AC-0008: replacing {A,B} with {A} removes B link and decrements usageCount(B)', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const contact = await seedContact(org.id);
    const tagA = await prisma.crmTag.create({
      data: { orgId: org.id, name: 'A', normalizedName: 'a' },
    });
    const tagB = await prisma.crmTag.create({
      data: { orgId: org.id, name: 'B', normalizedName: 'b' },
    });
    const app = await buildContactApp({ id: owner.id, orgId: org.id, role: 'owner' });

    // Seed initial state with [A, B]
    await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}/tags`,
      payload: { tagIds: [tagA.id, tagB.id] },
    });

    // Replace with [A]
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}/tags`,
      payload: { tagIds: [tagA.id] },
    });
    expect(res.statusCode).toBe(200);

    const links = await prisma.contactTag.findMany({ where: { contactId: contact.id } });
    expect(links).toHaveLength(1);
    expect(links[0].tagId).toBe(tagA.id);

    const refreshedB = await prisma.crmTag.findUnique({ where: { id: tagB.id } });
    expect(refreshedB?.usageCount).toBe(0);
    await app.close();
  });

  it('AC-0009: tagId from another org → 400 INVALID_TAG_ID', async () => {
    const { org: orgA, owner: ownerA } = await seedOrgAndUsers();
    const { org: orgB } = await seedOrgAndUsers();
    const contact = await seedContact(orgA.id);
    const foreignTag = await prisma.crmTag.create({
      data: { orgId: orgB.id, name: 'Foreign', normalizedName: 'foreign' },
    });
    const app = await buildContactApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}/tags`,
      payload: { tagIds: [foreignTag.id] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('INVALID_TAG_ID');
    await app.close();
  });

  it('AC-0010: applying an archived tag → 400 TAG_ARCHIVED', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const contact = await seedContact(org.id);
    const archivedTag = await prisma.crmTag.create({
      data: {
        orgId: org.id,
        name: 'Old',
        normalizedName: 'old',
        archivedAt: new Date('2026-01-01'),
        isActive: false,
      },
    });
    const app = await buildContactApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}/tags`,
      payload: { tagIds: [archivedTag.id] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('TAG_ARCHIVED');
    await app.close();
  });
});

describe('PUT /contacts/:id/tags — legacy {tags} body', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0011: legacy body {tags:["VIP"]} upserts CrmTag + creates junction link', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const contact = await seedContact(org.id);
    const app = await buildContactApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}/tags`,
      payload: { tags: ['VIP'] },
    });
    expect(res.statusCode).toBe(200);

    // Tag row exists
    const tag = await prisma.crmTag.findFirst({
      where: { orgId: org.id, normalizedName: 'vip' },
    });
    expect(tag).not.toBeNull();
    expect(tag?.name).toBe('VIP');

    // Junction link exists
    const link = await prisma.contactTag.findUnique({
      where: { contactId_tagId: { contactId: contact.id, tagId: tag!.id } },
    });
    expect(link).not.toBeNull();

    // Phase C: the legacy `tags` Json column on Contact has been dropped.
    // The Prisma model no longer exposes it.
    const after = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect((after as Record<string, unknown> | null)?.tags).toBeUndefined();
    await app.close();
  });

  it('legacy {tags:["VIP","vip"]} dedupes via case-folding → 1 row, 1 link', async () => {
    const { org, owner } = await seedOrgAndUsers();
    const contact = await seedContact(org.id);
    const app = await buildContactApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contact.id}/tags`,
      payload: { tags: ['VIP', 'vip'] },
    });
    expect(res.statusCode).toBe(200);

    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    expect(tags).toHaveLength(1);

    const links = await prisma.contactTag.findMany({ where: { contactId: contact.id } });
    expect(links).toHaveLength(1);
    await app.close();
  });
});

// Phase C — belt-and-braces: the legacy Json column on Contact must be gone.
describe('Phase C: Contact.tags Json column is gone', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('Prisma-returned Contact row carries no `tags` property', async () => {
    const { org } = await seedOrgAndUsers();
    const contact = await seedContact(org.id);
    const fetched = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(fetched).not.toBeNull();
    expect((fetched as Record<string, unknown> | null)?.tags).toBeUndefined();
  });
});
