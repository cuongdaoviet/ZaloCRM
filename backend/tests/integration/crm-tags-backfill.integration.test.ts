/**
 * Integration tests for feature 0019 Phase B — backfill from `contact.tags`
 * Json strings into `CrmTag` + `ContactTag`.
 *
 * Covers SPEC §7 AC-0015..AC-0018 + edge cases from §6.
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

async function seedOrg(label: string) {
  return prisma.organization.create({ data: { name: `${label} Org` } });
}

async function seedContact(orgId: string, tags: unknown, name = 'Khách') {
  return prisma.contact.create({
    data: {
      orgId,
      fullName: name,
      phone: `09${Math.floor(Math.random() * 1e9)}`,
      // Prisma's Json column accepts `unknown` — we pass things like null,
      // numbers, and arbitrary objects to exercise defensive parsing.
      tags: tags as never,
    },
  });
}

describe('Feature 0019 Phase B — backfill', () => {
  it('AC-0015: scale test — 1000 contacts × 5 tag strings produces correct row counts', async () => {
    const org = await seedOrg('Scale');
    const COUNT = 1000;
    // Tag pool — 5 distinct strings, every contact gets all 5.
    const pool = ['VIP', 'Hot', 'Cold', 'New', 'Returning'];

    // Bulk seed — createMany is faster than per-row.
    await prisma.contact.createMany({
      data: Array.from({ length: COUNT }, (_, i) => ({
        orgId: org.id,
        fullName: `Khách ${i}`,
        phone: `09${String(i).padStart(8, '0')}`,
        tags: pool,
      })),
    });

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    const report = await runBackfill({ orgId: org.id, prismaClient: prisma });

    expect(report.orgsFailed).toHaveLength(0);
    expect(report.orgsProcessed).toHaveLength(1);
    const r = report.orgsProcessed[0];
    expect(r.crmTagsAfter).toBe(pool.length);
    expect(r.contactTagsAfter).toBe(COUNT * pool.length);

    // AC-0017: usageCount matches COUNT(ContactTag) per tag.
    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    for (const t of tags) {
      const actualCount = await prisma.contactTag.count({ where: { tagId: t.id } });
      expect(t.usageCount).toBe(actualCount);
      expect(t.usageCount).toBe(COUNT);
    }
  }, 90_000);

  it('AC-0016: rerunning the backfill on identical data creates zero new rows', async () => {
    const org = await seedOrg('Idempotent');
    for (let i = 0; i < 20; i++) {
      await seedContact(org.id, ['VIP', 'Hot'], `Khách ${i}`);
    }

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    const first = await runBackfill({ orgId: org.id, prismaClient: prisma });
    expect(first.orgsFailed).toHaveLength(0);
    expect(first.orgsProcessed[0].crmTagsCreated).toBe(2);
    expect(first.orgsProcessed[0].contactTagsCreated).toBe(20 * 2);

    const tagsBefore = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    const linksBefore = await prisma.contactTag.findMany({
      where: { tag: { orgId: org.id } },
    });

    // Rerun — must be a no-op.
    const second = await runBackfill({ orgId: org.id, prismaClient: prisma });
    expect(second.orgsFailed).toHaveLength(0);
    expect(second.orgsProcessed[0].crmTagsCreated).toBe(0);
    expect(second.orgsProcessed[0].contactTagsCreated).toBe(0);

    const tagsAfter = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    const linksAfter = await prisma.contactTag.findMany({
      where: { tag: { orgId: org.id } },
    });
    expect(tagsAfter.length).toBe(tagsBefore.length);
    expect(linksAfter.length).toBe(linksBefore.length);
    // usageCount must stay stable.
    for (const t of tagsAfter) {
      const before = tagsBefore.find((b) => b.id === t.id);
      expect(t.usageCount).toBe(before!.usageCount);
    }
  });

  it('AC-0017: usageCount equals COUNT(*) from junction', async () => {
    const org = await seedOrg('Usage');
    await seedContact(org.id, ['A', 'B']);
    await seedContact(org.id, ['A']);
    await seedContact(org.id, ['A', 'B', 'C']);

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    await runBackfill({ orgId: org.id, prismaClient: prisma });

    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    const byName = new Map(tags.map((t) => [t.normalizedName, t]));
    expect(byName.get('a')?.usageCount).toBe(3);
    expect(byName.get('b')?.usageCount).toBe(2);
    expect(byName.get('c')?.usageCount).toBe(1);

    // Triple-check against the junction.
    for (const t of tags) {
      const actual = await prisma.contactTag.count({ where: { tagId: t.id } });
      expect(t.usageCount).toBe(actual);
    }
  });

  it('AC-0018: defensive parsing — null, empty-string, whitespace, and well-formed entries coexist', async () => {
    const org = await seedOrg('Defensive');
    // contact A — tags = null → JSON column actually defaults to "[]" because
    // the schema sets @default("[]"); but we can simulate via direct write.
    const cNull = await seedContact(org.id, [], 'Null contact');
    await prisma.contact.update({
      where: { id: cNull.id },
      data: { tags: null as never },
    });
    // contact B — tags = [""] (empty string entry only)
    const cEmpty = await seedContact(org.id, [''], 'Empty entry');
    // contact C — tags = [" "] (whitespace only)
    const cWs = await seedContact(org.id, [' '], 'Whitespace');
    // contact D — tags = [" abc "] (trimmed valid)
    const cTrim = await seedContact(org.id, [' abc '], 'Trim me');
    // contact E — tags = ["VIP"] (clean)
    const cClean = await seedContact(org.id, ['VIP'], 'Clean');

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    const report = await runBackfill({ orgId: org.id, prismaClient: prisma });
    expect(report.orgsFailed).toHaveLength(0);

    // Should produce exactly 2 CrmTag rows: "abc" + "VIP".
    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    const norms = tags.map((t) => t.normalizedName).sort();
    expect(norms).toEqual(['abc', 'vip']);

    // Links: cNull/cEmpty/cWs → 0 links. cTrim → "abc". cClean → "VIP".
    expect(await prisma.contactTag.count({ where: { contactId: cNull.id } })).toBe(0);
    expect(await prisma.contactTag.count({ where: { contactId: cEmpty.id } })).toBe(0);
    expect(await prisma.contactTag.count({ where: { contactId: cWs.id } })).toBe(0);
    expect(await prisma.contactTag.count({ where: { contactId: cTrim.id } })).toBe(1);
    expect(await prisma.contactTag.count({ where: { contactId: cClean.id } })).toBe(1);

    // Warnings emitted for the bad rows (null + 2x whitespace).
    const reasonsForBad = report.orgsProcessed[0].warnings.map((w) => w.reason);
    expect(reasonsForBad).toContain('tags_null_or_not_array');
    expect(reasonsForBad).toContain('whitespace_only');
  });

  it('EC: non-string entries are skipped, clean strings still backfilled, no exception', async () => {
    const org = await seedOrg('NonString');
    const c = await seedContact(org.id, [123, { foo: 'bar' }, 'VIP', null, []], 'Mixed');

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    const report = await runBackfill({ orgId: org.id, prismaClient: prisma });
    expect(report.orgsFailed).toHaveLength(0);

    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    expect(tags).toHaveLength(1);
    expect(tags[0].normalizedName).toBe('vip');

    const link = await prisma.contactTag.findFirst({
      where: { contactId: c.id, tagId: tags[0].id },
    });
    expect(link).not.toBeNull();

    const reasons = report.orgsProcessed[0].warnings.map((w) => w.reason);
    // 4 non-strings: 123, {foo:bar}, null, []
    expect(reasons.filter((r) => r === 'non_string').length).toBe(4);
  });

  it('EC: case variants "vip" / "VIP" / "Vip" collapse into one CrmTag, all 3 contacts link to it', async () => {
    const org = await seedOrg('CaseVariants');
    const a = await seedContact(org.id, ['vip'], 'A');
    const b = await seedContact(org.id, ['VIP'], 'B');
    const c = await seedContact(org.id, ['Vip'], 'C');

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    await runBackfill({ orgId: org.id, prismaClient: prisma });

    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    expect(tags).toHaveLength(1);
    expect(tags[0].normalizedName).toBe('vip');
    expect(tags[0].usageCount).toBe(3);

    for (const cid of [a.id, b.id, c.id]) {
      const link = await prisma.contactTag.findFirst({ where: { contactId: cid } });
      expect(link?.tagId).toBe(tags[0].id);
    }
  });

  it('EC: pre-existing CrmTag with matching normalizedName is adopted (no duplicate row created)', async () => {
    const org = await seedOrg('Adopt');
    // Phase A user already created a CrmTag with custom color.
    const existing = await prisma.crmTag.create({
      data: {
        orgId: org.id,
        name: 'VIP',
        normalizedName: 'vip',
        color: '#FF0000',
      },
    });
    // Two contacts with the same legacy string.
    const a = await seedContact(org.id, ['vip'], 'A');
    const b = await seedContact(org.id, ['VIP'], 'B');

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    const report = await runBackfill({ orgId: org.id, prismaClient: prisma });

    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    expect(tags).toHaveLength(1); // not 2
    expect(tags[0].id).toBe(existing.id);
    expect(tags[0].color).toBe('#FF0000'); // original color preserved
    expect(tags[0].usageCount).toBe(2);

    const linkA = await prisma.contactTag.findFirst({ where: { contactId: a.id } });
    const linkB = await prisma.contactTag.findFirst({ where: { contactId: b.id } });
    expect(linkA?.tagId).toBe(existing.id);
    expect(linkB?.tagId).toBe(existing.id);

    expect(report.orgsProcessed[0].crmTagsCreated).toBe(0);
  });

  it('EC: cross-org isolation — org A strings do not leak into org B', async () => {
    const orgA = await seedOrg('AlphaA');
    const orgB = await seedOrg('AlphaB');
    await seedContact(orgA.id, ['SharedName'], 'A1');
    await seedContact(orgB.id, ['SharedName'], 'B1');

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    const report = await runBackfill({ prismaClient: prisma });

    const aTags = await prisma.crmTag.findMany({ where: { orgId: orgA.id } });
    const bTags = await prisma.crmTag.findMany({ where: { orgId: orgB.id } });
    expect(aTags).toHaveLength(1);
    expect(bTags).toHaveLength(1);
    expect(aTags[0].id).not.toBe(bTags[0].id);
    expect(aTags[0].orgId).toBe(orgA.id);
    expect(bTags[0].orgId).toBe(orgB.id);
    expect(report.orgsProcessed.length).toBeGreaterThanOrEqual(2);
  });

  it('EC: oversize tag (>50 chars) gets truncated to 50 with a warning', async () => {
    const org = await seedOrg('Oversize');
    const longTag = 'A'.repeat(80); // 80 chars
    const c = await seedContact(org.id, [longTag], 'Big');

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    const report = await runBackfill({ orgId: org.id, prismaClient: prisma });

    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    expect(tags).toHaveLength(1);
    expect(tags[0].name.length).toBe(50);
    expect(tags[0].normalizedName.length).toBe(50);

    const link = await prisma.contactTag.findFirst({ where: { contactId: c.id } });
    expect(link).not.toBeNull();

    const reasons = report.orgsProcessed[0].warnings.map((w) => w.reason);
    expect(reasons).toContain('oversize_truncated');
  });

  it('dry-run mode: rolls back all writes; DB unchanged after run', async () => {
    const org = await seedOrg('DryRun');
    await seedContact(org.id, ['VIP', 'Hot'], 'A');
    await seedContact(org.id, ['Cold'], 'B');

    const crmBefore = await prisma.crmTag.count({ where: { orgId: org.id } });
    const ctBefore = await prisma.contactTag.count({ where: { tag: { orgId: org.id } } });
    expect(crmBefore).toBe(0);
    expect(ctBefore).toBe(0);

    const { runBackfill } = await import('../../prisma/scripts/0019-backfill-tags.js');
    const report = await runBackfill({
      orgId: org.id,
      dryRun: true,
      prismaClient: prisma,
    });
    expect(report.dryRun).toBe(true);
    expect(report.orgsFailed).toHaveLength(0);

    // DB must be unchanged.
    const crmAfter = await prisma.crmTag.count({ where: { orgId: org.id } });
    const ctAfter = await prisma.contactTag.count({ where: { tag: { orgId: org.id } } });
    expect(crmAfter).toBe(0);
    expect(ctAfter).toBe(0);
  });
});
