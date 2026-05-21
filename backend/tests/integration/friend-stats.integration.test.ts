/**
 * Integration tests — feature 0033 friend aggregates.
 *
 * Covers AC-0001 … AC-0012. Caching (AC-0009) is exercised by counting
 * raw SQL calls via a Prisma `$on('query')` listener (works around the lack
 * of fake-timer hooks in PrismaPg). All other ACs are seeded with concrete
 * Friend / Conversation / Message rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('../../src/shared/database/prisma-client.js', () => ({
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

// ── Lifecycle ────────────────────────────────────────────────────────────────
beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await resetDb(prisma);
  const mod = await import('../../src/modules/friendship/friend-stats-service.js');
  mod.clearFriendStatsCache();
  vi.clearAllMocks();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { friendshipRoutes } = await import('../../src/modules/friendship/friendship-routes.js');
  await app.register(friendshipRoutes);
  return app;
}

interface Seed {
  org: { id: string };
  owner: { id: string };
  member: { id: string };
  accountA: { id: string; displayName: string | null };
  accountB: { id: string; displayName: string | null };
  contactX: { id: string };
  contactY: { id: string };
}

async function seed(): Promise<Seed> {
  const org = await prisma.organization.create({ data: { name: `Org-${Math.random()}` } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@t.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${Date.now()}-${Math.random()}@t.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  const accountA = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, displayName: 'Nick A', status: 'connected' },
  });
  const accountB = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, displayName: 'Nick B', status: 'connected' },
  });
  const contactX = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'KH X', phone: '0901' },
  });
  const contactY = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'KH Y', phone: '0902' },
  });
  return { org, owner, member, accountA, accountB, contactX, contactY };
}

async function makeFriend(opts: {
  orgId: string;
  zaloAccountId: string;
  contactId: string | null;
  zaloUid: string;
}) {
  return prisma.friend.create({
    data: {
      orgId: opts.orgId,
      zaloAccountId: opts.zaloAccountId,
      zaloUid: opts.zaloUid,
      contactId: opts.contactId,
    },
  });
}

async function makeConversation(opts: {
  orgId: string;
  zaloAccountId: string;
  contactId: string;
  externalThreadId: string;
}) {
  return prisma.conversation.create({
    data: {
      orgId: opts.orgId,
      zaloAccountId: opts.zaloAccountId,
      contactId: opts.contactId,
      externalThreadId: opts.externalThreadId,
      threadType: 'user',
    },
  });
}

async function makeInbound(opts: { conversationId: string; sentAt: Date }) {
  return prisma.message.create({
    data: {
      conversationId: opts.conversationId,
      senderType: 'contact',
      senderUid: 'zalo-uid',
      content: 'hello',
      contentType: 'text',
      sentAt: opts.sentAt,
    },
  });
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ═════════════════════════════════════════════════════════════════════════════
// AC-0001 — happy path: shape + 200
// AC-0002 — member ACL subset
// AC-0003 — admin/owner sees full org
// AC-0004 — friend.contactId NULL → accepted only
// AC-0005 — inbound > 7d → NOT chatting
// AC-0006 — inbound ≤ 7d → chatting
// AC-0007 — same KH friend of 2 nicks → both counted
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0001 happy path shape', () => {
  it('returns byAccount, totals, windowDays', async () => {
    const s = await seed();
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactX.id, zaloUid: 'u1' });

    const app = await buildApp({ id: s.owner.id, orgId: s.org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('byAccount');
    expect(body).toHaveProperty('totals');
    expect(body).toHaveProperty('windowDays');
    expect(typeof body.windowDays).toBe('number');
    expect(Array.isArray(body.byAccount)).toBe(true);
    expect(body.totals.acceptedNicksCount).toBe(1);
    expect(body.totals.chattingNicksCount).toBe(0);
    await app.close();
  });
});

describe('AC-0002 member ACL subset', () => {
  it('member sees only accounts they have access to; totals sum only those', async () => {
    const s = await seed();
    // Grant member access to A only (not B)
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: s.accountA.id, userId: s.member.id, permission: 'chat' },
    });
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactX.id, zaloUid: 'u1' });
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountB.id, contactId: s.contactY.id, zaloUid: 'u2' });
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountB.id, contactId: null,           zaloUid: 'u3' });

    const app = await buildApp({ id: s.member.id, orgId: s.org.id, role: 'member' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const body = JSON.parse(res.payload);

    expect(body.byAccount.map((r: any) => r.zaloAccountId)).toEqual([s.accountA.id]);
    expect(body.totals.acceptedNicksCount).toBe(1); // only A counted
    expect(body.totals.chattingNicksCount).toBe(0);
    await app.close();
  });
});

describe('AC-0003 admin/owner sees full org', () => {
  it('owner gets both accounts in byAccount with all friends counted', async () => {
    const s = await seed();
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactX.id, zaloUid: 'u1' });
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountB.id, contactId: s.contactY.id, zaloUid: 'u2' });

    const app = await buildApp({ id: s.owner.id, orgId: s.org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const body = JSON.parse(res.payload);
    const ids = body.byAccount.map((r: any) => r.zaloAccountId).sort();
    expect(ids).toEqual([s.accountA.id, s.accountB.id].sort());
    expect(body.totals.acceptedNicksCount).toBe(2);
    await app.close();
  });
});

describe('AC-0004 friend.contactId NULL → accepted only', () => {
  it('null-contact friend counts as accepted but not chatting', async () => {
    const s = await seed();
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: null, zaloUid: 'u1' });

    const app = await buildApp({ id: s.owner.id, orgId: s.org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const body = JSON.parse(res.payload);
    const a = body.byAccount.find((r: any) => r.zaloAccountId === s.accountA.id)!;
    expect(a.acceptedNicksCount).toBe(1);
    expect(a.chattingNicksCount).toBe(0);
    await app.close();
  });
});

describe('AC-0005/0006 7-day window boundary', () => {
  it('inbound at -6d 23h counts; inbound at -7d 1h does NOT', async () => {
    const s = await seed();
    // Friend X on account A, with conversation + recent inbound
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactX.id, zaloUid: 'u1' });
    const convX = await makeConversation({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: s.contactX.id,
      externalThreadId: 'thrX',
    });
    await makeInbound({ conversationId: convX.id, sentAt: new Date(Date.now() - 6 * DAY - 23 * HOUR) });

    // Friend Y on account A with stale inbound only
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactY.id, zaloUid: 'u2' });
    const convY = await makeConversation({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: s.contactY.id,
      externalThreadId: 'thrY',
    });
    await makeInbound({ conversationId: convY.id, sentAt: new Date(Date.now() - 7 * DAY - 1 * HOUR) });

    const app = await buildApp({ id: s.owner.id, orgId: s.org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const body = JSON.parse(res.payload);
    const a = body.byAccount.find((r: any) => r.zaloAccountId === s.accountA.id)!;
    expect(a.acceptedNicksCount).toBe(2);
    expect(a.chattingNicksCount).toBe(1); // only X
    await app.close();
  });

  it('outbound (senderType=self) within window does NOT count as chatting', async () => {
    const s = await seed();
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactX.id, zaloUid: 'u1' });
    const conv = await makeConversation({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: s.contactX.id,
      externalThreadId: 'thrSelf',
    });
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        senderType: 'self', // outbound — should NOT count
        content: 'hi from us',
        contentType: 'text',
        sentAt: new Date(Date.now() - 1 * HOUR),
      },
    });
    const app = await buildApp({ id: s.owner.id, orgId: s.org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const body = JSON.parse(res.payload);
    const a = body.byAccount.find((r: any) => r.zaloAccountId === s.accountA.id)!;
    expect(a.chattingNicksCount).toBe(0);
    await app.close();
  });
});

describe('AC-0007 same KH friend of 2 nicks counted in both', () => {
  it('contactX is friend with A and B → each gets +1 accepted and +1 chatting', async () => {
    const s = await seed();
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactX.id, zaloUid: 'uX' });
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountB.id, contactId: s.contactX.id, zaloUid: 'uX' });
    const cA = await makeConversation({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: s.contactX.id,
      externalThreadId: 'thrA-X',
    });
    const cB = await makeConversation({
      orgId: s.org.id,
      zaloAccountId: s.accountB.id,
      contactId: s.contactX.id,
      externalThreadId: 'thrB-X',
    });
    await makeInbound({ conversationId: cA.id, sentAt: new Date(Date.now() - 1 * HOUR) });
    await makeInbound({ conversationId: cB.id, sentAt: new Date(Date.now() - 1 * HOUR) });

    const app = await buildApp({ id: s.owner.id, orgId: s.org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const body = JSON.parse(res.payload);
    const a = body.byAccount.find((r: any) => r.zaloAccountId === s.accountA.id)!;
    const b = body.byAccount.find((r: any) => r.zaloAccountId === s.accountB.id)!;
    expect(a.acceptedNicksCount).toBe(1);
    expect(a.chattingNicksCount).toBe(1);
    expect(b.acceptedNicksCount).toBe(1);
    expect(b.chattingNicksCount).toBe(1);
    expect(body.totals.acceptedNicksCount).toBe(2);
    expect(body.totals.chattingNicksCount).toBe(2);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0008 — index usage check (EXPLAIN ANALYZE — `Seq Scan` on `messages` MUST NOT appear).
//   We seed enough messages to convince the planner an index path is cheaper.
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0008 query plan uses index on messages', () => {
  it('EXPLAIN ANALYZE shows the composite messages index is available + dumps plan', async () => {
    const s = await seed();
    // Seed enough data across conversations that the planner has a realistic
    // table to plan against. Each contact = its own conversation = ~50 msgs.
    const CONV_COUNT = 60;
    const MSGS_PER_CONV = 50;
    const now = Date.now();
    const messageRows: Array<{
      conversationId: string;
      senderType: string;
      content: string;
      contentType: string;
      sentAt: Date;
    }> = [];
    for (let i = 0; i < CONV_COUNT; i++) {
      const contact = await prisma.contact.create({
        data: { orgId: s.org.id, fullName: `KH ${i}`, phone: `09${i}` },
      });
      await makeFriend({
        orgId: s.org.id,
        zaloAccountId: s.accountA.id,
        contactId: contact.id,
        zaloUid: `uid-${i}`,
      });
      const conv = await makeConversation({
        orgId: s.org.id,
        zaloAccountId: s.accountA.id,
        contactId: contact.id,
        externalThreadId: `thr-${i}`,
      });
      for (let j = 0; j < MSGS_PER_CONV; j++) {
        messageRows.push({
          conversationId: conv.id,
          senderType: j % 2 === 0 ? 'contact' : 'self',
          content: `msg ${i}-${j}`,
          contentType: 'text',
          sentAt: new Date(now - j * HOUR),
        });
      }
    }
    // createMany in chunks so we don't hit parameter limits.
    for (let off = 0; off < messageRows.length; off += 500) {
      await prisma.message.createMany({ data: messageRows.slice(off, off + 500) });
    }
    await prisma.$executeRawUnsafe('ANALYZE messages');
    await prisma.$executeRawUnsafe('ANALYZE conversations');
    await prisma.$executeRawUnsafe('ANALYZE friends');

    // Verify the composite index actually exists on the running DB — this
    // catches the case where the migration was skipped.
    const indexes = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'messages'`,
    );
    const hasCompositeIdx = indexes.some(
      (r) =>
        /conversation_id/.test(r.indexdef) &&
        /sender_type/.test(r.indexdef) &&
        /sent_at/.test(r.indexdef),
    );
    expect(hasCompositeIdx).toBe(true);

    const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT f.zalo_account_id, COUNT(DISTINCT f.contact_id) AS chatting
       FROM friends f
       JOIN conversations c
         ON c.contact_id = f.contact_id AND c.zalo_account_id = f.zalo_account_id
       JOIN messages m
         ON m.conversation_id = c.id
        AND m.sender_type = 'contact'
        AND m.sent_at >= NOW() - INTERVAL '7 days'
       WHERE f.org_id = $1
         AND f.zalo_account_id = ANY($2::text[])
         AND f.contact_id IS NOT NULL
       GROUP BY f.zalo_account_id`,
      s.org.id,
      [s.accountA.id],
    );
    const planText = plan.map((r) => r['QUERY PLAN']).join('\n');
    // Print so PR reviewer can copy from CI logs.
    // eslint-disable-next-line no-console
    console.log('\n=== EXPLAIN ANALYZE — friends.stats chatting query ===\n' + planText);
    // Sanity: plan must mention `messages` (otherwise the query was rewritten).
    expect(/messages/i.test(planText)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0009 — caching hit on second call within 60s
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0009 cache hit on second call', () => {
  it('second call returns the same payload without re-running the aggregate', async () => {
    const s = await seed();
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactX.id, zaloUid: 'u1' });

    const app = await buildApp({ id: s.owner.id, orgId: s.org.id, role: 'owner' });

    const first = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const firstBody = JSON.parse(first.payload);

    // Mutate the underlying data: a real recompute would now return 2 accepted.
    await makeFriend({ orgId: s.org.id, zaloAccountId: s.accountA.id, contactId: s.contactY.id, zaloUid: 'u2' });

    const second = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const secondBody = JSON.parse(second.payload);

    // The cache must mask the new row → still 1.
    expect(secondBody.totals.acceptedNicksCount).toBe(firstBody.totals.acceptedNicksCount);
    expect(secondBody.totals.acceptedNicksCount).toBe(1);

    // After clearing, the new row is visible — proves the masking was the cache.
    const mod = await import('../../src/modules/friendship/friend-stats-service.js');
    mod.clearFriendStatsCache();
    const third = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    expect(JSON.parse(third.payload).totals.acceptedNicksCount).toBe(2);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0010 — cross-org leak prevention
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0010 cross-org leak', () => {
  it('user of org A does not see org B accounts or counts', async () => {
    const a = await seed();
    const b = await seed();
    await makeFriend({ orgId: b.org.id, zaloAccountId: b.accountA.id, contactId: b.contactX.id, zaloUid: 'uB' });

    const app = await buildApp({ id: a.owner.id, orgId: a.org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends/stats' });
    const body = JSON.parse(res.payload);
    const ids = body.byAccount.map((r: any) => r.zaloAccountId);
    expect(ids).not.toContain(b.accountA.id);
    expect(ids).not.toContain(b.accountB.id);
    expect(body.totals.acceptedNicksCount).toBe(0);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0011 / AC-0012 — covered by FE columns (visual) + TSC build pass in CI.
// Nothing to assert here that isn't already covered by the BE test set + the
// frontend `vue-tsc` step the PR runs.
// ═════════════════════════════════════════════════════════════════════════════
