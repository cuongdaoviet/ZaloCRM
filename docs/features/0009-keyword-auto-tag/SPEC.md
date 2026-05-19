# Feature 0009: Keyword auto-tag

## 1. Mô tả

Sale tốn thời gian phân loại khách hàng thủ công: khách nhắn "cho em bảng giá" → sale phải mở contact panel, đổi status sang `interested`, thêm tag `hỏi-giá`. Feature này tự động hoá:

1. **Rule định nghĩa keyword → action**: khi tin nhắn inbound chứa keyword (substring case-insensitive), tự update contact: thêm tag, đổi status, gán user
2. **Quản lý rule** trong settings (admin/owner)
3. **Trigger tự động** trong listener Zalo, fire-and-forget không block message flow

## 2. User Stories

- **US-0001:** Admin tạo rule "bảng giá" → tag `hỏi-giá` + status `interested`. Khách nhắn "anh cho em bảng giá nhé" → contact tự được tag + đổi status
- **US-0002:** Admin disable rule nhanh khi không phù hợp nữa (vd: campaign kết thúc), không cần xoá
- **US-0003:** 1 rule có thể match nhiều keyword (vd: "giá", "bảng giá", "báo giá" → cùng tag `hỏi-giá`)
- **US-0004:** Sale member xem được rule đang active để biết hệ thống đang làm gì với khách của mình

## 3. Business Rules

- **BR-0001:** Match case-insensitive, substring (không cần whole word). "Anh cho giá" match keyword "giá"
- **BR-0002:** Rule scoped theo `orgId`. Tất cả user trong org dùng chung
- **BR-0003:** Một message có thể trigger **nhiều rule** (mỗi rule independent). Nhưng cùng 1 rule không trigger lại trong **1 conversation** (tránh duplicate work). Tracked qua `KeywordRuleTrigger` ledger
- **BR-0004:** Action support 3 loại (có thể kết hợp):
  - **addTag**: thêm tag vào `Contact.tags` JSONB array (nếu chưa có)
  - **setStatus**: đổi `Contact.status` (chỉ nếu rule status priority cao hơn — converted > interested > contacted > new > lost; setStatus xuống lại không được)
  - **assignToUser**: set `Contact.assignedUserId` (chỉ nếu hiện chưa được gán)
- **BR-0005:** Chỉ trigger cho `senderType=contact`, không trigger cho self messages
- **BR-0006:** Chỉ trigger cho 1-1 chat (`threadType=user`), không group
- **BR-0007:** Member CRUD: chỉ owner/admin tạo/sửa/xoá rule. Member chỉ read

## 4. Schema

```prisma
model KeywordRule {
  id          String   @id @default(uuid())
  orgId       String   @map("org_id")
  name        String   // human-readable, e.g. "Hỏi bảng giá"
  enabled     Boolean  @default(true)
  keywords    Json     // array of strings, e.g. ["bảng giá", "báo giá"]
  // Actions — all optional, at least 1 must be set
  addTag         String?  @map("add_tag")
  setStatus      String?  @map("set_status") // new|contacted|interested|converted|lost
  assignToUserId String?  @map("assign_to_user_id")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  org            Organization          @relation(fields: [orgId], references: [id], onDelete: Cascade)
  assignToUser   User?                 @relation("KeywordRuleAssign", fields: [assignToUserId], references: [id])
  triggers       KeywordRuleTrigger[]

  @@index([orgId, enabled])
  @@map("keyword_rules")
}

model KeywordRuleTrigger {
  id             String   @id @default(uuid())
  ruleId         String   @map("rule_id")
  conversationId String   @map("conversation_id")
  contactId      String   @map("contact_id")
  matchedKeyword String   @map("matched_keyword")
  triggeredAt    DateTime @default(now()) @map("triggered_at")

  rule KeywordRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)

  @@unique([ruleId, conversationId]) // BR-0003: one trigger per (rule, conv)
  @@index([triggeredAt])
  @@map("keyword_rule_triggers")
}
```

Update `Organization`, `User` reverse relations.

## 5. API contract

### GET /api/v1/keyword-rules
List all rules in org.

### POST /api/v1/keyword-rules (admin/owner)
**Body:**
```json
{
  "name": "Hỏi bảng giá",
  "enabled": true,
  "keywords": ["bảng giá", "báo giá", "giá bao nhiêu"],
  "addTag": "hỏi-giá",
  "setStatus": "interested",
  "assignToUserId": null
}
```

### PUT /api/v1/keyword-rules/:id (admin/owner)
### DELETE /api/v1/keyword-rules/:id (admin/owner)

