# Feature 0037: Workflow automation engine

## 1. Mô tả

Feature 0009 (KeywordRule) đã có single-step "if inbound message matches
keyword → auto-tag/auto-reply". Hôm nay đó là extent của automation.
ZaloCRM-3.0 v2.0 release notes nói "Workflow Automation: tự động gửi tin,
phân loại khách" với scope rộng hơn nhiều: chuỗi bước có điều kiện
("after 24h no reply → send template Z + assign user W"), branching,
delays, multi-action.

Feature này build engine **đơn giản** (phase 1 minimal viable):
- 1 trigger type (inbound message)
- 3 action types (send_message, add_tag, assign_user)
- Linear step list (no branching)
- Delay between steps (in minutes)

Phase 2 sẽ add: time-based triggers, condition branching, more triggers
(no_reply_after, conversation_idle), more actions (create_appointment,
send_to_zapier).

## 2. User Stories

- **US-0037-1:** Là Admin, tôi tạo workflow "Welcome New Lead": trigger =
  inbound message từ contact mới + status='new'. Steps:
  1. Send template "Chào anh/chị, em là Sale CDI..."
  2. Wait 24h
  3. If no reply → send follow-up template + assign to senior rep.
- **US-0037-2:** Là Admin, tôi enable/disable workflow qua toggle. Disabled
  workflow KHÔNG fire trigger.
- **US-0037-3:** Là Admin, tôi xem workflow execution log: contact X
  qua workflow Y, step nào đã chạy, step nào pending/failed.

## 3. Business Rules

### Trigger (phase 1)

