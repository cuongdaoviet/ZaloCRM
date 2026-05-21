/**
 * Integration tests for feature 0037 — workflow automation engine (phase 1).
 *
 * Covers all 11 acceptance criteria:
 *  - AC-0001 (schema migration): implicitly via prisma db push + queries below
 *  - AC-0002 (POST admin → 201)
 *  - AC-0003 (POST member → 403)
 *  - AC-0004 (inbound match → execution row)
 *  - AC-0005 (send_message executor)
 *  - AC-0006 (wait executor + nextStepDueAt)
 *  - AC-0007 (add_tag executor)
 *  - AC-0008 (assign_user executor)
 *  - AC-0009 (failed step → execution status='failed' + error in stepLog)
 *  - AC-0010 (24h cooldown — no double-execution)
 *  - AC-0011 (build pass — verified at CI step `npm run build`)
 *
 * Pattern mirrors existing auto-reply / keyword-rule integration tests:
 * real Postgres via testcontainers, Fastify inject for HTTP, zca-js mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

const sendMessageMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: { sendMessage: sendMessageMock } })),
};

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
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
    if (!req.user) req.user = { id: 't', orgId: 'o', role: 'admin' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function seed() {
  const org = await prisma.organization.create({ data: { name: 'WF Org' } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const admin = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `a-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Admin',
      role: 'admin',
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
  const account = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: owner.id,
      status: 'connected',
      zaloUid: 'self-uid',
    },
  });
  const contact = await prisma.contact.create({
    data: {
      orgId: org.id,
      zaloUid: 'contact-uid-1',
      fullName: 'Nguyễn Văn A',
      status: 'new',
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contact.id,
      externalThreadId: 'thread-1',
      threadType: 'user',
      unreadCount: 0,
    },
  });
  return { org, owner, admin, member, account, contact, conversation };
}

async function buildDefinitionApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { workflowDefinitionRoutes } = await import(
    '../../src/modules/workflow/definition-routes.js'
  );
  await app.register(workflowDefinitionRoutes);
  return app;
}

async function buildExecutionApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { workflowExecutionRoutes } = await import(
    '../../src/modules/workflow/execution-routes.js'
  );
  await app.register(workflowExecutionRoutes);
  return app;
}

describe('Workflow definition routes', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    zaloPoolMock.getInstance.mockReturnValue({
      api: { sendMessage: sendMessageMock },
    });
  });

  it('AC-0002: admin POST /workflows → 201 + DB row', async () => {
    const { org, admin } = await seed();
    const app = await buildDefinitionApp({ id: admin.id, orgId: org.id, role: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: {
        name: 'Welcome New Lead',
        description: 'Auto greet new leads',
        trigger: { type: 'inbound_message', isFirstInbound: true },
        steps: [
          { type: 'send_message', content: 'Chào {{contactName}}!' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.name).toBe('Welcome New Lead');
    expect(body.isActive).toBe(true);
    expect(await prisma.workflowDefinition.count()).toBe(1);
    await app.close();
  });

  it('AC-0003: member POST → 403', async () => {
    const { org, member } = await seed();
    const app = await buildDefinitionApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: {
        name: 'X',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'hello' }],
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('validation: empty steps → 400', async () => {
    const { org, admin } = await seed();
    const app = await buildDefinitionApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: {
        name: 'Empty',
        trigger: { type: 'inbound_message' },
        steps: [],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('validation: unknown step.type → 400', async () => {
    const { org, admin } = await seed();
    const app = await buildDefinitionApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: {
        name: 'X',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_smoke_signal', content: 'x' }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('assign_user validates userId belongs to org', async () => {
    const { org, admin } = await seed();
    const orgB = await prisma.organization.create({ data: { name: 'Other' } });
    const outside = await prisma.user.create({
      data: {
        orgId: orgB.id,
        email: `x-${Date.now()}@x.local`,
        passwordHash: 'h',
        fullName: 'X',
        role: 'member',
      },
    });
    const app = await buildDefinitionApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: {
        name: 'X',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'assign_user', userId: outside.id }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('GET list returns workflows for org only (cross-org isolation)', async () => {
    const { org, admin } = await seed();
    const orgB = await prisma.organization.create({ data: { name: 'B' } });
    await prisma.workflowDefinition.create({
      data: {
        orgId: orgB.id,
        name: 'OtherOrgWf',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'x' }],
      },
    });
    const app = await buildDefinitionApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/workflows' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).workflows).toHaveLength(0);
    await app.close();
  });

  it('PUT updates a workflow', async () => {
    const { org, admin } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'v1',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'old' }],
      },
    });
    const app = await buildDefinitionApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/workflows/${wf.id}`,
      payload: {
        name: 'v2',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'new' }],
        isActive: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).name).toBe('v2');
    expect(JSON.parse(res.payload).isActive).toBe(false);
    await app.close();
  });

  it('DELETE removes the workflow (executions cascade)', async () => {
    const { org, admin, contact } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'd',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'x' }],
      },
    });
    await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        status: 'running',
        currentStepIdx: 0,
      },
    });
    const app = await buildDefinitionApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/workflows/${wf.id}` });
    expect(res.statusCode).toBe(204);
    expect(await prisma.workflowDefinition.count()).toBe(0);
    expect(await prisma.workflowExecution.count()).toBe(0);
    await app.close();
  });
});

describe('Workflow trigger evaluator', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
  });

  it('AC-0004: inbound matches trigger → execution row created', async () => {
    const { org, contact, conversation } = await seed();
    await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'Greet',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'hi {{contactName}}' }],
      },
    });
    // Persist a contact-sent message to simulate the inbound persist step.
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'contact',
        senderUid: contact.zaloUid!,
        content: 'xin chào',
        contentType: 'text',
        sentAt: new Date(),
      },
    });

    const { evaluateWorkflowTriggers } = await import(
      '../../src/modules/workflow/workflow-service.js'
    );
    await evaluateWorkflowTriggers({
      orgId: org.id,
      contactId: contact.id,
      conversationId: conversation.id,
      threadType: 'user',
      isSelf: false,
      content: 'xin chào',
    });
    expect(await prisma.workflowExecution.count()).toBe(1);
    const exec = await prisma.workflowExecution.findFirst();
    expect(exec?.status).toBe('running');
    expect(exec?.currentStepIdx).toBe(0);
    expect(exec?.nextStepDueAt).not.toBeNull();
  });

  it('disabled workflow does NOT fire trigger', async () => {
    const { org, contact, conversation } = await seed();
    await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'OffWf',
        isActive: false,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'no' }],
      },
    });
    const { evaluateWorkflowTriggers } = await import(
      '../../src/modules/workflow/workflow-service.js'
    );
    await evaluateWorkflowTriggers({
      orgId: org.id,
      contactId: contact.id,
      conversationId: conversation.id,
      threadType: 'user',
      isSelf: false,
      content: 'hi',
    });
    expect(await prisma.workflowExecution.count()).toBe(0);
  });

  it('group threadType is ignored by phase 1 triggers', async () => {
    const { org, contact, conversation } = await seed();
    await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'AnyWf',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'no' }],
      },
    });
    const { evaluateWorkflowTriggers } = await import(
      '../../src/modules/workflow/workflow-service.js'
    );
    await evaluateWorkflowTriggers({
      orgId: org.id,
      contactId: contact.id,
      conversationId: conversation.id,
      threadType: 'group',
      isSelf: false,
      content: 'hi',
    });
    expect(await prisma.workflowExecution.count()).toBe(0);
  });

  it('AC-0010: re-trigger within 24h cooldown → no new execution', async () => {
    const { org, contact, conversation } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'Greet',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'hi' }],
      },
    });
    // Existing execution started 1 hour ago
    await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        completedAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });

    const { evaluateWorkflowTriggers } = await import(
      '../../src/modules/workflow/workflow-service.js'
    );
    await evaluateWorkflowTriggers({
      orgId: org.id,
      contactId: contact.id,
      conversationId: conversation.id,
      threadType: 'user',
      isSelf: false,
      content: 'hi again',
    });
    // Still only the one we pre-created.
    expect(await prisma.workflowExecution.count()).toBe(1);
  });

  it('re-trigger after 24h cooldown → new execution allowed', async () => {
    const { org, contact, conversation } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'Greet',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'hi' }],
      },
    });
    // 25h ago — outside cooldown
    await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        status: 'completed',
        startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'contact',
        senderUid: contact.zaloUid!,
        content: 'hi',
        contentType: 'text',
        sentAt: new Date(),
      },
    });
    const { evaluateWorkflowTriggers } = await import(
      '../../src/modules/workflow/workflow-service.js'
    );
    await evaluateWorkflowTriggers({
      orgId: org.id,
      contactId: contact.id,
      conversationId: conversation.id,
      threadType: 'user',
      isSelf: false,
      content: 'hi',
    });
    expect(await prisma.workflowExecution.count()).toBe(2);
  });

  it('trigger messageMatch filter respects content', async () => {
    const { org, contact, conversation } = await seed();
    await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'Price',
        isActive: true,
        trigger: { type: 'inbound_message', messageMatch: 'báo giá' },
        steps: [{ type: 'send_message', content: 'pricing' }],
      },
    });
    const { evaluateWorkflowTriggers } = await import(
      '../../src/modules/workflow/workflow-service.js'
    );
    // Non-match: no row
    await evaluateWorkflowTriggers({
      orgId: org.id,
      contactId: contact.id,
      conversationId: conversation.id,
      threadType: 'user',
      isSelf: false,
      content: 'hello',
    });
    expect(await prisma.workflowExecution.count()).toBe(0);

    // Match (case-insensitive)
    await evaluateWorkflowTriggers({
      orgId: org.id,
      contactId: contact.id,
      conversationId: conversation.id,
      threadType: 'user',
      isSelf: false,
      content: 'Cho tôi xin BÁO GIÁ',
    });
    expect(await prisma.workflowExecution.count()).toBe(1);
  });
});

describe('Workflow worker — step processing', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    sendMessageMock.mockReset();
    zaloPoolMock.getInstance.mockReturnValue({
      api: { sendMessage: sendMessageMock },
    });
  });

  it('AC-0005: send_message step → zca-js called, stepLog updated', async () => {
    const { org, contact, conversation } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'SendStep',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'Xin chào {{contactName}}!' }],
      },
    });
    const exec = await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        conversationId: conversation.id,
        status: 'running',
        currentStepIdx: 0,
        nextStepDueAt: new Date(Date.now() - 1000),
      },
    });

    const { runDueExecutions } = await import('../../src/workers/workflow-runner.js');
    await runDueExecutions();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const callArgs = sendMessageMock.mock.calls[0];
    expect(callArgs[0]).toMatchObject({ msg: expect.stringContaining('Nguyễn Văn A') });
    expect(callArgs[1]).toBe('contact-uid-1');

    const updated = await prisma.workflowExecution.findUnique({ where: { id: exec.id } });
    expect(updated?.status).toBe('completed');
    const log = updated?.stepLog as unknown as Array<{ idx: number; status: string }>;
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('ok');
    expect(log[0].idx).toBe(0);
  });

  it('AC-0006: wait step → nextStepDueAt advanced by delayMinutes', async () => {
    const { org, contact, conversation } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'WaitStep',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [
          { type: 'wait', delayMinutes: 1 },
          { type: 'wait', delayMinutes: 10 },
        ],
      },
    });
    const exec = await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        conversationId: conversation.id,
        status: 'running',
        currentStepIdx: 0,
        nextStepDueAt: new Date(Date.now() - 1000),
      },
    });

    const before = Date.now();
    const { runDueExecutions } = await import('../../src/workers/workflow-runner.js');
    await runDueExecutions();

    const updated = await prisma.workflowExecution.findUnique({ where: { id: exec.id } });
    expect(updated?.status).toBe('running');
    expect(updated?.currentStepIdx).toBe(1);
    expect(updated?.nextStepDueAt).not.toBeNull();
    // Next due ~ now + 10 min (allow ±5s drift)
    const due = updated!.nextStepDueAt!.getTime();
    expect(due).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 5000);
    expect(due).toBeLessThanOrEqual(before + 10 * 60 * 1000 + 5000);
  });

  it('AC-0007: add_tag step → ContactTag row created', async () => {
    const { org, contact, conversation } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'TagStep',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'add_tag', tag: 'hỏi-giá' }],
      },
    });
    await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        conversationId: conversation.id,
        status: 'running',
        currentStepIdx: 0,
        nextStepDueAt: new Date(Date.now() - 1000),
      },
    });
    const { runDueExecutions } = await import('../../src/workers/workflow-runner.js');
    await runDueExecutions();

    const link = await prisma.contactTag.findFirst({ where: { contactId: contact.id } });
    expect(link).not.toBeNull();
    const tag = await prisma.crmTag.findUnique({ where: { id: link!.tagId } });
    expect(tag?.name).toBe('hỏi-giá');
    expect(tag?.usageCount).toBe(1);
  });

  it('AC-0008: assign_user step → Contact.assignedUserId updated', async () => {
    const { org, admin, contact, conversation } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'AssignStep',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'assign_user', userId: admin.id }],
      },
    });
    await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        conversationId: conversation.id,
        status: 'running',
        currentStepIdx: 0,
        nextStepDueAt: new Date(Date.now() - 1000),
      },
    });
    const { runDueExecutions } = await import('../../src/workers/workflow-runner.js');
    await runDueExecutions();

    const updated = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(updated?.assignedUserId).toBe(admin.id);
  });

  it('AC-0009: step fail → execution.status=failed, stepLog has error', async () => {
    const { org, contact, conversation } = await seed();
    sendMessageMock.mockRejectedValueOnce(new Error('zca-js boom'));
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'FailingStep',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'hi' }],
      },
    });
    const exec = await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        conversationId: conversation.id,
        status: 'running',
        currentStepIdx: 0,
        nextStepDueAt: new Date(Date.now() - 1000),
      },
    });
    const { runDueExecutions } = await import('../../src/workers/workflow-runner.js');
    await runDueExecutions();

    const updated = await prisma.workflowExecution.findUnique({ where: { id: exec.id } });
    expect(updated?.status).toBe('failed');
    const log = updated?.stepLog as unknown as Array<{ status: string; error?: string }>;
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('failed');
    expect(log[0].error).toContain('zca-js boom');
  });

  it('multi-step: advances currentStepIdx and completes when last step done', async () => {
    const { org, admin, contact, conversation } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'Multi',
        isActive: true,
        trigger: { type: 'inbound_message' },
        steps: [
          { type: 'add_tag', tag: 'lead' },
          { type: 'assign_user', userId: admin.id },
        ],
      },
    });
    await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        conversationId: conversation.id,
        status: 'running',
        currentStepIdx: 0,
        nextStepDueAt: new Date(Date.now() - 1000),
      },
    });
    const { runDueExecutions } = await import('../../src/workers/workflow-runner.js');

    // First tick: runs step 0 (add_tag), schedules step 1
    await runDueExecutions();
    let exec = await prisma.workflowExecution.findFirst();
    expect(exec?.currentStepIdx).toBe(1);
    expect(exec?.status).toBe('running');

    // Advance nextStepDueAt to past so the next tick picks it up
    await prisma.workflowExecution.update({
      where: { id: exec!.id },
      data: { nextStepDueAt: new Date(Date.now() - 1000) },
    });
    await runDueExecutions();

    exec = await prisma.workflowExecution.findFirst();
    expect(exec?.status).toBe('completed');
    const updatedContact = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(updatedContact?.assignedUserId).toBe(admin.id);
  });
});

describe('Workflow execution read routes', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
  });

  it('admin GET /workflows/:id/executions returns rows with pagination', async () => {
    const { org, admin, contact } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'L',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'x' }],
      },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.workflowExecution.create({
        data: {
          orgId: org.id,
          workflowId: wf.id,
          contactId: contact.id,
          status: 'completed',
        },
      });
    }
    const app = await buildExecutionApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${wf.id}/executions`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.executions).toHaveLength(3);
    expect(body.pagination.total).toBe(3);
    await app.close();
  });

  it('member GET /contacts/:id/workflow-executions works', async () => {
    const { org, member, contact } = await seed();
    const wf = await prisma.workflowDefinition.create({
      data: {
        orgId: org.id,
        name: 'L',
        trigger: { type: 'inbound_message' },
        steps: [{ type: 'send_message', content: 'x' }],
      },
    });
    await prisma.workflowExecution.create({
      data: {
        orgId: org.id,
        workflowId: wf.id,
        contactId: contact.id,
        status: 'running',
      },
    });
    const app = await buildExecutionApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${contact.id}/workflow-executions`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).executions).toHaveLength(1);
    await app.close();
  });
});
