# Feature 0012: Activity log + audit trail

## 1. Mô tả

`ActivityLog` model đã tồn tại trong schema từ đầu project nhưng **không có code nào ghi vào**. Bảng trống, admin không có cách truy lại ai làm gì khi có incident (vd: "tại sao contact A đột nhiên đổi status?", "ai cancel campaign hôm qua?").

Feature này:
1. **Helper `logActivity()`** — fire-and-forget từ services, không block main flow
2. **Wire vào các action quan trọng** — campaign lifecycle, contact mutations, keyword rule trigger, note CRUD
3. **API `/api/v1/activity`** — list với filter (entityType, action, user, date range), paginated
4. **Trang `/activity`** (admin only) — timeline view với search + filter

## 2. User Stories

- **US-0001:** Admin nhìn timeline tuần này để spot outlier (ai cancel nhiều campaign nhất, contact nào bị update status nhiều lần)
- **US-0002:** Sale tự tra "tôi vừa làm gì cho contact X" khi quên
- **US-0003:** Compliance — khi customer kêu "tại sao status tôi bị thay đổi?", có audit log để giải thích

## 3. Business Rules

- **BR-0001:** Activity org-scoped
- **BR-0002:** Member chỉ thấy activity của chính mình. Admin/owner thấy toàn org
- **BR-0003:** `userId` nullable — system actions (worker, listener) log với `userId=null`, hiện là "Hệ thống"
- **BR-0004:** Log fire-and-forget — nếu logActivity throw, swallow + log error, KHÔNG fail caller
- **BR-0005:** Action codes chuẩn hoá (lowercase snake_case): `campaign.created`, `campaign.started`, `campaign.paused`, `campaign.cancelled`, `contact.status_changed`, `contact.assigned`, `note.created`, `note.updated`, `note.deleted`, `keyword_rule.fired`, etc.
- **BR-0006:** `details` JSON tự do nhưng có pattern khuyến nghị: `{before, after}` cho mutations, `{reason}` cho cancellations

## 4. API contract

### GET /api/v1/activity

**Query params:**
| Param | Type | Note |
|-------|------|------|
| `entityType` | string | optional, filter (campaign/contact/note/...) |
| `action` | string | optional, exact action code |
| `userId` | uuid | optional, filter actor (admin only — member tự ép = mình) |
| `from`, `to` | ISO | optional date range |
| `page`, `limit` | int | default page=1, limit=50, max=200 |

**Response 200:**
```json
{
  "activities": [
    {
      "id": "...",
      "action": "campaign.cancelled",
      "entityType": "campaign",
      "entityId": "...",
      "details": { "reason": "wrong message" },
      "createdAt": "...",
      "user": { "id": "...", "fullName": "Hương" } // null khi system
    }
  ],
  "total": 123,
  "page": 1,
  "limit": 50
}
```

## 5. Action catalog (initial)

| Action code | Entity type | Triggered from |
|-------------|-------------|----------------|
| `campaign.created` | campaign | campaign-routes POST |
| `campaign.started` | campaign | campaign-routes start |
| `campaign.paused` | campaign | campaign-routes pause OR worker (rate limit) |
| `campaign.resumed` | campaign | campaign-routes resume |
| `campaign.cancelled` | campaign | campaign-routes cancel |
| `campaign.completed` | campaign | worker when all targets done |
| `contact.created` | contact | contact-routes POST (existing) |
| `contact.status_changed` | contact | contact-routes PATCH when status changes |
| `contact.assigned` | contact | contact-routes when assignedUserId changes |
| `note.created` | note | conversation-note-routes |
| `note.updated` | note | conversation-note-routes |
| `note.deleted` | note | conversation-note-routes |
| `keyword_rule.fired` | keyword_rule | keyword-rule-service |
| `auto_reply.fired` | zalo_account | auto-reply-service |

Future codes ok — system tolerates unknown codes (just displays as-is).

## 6. Helper

```ts
// src/modules/activity/activity-service.ts
export async function logActivity(opts: {
  orgId: string;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        orgId: opts.orgId,
        userId: opts.userId ?? null,
        action: opts.action,
        entityType: opts.entityType ?? null,
        entityId: opts.entityId ?? null,
        details: (opts.details ?? {}) as any,
      },
    });
  } catch (err) {
    logger.warn('[activity] logActivity failed:', err);
  }
}
```

## 7. Frontend

**Route `/activity`** — admin only (member redirect về `/`).
- Filter row: entityType select, action text, user select (admin), date range
- Timeline table: createdAt | actor (avatar + name, "Hệ thống" cho null) | action chip | entityType + entityId | details (collapsible JSON)
- Pagination

> Optional v2: subscribe Socket.IO để live-update khi có activity mới

## 8. Acceptance Criteria

- [ ] **AC-0001:** Create campaign → 1 activity row `campaign.created` với details `{name, totalTargets}`
- [ ] **AC-0002:** Cancel campaign → 1 row `campaign.cancelled`
- [ ] **AC-0003:** Worker complete campaign → 1 row `campaign.completed` với `userId=null`
- [ ] **AC-0004:** Keyword rule fire → 1 row `keyword_rule.fired` với `details.matchedKeyword`
- [ ] **AC-0005:** Note create → 1 row `note.created`
- [ ] **AC-0006:** Member list activity → chỉ thấy activity của mình
- [ ] **AC-0007:** Admin filter by `userId=X` → chỉ activity của user X
- [ ] **AC-0008:** Filter date range → narrow result
- [ ] **AC-0009:** logActivity throw → caller flow vẫn pass (test mock prisma throw)
- [ ] **AC-0010:** Cross-org isolation
- [ ] **AC-0011:** Build pass

## 9. Test plan

- Unit: query builder helpers (validate filter params)
- Integration: full CRUD, role gradient, cross-org, swallow-on-error

## 10. Out of scope

- Retention policy (auto-delete > N days). Sẽ làm khi DB phình to
- Export Excel (chưa cần)
- Detail view per activity row (chỉ inline expand JSON)
- Sửa/xoá activity log (immutable by design)
- Real-time Socket.IO push (load on demand)