- **BR-0001:** Trigger types (phase 1): `inbound_message` only.
  - Sub-condition: `messageMatch` (regex/keyword), `contactStatus`,
    `isFirstInbound` (contact's first message ever).
- **BR-0002:** Khi inbound message arrive, evaluate active workflows
  trong cùng org. Match → tạo `WorkflowExecution` row với step pointer = 0.

### Steps (phase 1)

- **BR-0003:** Step types (phase 1):
  - `send_message` — gửi text qua zca-js (template content + var
    substitution `{{contactName}}`, `{{repName}}`).
  - `add_tag` — gán tag vào contact (Feature 0019 ContactTag).
  - `assign_user` — set `Contact.assignedUserId`.
  - `wait` — delay X minutes trước bước tiếp theo.
- **BR-0004:** Steps chạy sequential. Mỗi step có `delayMinutes` field
  (0 = run ngay sau previous).

### Execution engine

- **BR-0005:** Worker pattern: cron job mỗi 1 phút quét
  `WorkflowExecution` có `nextStepDueAt <= NOW()` và `status='running'`.
  Execute next step → update `currentStepIdx`, compute `nextStepDueAt`,
  hoặc set `status='completed'` nếu hết steps.
- **BR-0006:** Step execution failure (zca-js error, tag không tồn tại,
  user invalid) → set step status='failed', execution status='failed'.
  Admin có thể manual retry (phase 2).
- **BR-0007:** Re-trigger logic: cùng contact match cùng workflow trong
  cooldown 24h → KHÔNG tạo execution mới (idempotent). 

### Permissions

- **BR-0008:** CRUD workflow: Owner/Admin only.
- **BR-0009:** View executions: Member với access đến contact (qua
  assignedUserId hoặc ZaloAccount ACL).

## 4. Input / Output

### Schema migration

```prisma
model WorkflowDefinition {
  id          String   @id @default(uuid())
  orgId       String   @map("org_id")
  name        String
  description String?
  isActive    Boolean  @default(true) @map("is_active")
  trigger     Json     // { type: 'inbound_message', ... }
  steps       Json     // [{ type, ... }, ...]
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  org        Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  executions WorkflowExecution[]

  @@index([orgId, isActive])
  @@map("workflow_definitions")
}

model WorkflowExecution {
  id              String    @id @default(uuid())
  orgId           String    @map("org_id")
  workflowId      String    @map("workflow_id")
  contactId       String    @map("contact_id")
  conversationId  String?   @map("conversation_id")
  status          String    @default("running") // running | completed | failed | cancelled
  currentStepIdx  Int       @default(0) @map("current_step_idx")
  nextStepDueAt   DateTime? @map("next_step_due_at")
  stepLog         Json      @default("[]") @map("step_log") // [{ idx, status, ranAt, error }]
  startedAt       DateTime  @default(now()) @map("started_at")
  completedAt     DateTime? @map("completed_at")

  workflow WorkflowDefinition @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  contact  Contact            @relation(fields: [contactId], references: [id], onDelete: Cascade)

  @@index([orgId, status, nextStepDueAt])
  @@index([workflowId, contactId, startedAt])
  @@map("workflow_executions")
}
```

### Endpoints

#### `GET/POST/PUT/DELETE /api/v1/workflows`

Standard CRUD, admin-only. Body: name, description, trigger JSON, steps JSON.

#### `GET /api/v1/workflows/:id/executions`

List executions of a workflow. Pagination.

#### `GET /api/v1/contacts/:id/workflow-executions`

List executions where this contact appeared. Member-accessible.

### Worker

`backend/src/workers/workflow-runner.ts` — cron-style invoke every 60s:

```typescript
async function runDueExecutions() {
  const due = await prisma.workflowExecution.findMany({
    where: { status: 'running', nextStepDueAt: { lte: new Date() } },
    take: 50,
  });
  for (const exec of due) {
    await processStep(exec);
  }
}
```

Register in app.ts via `setInterval(runDueExecutions, 60_000)` (with
process-safe singleton flag to avoid double-fire in multi-worker
deployments — phase 1 single worker).

### Trigger hook

In `message-handler.ts` (inbound persist), after Message create + tab
auto-promote:

```typescript
if (existing inbound from contact) {
  await evaluateWorkflowTriggers({
    orgId, contactId, conversationId, message,
  });
}
```

`evaluateWorkflowTriggers` queries active workflows matching the contact's
state, creates new WorkflowExecution rows.

### Frontend

- Settings → Workflows page với list + CRUD form.
- Workflow form: trigger config + steps editor (drag-drop or simple
  list).
- Executions log view per workflow.

## 5. Edge Cases

- **EC-0001:** Workflow disable mid-execution → existing executions
  continue (or set policy: stop on disable; phase 1: continue, predictable).
- **EC-0002:** Contact deleted mid-execution → CASCADE delete execution.
- **EC-0003:** Step fail → execution.status='failed'. Subsequent steps
  KHÔNG chạy. Admin manual cancel/retry.
- **EC-0004:** Worker job overlap (concurrent runs) → use `FOR UPDATE
  SKIP LOCKED` Postgres lock pattern hoặc đặt singleton flag.
- **EC-0005:** Workflow re-trigger trong cooldown 24h → ignore.
- **EC-0006:** Template var substitution: missing var (`{{unknownVar}}`)
  → leave literal trong text + log warning.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Migration tạo 2 tables + indexes. Build pass.
- [ ] **AC-0002:** POST /workflows admin → 200, DB row.
- [ ] **AC-0003:** POST member → 403.
- [ ] **AC-0004:** Inbound message matches trigger → WorkflowExecution
      row created.
- [ ] **AC-0005:** Worker processes step `send_message` → zca-js called,
      stepLog updated.
- [ ] **AC-0006:** Worker processes `wait` step → nextStepDueAt advanced
      by delayMinutes.
- [ ] **AC-0007:** Worker processes `add_tag` → ContactTag row created.
- [ ] **AC-0008:** Worker processes `assign_user` → Contact.assignedUserId
      updated.
- [ ] **AC-0009:** Step fail → execution.status='failed', stepLog has error.
- [ ] **AC-0010:** Re-trigger trong 24h cooldown → KHÔNG tạo new execution.
- [ ] **AC-0011:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- New 2 schema models.
- `backend/src/modules/workflow/` — new module (definition routes,
  execution routes, service, worker).
- `backend/src/modules/chat/message-handler.ts` — hook to evaluate
  triggers.
- `backend/src/workers/` — new directory + `workflow-runner.ts`.
- `backend/src/app.ts` — setInterval registration.
- `backend/src/modules/zalo/zalo-pool.ts` — used for sendMessage in step.
- `backend/src/modules/crm-tags/` — used for add_tag step.
- `frontend/src/pages/SettingsWorkflows.vue` — new.
- `frontend/src/components/workflow/WorkflowEditor.vue` — new.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema migration | ~30 |
| CRUD routes | ~150 |
| Worker | ~150 |
| Trigger hook + evaluator | ~80 |
| Step executors (4 types) | ~120 |
| Template var substitution | ~30 |
| FE list + editor + executions view | ~250 |
| Backend tests | ~250 |
| FE tests | ~50 |
| **Tổng** | **~1,110 LOC** (higher than 800 SPEC estimate due to
  worker locking + tests) |

### Risk: MEDIUM-HIGH

This is the largest single feature in B-6/B-7. Risks:
1. Worker concurrency in multi-process deploy — pattern: advisory lock
   or `FOR UPDATE SKIP LOCKED`.
2. Trigger evaluation latency on hot inbound paths — solution: enqueue
   evaluation as fire-and-forget via `trackBackground()` (existing
   helper).
3. Template var substitution security — sanitize before passing to
   zca-js to prevent injection (no FE-render of substituted text).

### Test strategy

- Unit: each step executor.
- Integration: end-to-end inbound → trigger → execution → step run →
  result assertions.
- Worker concurrency: spawn 2 workers in test, assert no double-fire
  with locking.

### Deviations from ZaloCRM-3.0

3.0 release note is wide ("Workflow Automation"). We scope phase 1
narrow: 1 trigger type, 4 step types, no branching, no time-based
triggers. Honest scope cut documented; phase 2 backlog will add more.

### Out of scope (Phase 2 — explicit follow-ups)

- Time-based triggers (`every_day_at`, `after_no_reply_24h`).
- Condition branching (if/else).
- More actions (create_appointment, webhook_call, zapier_send).
- Workflow templates marketplace.
- Versioning (rollback to previous workflow version).
- Multi-step retry / partial replay.
