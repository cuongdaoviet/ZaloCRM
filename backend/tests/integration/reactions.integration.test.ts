/**
 * Integration tests — feature 0021 message reactions.
 *
 * Coverage: every AC from SPEC §6 (AC-0001 … AC-0015).
 *
 * Strategy:
 *   - Real Postgres via setup-db.
 *   - Fastify `inject` for the 3 HTTP endpoints.
 *   - zca-js boundary mocked via `zaloPool.getInstance().api.addReaction`.
 *   - For listener tests we call `handleReactionEvent()` directly with a
 *     hand-rolled payload — we never wait for an actual zca-js event.
 *   - For socket assertions we mock `io.emit` with `vi.fn()` and pass it
 *     to the listener.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// ── Mocks ────────────────────────────────────────────────────────────────────
const addReactionMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: { addReaction: addReactionMock } })),
};

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: zaloPoolMock }));
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
  vi.clearAllMocks();
  addReactionMock.mockResolvedValue({ msgIds: [1] });
  zaloPoolMock.getInstance.mockReturnValue({
    api: { addReaction: addReactionMock },
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { reactionRoutes } = await import(
    '../../src/modules/reactions/reaction-routes.js'
  );
  await app.register(reactionRoutes);
  return app;
}

interface Seed {
  org: { id: string };
  owner: { id: string; orgId: string; role: 'owner' };
  member: { id: string; orgId: string; role: 'member' };
  account: { id: string; zaloUid: string };
  conversation: { id: string };
  message: { id: string; zaloMsgId: string };
}

async function seed(opts: { isDeleted?: boolean; zaloMsgId?: string | null } = {}): Promise<Seed> {
  const tag = Math.random().toString(36).slice(2, 8);
  const org = await prisma.organization.create({ data: { name: `R Org ${tag}` } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${tag}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner Name',
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${tag}@test.local`,
      passwordHash: 'h',
      fullName: 'Member Name',
      role: 'member',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: owner.id,
      status: 'connected',
      zaloUid: `zuid-${tag}`,
      displayName: 'Test Account',
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      threadType: 'user',
      externalThreadId: `thread-${tag}`,
    },
  });
  const zaloMsgId = opts.zaloMsgId === undefined ? `zmsg-${tag}` : opts.zaloMsgId;
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      zaloMsgId,
      senderType: 'contact',
      senderUid: 'sender-uid',
      senderName: 'KH',
      content: 'hello',
      contentType: 'text',
      sentAt: new Date(),
      isDeleted: opts.isDeleted ?? false,
    },
  });
  return {
    org: { id: org.id },
    owner: { id: owner.id, orgId: org.id, role: 'owner' },
    member: { id: member.id, orgId: org.id, role: 'member' },
    account: { id: account.id, zaloUid: account.zaloUid! },
    conversation: { id: conversation.id },
    message: { id: message.id, zaloMsgId: zaloMsgId ?? '' },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// AC-0001 — POST first reaction → 201 + DB row + zca-js called
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0001 POST first reaction', () => {
  it('creates a row and calls zca-js addReaction with HEART enum', async () => {
    const s = await seed();
    const app = await buildApp(s.owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.emoji).toBe('❤️');
    expect(body.reactorId).toBe(s.owner.id);
    expect(body.reactorSource).toBe('crm');
    expect(body.reactorName).toBe('Owner Name');

    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe('❤️');

    expect(addReactionMock).toHaveBeenCalledTimes(1);
    const [icon, dest] = addReactionMock.mock.calls[0];
    expect(icon).toBe('/-heart');
    expect(dest.threadId).toBe((await prisma.conversation.findUnique({ where: { id: s.conversation.id } }))?.externalThreadId);
    expect(dest.data.msgId).toBe(s.message.zaloMsgId);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0002 — POST same emoji twice → toggle off
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0002 toggle-off on repeat', () => {
  it('returns 200 toggledOff and removes the row + sends NONE', async () => {
    const s = await seed();
    const app = await buildApp(s.owner);
    // First react
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(first.statusCode).toBe(201);
    // Same emoji again
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(second.statusCode).toBe(200);
    const body = JSON.parse(second.payload);
    expect(body.toggledOff).toBe(true);
    expect(body.emoji).toBe('❤️');

    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(0);

    // Both zca-js calls happened — first HEART, second NONE
    expect(addReactionMock).toHaveBeenCalledTimes(2);
    expect(addReactionMock.mock.calls[1][0]).toBe('');
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0003 — POST different emoji → override + LIKE enum
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0003 override on different emoji', () => {
  it('updates the row and sends LIKE enum to zca-js', async () => {
    const s = await seed();
    const app = await buildApp(s.owner);
    await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    const switched = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '👍' },
    });
    expect(switched.statusCode).toBe(201);
    const body = JSON.parse(switched.payload);
    expect(body.emoji).toBe('👍');

    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe('👍');

    expect(addReactionMock).toHaveBeenCalledTimes(2);
    expect(addReactionMock.mock.calls[1][0]).toBe('/-strong');
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0004 — invalid emoji → 400 invalid_emoji
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0004 invalid emoji', () => {
  it('rejects an emoji outside the 6 standard set', async () => {
    const s = await seed();
    const app = await buildApp(s.owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '🤔' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('invalid_emoji');
    expect(addReactionMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0005 — POST on isDeleted message → 400 message_deleted
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0005 react on deleted message', () => {
  it('rejects with message_deleted', async () => {
    const s = await seed({ isDeleted: true });
    const app = await buildApp(s.owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('message_deleted');
    expect(addReactionMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0006 — member without ACL chat → 403
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0006 member without chat ACL', () => {
  it('member without ZaloAccountAccess is denied 403', async () => {
    const s = await seed();
    const app = await buildApp(s.member);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(403);
    expect(addReactionMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('member with only read access is denied for POST', async () => {
    const s = await seed();
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: s.account.id, userId: s.member.id, permission: 'read' },
    });
    const app = await buildApp(s.member);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('member with chat access can react', async () => {
    const s = await seed();
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: s.account.id, userId: s.member.id, permission: 'chat' },
    });
    const app = await buildApp(s.member);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0007 — cross-org POST → 404
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0007 cross-org isolation', () => {
  it('POST from another org returns 404 (existence not leaked)', async () => {
    const s = await seed();
    const otherOrg = await prisma.organization.create({ data: { name: 'Other org' } });
    const otherOwner = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `oo-${Math.random()}@test.local`,
        passwordHash: 'h',
        fullName: 'Other',
        role: 'owner',
      },
    });
    const app = await buildApp({ id: otherOwner.id, orgId: otherOrg.id, role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(404);
    expect(addReactionMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0008 — Listener inbound: rType=1 → row upserted + socket emit
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0008 listener upsert', () => {
  it('persists a reactorSource=zalo row and fires chat:reaction socket', async () => {
    const s = await seed();
    const ioEmit = vi.fn();
    const io = { emit: ioEmit } as unknown as import('socket.io').Server;
    const { handleReactionEvent } = await import(
      '../../src/modules/reactions/reaction-listener.ts'
    );
    await handleReactionEvent(
      s.account.id,
      {
        data: {
          msgId: s.message.zaloMsgId,
          uidFrom: 'sender-uid',
          dName: 'KH',
          content: { rType: 1, rIcon: '/-heart' },
        },
        threadId: 'thread',
        isSelf: false,
      },
      io,
    );

    // Drain background socket emit microtask
    const { flushBackgroundTasks } = await import(
      '../../src/shared/utils/background-tasks.js'
    );
    await flushBackgroundTasks();

    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reactorSource).toBe('zalo');
    expect(rows[0].reactorId).toBe('sender-uid');
    expect(rows[0].emoji).toBe('❤️');
    expect(rows[0].reactorName).toBe('KH');

    expect(ioEmit).toHaveBeenCalledTimes(1);
    const [event, payload] = ioEmit.mock.calls[0];
    expect(event).toBe('chat:reaction');
    expect(payload.messageId).toBe(s.message.id);
    expect(payload.conversationId).toBe(s.conversation.id);
    expect(payload.reaction.emoji).toBe('❤️');
  });

  it('isSelf=true uses ZaloAccount.zaloUid as reactorId (BR-0008)', async () => {
    const s = await seed();
    const ioEmit = vi.fn();
    const io = { emit: ioEmit } as unknown as import('socket.io').Server;
    const { handleReactionEvent } = await import(
      '../../src/modules/reactions/reaction-listener.ts'
    );
    await handleReactionEvent(
      s.account.id,
      {
        data: {
          msgId: s.message.zaloMsgId,
          uidFrom: '0',
          content: { rType: 2, rIcon: '/-strong' },
        },
        threadId: 'thread',
        isSelf: true,
      },
      io,
    );
    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reactorId).toBe(s.account.zaloUid);
    expect(rows[0].reactorSource).toBe('zalo');
    expect(rows[0].emoji).toBe('👍');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0009 — Listener rType=0 → delete row + socket null
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0009 listener unreact', () => {
  it('deletes the row and emits reaction:null', async () => {
    const s = await seed();
    // Pre-existing reaction from contact
    await prisma.messageReaction.create({
      data: {
        messageId: s.message.id,
        reactorId: 'sender-uid',
        reactorSource: 'zalo',
        emoji: '❤️',
      },
    });

    const ioEmit = vi.fn();
    const io = { emit: ioEmit } as unknown as import('socket.io').Server;
    const { handleReactionEvent } = await import(
      '../../src/modules/reactions/reaction-listener.ts'
    );
    await handleReactionEvent(
      s.account.id,
      {
        data: {
          msgId: s.message.zaloMsgId,
          uidFrom: 'sender-uid',
          content: { rType: 0, rIcon: '' },
        },
        isSelf: false,
      },
      io,
    );
    const { flushBackgroundTasks } = await import(
      '../../src/shared/utils/background-tasks.js'
    );
    await flushBackgroundTasks();

    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(0);

    expect(ioEmit).toHaveBeenCalledTimes(1);
    const payload = ioEmit.mock.calls[0][1];
    expect(payload.reaction).toBeNull();
    expect(payload.removed.reactorId).toBe('sender-uid');
    expect(payload.removed.reactorSource).toBe('zalo');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0010 — Listener message unknown locally → no-op (EC-0001)
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0010 listener drops events for unknown msgId', () => {
  it('does not crash and does not insert a phantom row', async () => {
    const s = await seed();
    const ioEmit = vi.fn();
    const io = { emit: ioEmit } as unknown as import('socket.io').Server;
    const { handleReactionEvent } = await import(
      '../../src/modules/reactions/reaction-listener.ts'
    );
    await handleReactionEvent(
      s.account.id,
      {
        data: {
          msgId: 'NO_SUCH_MSG_ID',
          uidFrom: 'sender-uid',
          content: { rType: 1, rIcon: '/-heart' },
        },
        isSelf: false,
      },
      io,
    );
    const rows = await prisma.messageReaction.findMany();
    expect(rows).toHaveLength(0);
    expect(ioEmit).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0011 — GET /messages/:id/reactions returns the list, respects ACL
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0011 GET list reactions', () => {
  it('owner sees all reactions on a message', async () => {
    const s = await seed();
    await prisma.messageReaction.createMany({
      data: [
        { messageId: s.message.id, reactorId: 'u1', reactorSource: 'zalo', emoji: '❤️' },
        { messageId: s.message.id, reactorId: 'u2', reactorSource: 'zalo', emoji: '👍' },
      ],
    });
    const app = await buildApp(s.owner);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/messages/${s.message.id}/reactions`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.reactions).toHaveLength(2);
    const emojis = body.reactions.map((r: { emoji: string }) => r.emoji).sort();
    expect(emojis).toEqual(['❤️', '👍']);
    await app.close();
  });

  it('GET cross-org → 404', async () => {
    const s = await seed();
    const otherOrg = await prisma.organization.create({ data: { name: 'Other GET' } });
    const otherOwner = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `og-${Math.random()}@test.local`,
        passwordHash: 'h',
        fullName: 'Other',
        role: 'owner',
      },
    });
    const app = await buildApp({ id: otherOwner.id, orgId: otherOrg.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/messages/${s.message.id}/reactions`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('member without read ACL → 403', async () => {
    const s = await seed();
    const app = await buildApp(s.member);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/messages/${s.message.id}/reactions`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0012 — listener throws inside → caught, no crash
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0012 listener swallows all errors', () => {
  it('does not throw even when prisma misbehaves', async () => {
    const { handleReactionEvent } = await import(
      '../../src/modules/reactions/reaction-listener.ts'
    );
    // Pass an entirely malformed event — the function MUST resolve.
    await expect(
      handleReactionEvent('any-account', null as unknown as Parameters<typeof handleReactionEvent>[1]),
    ).resolves.toBeUndefined();
    await expect(
      handleReactionEvent('any-account', {} as Parameters<typeof handleReactionEvent>[1]),
    ).resolves.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0013 — zca-js addReaction throws → DB rollback + 502
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0013 zca-js failure rolls back DB write', () => {
  it('throws inside the transaction → no row persists + 502', async () => {
    const s = await seed();
    addReactionMock.mockRejectedValueOnce(new Error('zca-js boom'));

    const app = await buildApp(s.owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).code).toBe('zalo_reaction_failed');

    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(0);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0014 — 2 reps react 👍 same message → 2 rows
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0014 two reps coexist', () => {
  it('two CRM users react with the same emoji → 2 distinct rows', async () => {
    const s = await seed();
    // Give member chat access so both users can react
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: s.account.id, userId: s.member.id, permission: 'chat' },
    });

    const appA = await buildApp(s.owner);
    const r1 = await appA.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '👍' },
    });
    expect(r1.statusCode).toBe(201);
    await appA.close();

    const appB = await buildApp(s.member);
    const r2 = await appB.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '👍' },
    });
    expect(r2.statusCode).toBe(201);
    await appB.close();

    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.reactorId))).toEqual(new Set([s.owner.id, s.member.id]));
    for (const r of rows) {
      expect(r.emoji).toBe('👍');
      expect(r.reactorSource).toBe('crm');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0015 — build / suite stability (covered by the runner; meta-AC).
// No assertion: passing this file + the rest of the suite IS the AC.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// EC-0002 — message_missing_zalo_msg_id when outbound message not yet acked
// ═════════════════════════════════════════════════════════════════════════════
describe('EC-0002 message without zaloMsgId yet', () => {
  it('returns 400 message_missing_zalo_msg_id', async () => {
    const s = await seed({ zaloMsgId: null });
    const app = await buildApp(s.owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${s.message.id}/reactions`,
      payload: { emoji: '❤️' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('message_missing_zalo_msg_id');
    expect(addReactionMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DELETE endpoint — idempotent, sends NONE
// ═════════════════════════════════════════════════════════════════════════════
describe('DELETE /messages/:id/reactions — idempotent', () => {
  it('removes the caller reaction and sends NONE to zca-js', async () => {
    const s = await seed();
    await prisma.messageReaction.create({
      data: {
        messageId: s.message.id,
        reactorId: s.owner.id,
        reactorSource: 'crm',
        reactorName: 'Owner Name',
        emoji: '❤️',
      },
    });
    const app = await buildApp(s.owner);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/messages/${s.message.id}/reactions`,
    });
    expect(res.statusCode).toBe(204);
    const rows = await prisma.messageReaction.findMany({ where: { messageId: s.message.id } });
    expect(rows).toHaveLength(0);
    expect(addReactionMock).toHaveBeenCalledTimes(1);
    expect(addReactionMock.mock.calls[0][0]).toBe('');
    await app.close();
  });

  it('DELETE when no reaction exists is still 204', async () => {
    const s = await seed();
    const app = await buildApp(s.owner);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/messages/${s.message.id}/reactions`,
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// chat list-messages includes reactions inline
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /conversations/:id/messages now includes reactions', () => {
  it('returns reactions array on each message', async () => {
    const s = await seed();
    await prisma.messageReaction.create({
      data: {
        messageId: s.message.id,
        reactorId: 'someone',
        reactorSource: 'zalo',
        emoji: '❤️',
      },
    });
    // Stand-up the chat routes Fastify instance the same way the friendship
    // test does — they share the mocked auth + prisma.
    const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
    const app = Fastify();
    app.addHook('onRequest', async (req: any) => {
      req.user = s.owner;
    });
    await app.register(chatRoutes);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${s.conversation.id}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Array.isArray(body.messages)).toBe(true);
    const m = body.messages.find((x: { id: string }) => x.id === s.message.id);
    expect(m).toBeTruthy();
    expect(m.reactions).toHaveLength(1);
    expect(m.reactions[0].emoji).toBe('❤️');
    await app.close();
  });
});