**Errors:**
- `400` — name empty, keywords empty, no action set, status invalid
- `403` — member tạo/sửa/xoá
- `404` — không tồn tại

## 6. Helpers (pure)

```ts
validateRuleInput(body, orgId): Result<ValidatedRule, error>
  // Centralize all validation. keywords non-empty array of trimmed strings.
  // At least 1 of (addTag, setStatus, assignToUserId) must be set.
  // setStatus must be in pipeline enum.

matchKeywords(content: string, keywords: string[]): string | null
  // Returns the first keyword found (lowercase compare on both sides),
  // null if none match. Used for both runtime trigger and rule preview.

shouldUpgradeStatus(current, target): boolean
  // converted > interested > contacted > new > lost
  // Returns true iff target is "higher" than current.
```

## 7. Service

`keyword-rule-service.ts`:

```ts
export async function processInboundForKeywordRules(opts: {
  orgId: string;
  conversationId: string;
  contactId: string;
  threadType: 'user' | 'group';
  isSelf: boolean;
  content: string;
}): Promise<void> {
  if (opts.threadType !== 'user') return;
  if (opts.isSelf) return;

  const rules = await prisma.keywordRule.findMany({
    where: { orgId: opts.orgId, enabled: true },
  });
  for (const rule of rules) {
    const matched = matchKeywords(opts.content, rule.keywords as string[]);
    if (!matched) continue;

    // BR-0003 dedupe
    const ledger = await prisma.keywordRuleTrigger.findUnique({
      where: { ruleId_conversationId: { ruleId: rule.id, conversationId: opts.conversationId } },
    });
    if (ledger) continue;

    await applyRule(rule, opts.contactId);
    await prisma.keywordRuleTrigger.create({
      data: {
        ruleId: rule.id,
        conversationId: opts.conversationId,
        contactId: opts.contactId,
        matchedKeyword: matched,
      },
    });
  }
}

async function applyRule(rule, contactId) {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return;
  const updates: Partial<Contact> = {};

  if (rule.addTag) {
    const tags = (contact.tags as string[]) ?? [];
    if (!tags.includes(rule.addTag)) updates.tags = [...tags, rule.addTag];
  }
  if (rule.setStatus && shouldUpgradeStatus(contact.status, rule.setStatus)) {
    updates.status = rule.setStatus;
  }
  if (rule.assignToUserId && !contact.assignedUserId) {
    updates.assignedUserId = rule.assignToUserId;
  }
  if (Object.keys(updates).length > 0) {
    await prisma.contact.update({ where: { id: contactId }, data: updates });
  }
}
```

## 8. Wire vào listener

Trong `zalo-listener-factory.ts`, sau khi `processZaloMessage` thành công và truoc khi `maybeAutoReply`, gọi `processInboundForKeywordRules(...)`. Fire-and-forget, errors swallowed.

## 9. Frontend

**Route mới:** `/keyword-rules` — list + create dialog
- Table: Tên rule | Keywords (chip list) | Actions (icons cho 3 type) | Enabled toggle | Người gán | Trigger count
- Create/edit dialog: name + keywords (combobox multi) + 3 action options + assignTo select

## 10. Acceptance Criteria

- [ ] **AC-0001:** Tạo rule với 1 keyword + addTag → khách nhắn keyword → contact có tag mới
- [ ] **AC-0002:** Rule với setStatus=`interested`, contact status=`new` → status đổi
- [ ] **AC-0003:** Cùng rule trigger lần 2 trong cùng conversation → KHÔNG action (deduped)
- [ ] **AC-0004:** Self message chứa keyword → KHÔNG trigger
- [ ] **AC-0005:** Group message chứa keyword → KHÔNG trigger
- [ ] **AC-0006:** Disable rule → không trigger nữa
- [ ] **AC-0007:** setStatus=`new` trên contact `converted` → KHÔNG downgrade
- [ ] **AC-0008:** Rule không có action nào → 400
- [ ] **AC-0009:** Cross-org: rule org A không trigger cho contact org B
- [ ] **AC-0010:** Member sửa/xoá rule → 403

## 11. Test plan

- Unit (helpers): matchKeywords, shouldUpgradeStatus, validateRuleInput
- Integration: full CRUD + cover all 10 ACs

## 12. Out of scope

- Regex matching (chỉ substring)
- Sentiment analysis / ML
- Multi-language (chỉ support text như sale gõ)
- Apply retroactively to past conversations (chỉ trigger từ message mới)
