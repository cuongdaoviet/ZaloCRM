/**
 * Integration tests for the Phase B pre-flight audit. Covers AC-0019:
 * the script must produce a structured report WITHOUT modifying the DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await resetDb(prisma);
});

async function seedScenario() {
  const org = await prisma.organization.create({ data: { name: 'Pre-flight Org' } });
  // Mixed quality input to exercise every bucket.
  await prisma.contact.createMany({
    data: [
      { orgId: org.id, fullName: 'C1', phone: '0900000001', tags: ['VIP', 'Hot'] },
      { orgId: org.id, fullName: 'C2', phone: '0900000002', tags: ['vip', 'cold'] }, // case collision
      { orgId: org.id, fullName: 'C3', phone: '0900000003', tags: [''] }, // whitespace bucket
      { orgId: org.id, fullName: 'C4', phone: '0900000004', tags: ['A'.repeat(80)] }, // oversize
      { orgId: org.id, fullName: 'C5', phone: '0900000005', tags: [123, 'OK'] as never }, // non_string + valid
      { orgId: org.id, fullName: 'C6', phone: '0900000006', tags: [] },
    ],
  });
  // Pre-existing CrmTag that pre-flight should flag as "adopt"
  await prisma.crmTag.create({
    data: { orgId: org.id, name: 'VIP', normalizedName: 'vip' },
  });
  return org;
}

describe('Feature 0019 Phase B — pre-flight', () => {
  it('AC-0019: returns structured report covering every bucket', async () => {
    const org = await seedScenario();

    const { runPreflight } = await import('../../prisma/scripts/0019-preflight-tags.js');
    const report = await runPreflight();

    expect(report.orgs.length).toBeGreaterThanOrEqual(1);
    const orgReport = report.orgs.find((o) => o.orgId === org.id);
    expect(orgReport).toBeDefined();
    if (!orgReport) return;

    expect(orgReport.contactsTotal).toBe(6);
    expect(orgReport.contactsWithTags).toBe(5); // C6 has empty array
    expect(orgReport.buckets.whitespaceOnly).toBeGreaterThanOrEqual(1);
    expect(orgReport.buckets.oversize).toBe(1);
    expect(orgReport.buckets.nonString).toBe(1);
    expect(orgReport.buckets.valid).toBeGreaterThanOrEqual(5);

    // unique normalized names: vip, hot, cold, AAAA...(50 chars), ok = 5
    expect(orgReport.uniqueNormalizedCount).toBe(5);

    // Case collision on "vip" (VIP + vip)
    const vipCollision = orgReport.caseCollisions.find((c) => c.normalizedName === 'vip');
    expect(vipCollision).toBeDefined();
    expect(vipCollision?.variants.sort()).toEqual(['VIP', 'vip']);

    // Adoption flagged for "vip" — backfill will reuse the existing row.
    const adoption = orgReport.existingCrmTagAdoptions.find(
      (a) => a.normalizedName === 'vip',
    );
    expect(adoption).toBeDefined();

    // Estimated new = unique - adoption = 5 - 1 = 4
    expect(orgReport.estimatedNewCrmTagRows).toBe(4);
  });

  it('does NOT modify the database — counts before === counts after', async () => {
    const org = await seedScenario();

    const before = {
      contacts: await prisma.contact.count({ where: { orgId: org.id } }),
      crmTags: await prisma.crmTag.count({ where: { orgId: org.id } }),
      contactTags: await prisma.contactTag.count({ where: { tag: { orgId: org.id } } }),
    };

    const { runPreflight } = await import('../../prisma/scripts/0019-preflight-tags.js');
    await runPreflight();

    const after = {
      contacts: await prisma.contact.count({ where: { orgId: org.id } }),
      crmTags: await prisma.crmTag.count({ where: { orgId: org.id } }),
      contactTags: await prisma.contactTag.count({ where: { tag: { orgId: org.id } } }),
    };

    expect(after).toEqual(before);
  });
});
