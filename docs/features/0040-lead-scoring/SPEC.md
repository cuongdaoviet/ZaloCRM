# Feature 0040: Lead scoring (rules-based phase 1)

## 1. Mô tả

ZaloCRM-3.0 v2.0 release notes mention "Contact Intelligence: gộp trùng,
lead scoring, auto-tag". Auto-tag đã có (Feature 0009), gộp trùng đã có
(Feature 0018 + 0034). Lead scoring chưa có.

"Lead score" định lượng "mức độ nóng" của contact. Phase 1 rules-based:

```
score = recencyOfLastMessage × recencyWeight
      + engagementCount × engagementWeight
      + statusMultiplier
      + appointmentBonus
```

Phase 2 (out of scope): ML embeddings on conversation history.

## 2. User Stories

- **US-0040-1:** Là Sale, tôi xem Contact list có cột "Lead score" 0-100,
  sort desc → biết ai nóng nhất để follow-up.
- **US-0040-2:** Là Admin, tôi configure trọng số trong Settings (recency
  weight, engagement weight, status multiplier per status, appointment
  bonus).
- **US-0040-3:** Là Sale, tôi click vào số score → tooltip giải thích
  "Recent: 35 + Engagement: 28 + Status: 20 + Appointment: 10 = 93".

## 3. Business Rules

### Scoring formula (phase 1, configurable)

- **BR-0001:** Recency component (max 40 điểm):
  - Last inbound message ≤ 1h → 40.
  - ≤ 24h → 30.
  - ≤ 7d → 20.
  - ≤ 30d → 10.
  - > 30d → 0.

- **BR-0002:** Engagement component (max 30 điểm):
  - Total inbound message count in last 30 days. Cap at 30 (1 point per
    message). Reason: linear cap khuyến khích KH chủ động.

- **BR-0003:** Status component (max 20 điểm):
  - `interested` → 20.
  - `contacted` → 10.
  - `new` → 5.
  - `converted` → 0 (đã chốt, không cần focus).
  - `lost` → 0.

- **BR-0004:** Appointment component (max 10 điểm):
  - Có upcoming appointment trong 7 ngày → 10.
  - Có appointment scheduled trong 30 ngày → 5.
  - Không có → 0.

- **BR-0005:** Total score = sum, capped at 100.

### Config

- **BR-0006:** Org-level config stored in `OrgSettings` (or `Organization.metadata`)
  table — fields:
  - `leadScore.recencyBuckets: [{hours, points}, ...]`
  - `leadScore.engagementCap: number`
  - `leadScore.statusPoints: { new, contacted, interested, converted, lost }`
  - `leadScore.appointmentBuckets: [{daysWindow, points}, ...]`
- **BR-0007:** Default config nếu chưa set → BR-0001..BR-0004 defaults.

### Compute timing

- **BR-0008:** Score computed **on-demand** khi:
  - GET /contacts list → batch compute trên returned contacts.
  - GET /contacts/:id → compute on the fly.
- **BR-0009:** Score NOT persisted (no denormalize). Reason: recency
  changes every hour → would need constant updates. On-demand đủ nhanh
  với index trên `Message.createdAt`.
- **BR-0010:** Performance target: < 200ms for 100 contacts batch compute.

### Display

- **BR-0011:** Color coding:
  - Score 80-100: red badge ("Nóng").
  - 50-79: orange ("Ấm").
  - 20-49: yellow ("Bình thường").
  - 0-19: gray ("Nguội").

## 4. Input / Output

### Schema

NO new table. Reuse `Organization` table for config JSON.

```prisma
model Organization {
  // ... existing fields ...
  leadScoreConfig Json? @map("lead_score_config")
}
```

### Endpoints

#### `GET /api/v1/contacts` (existing) — extended

Response items now include `leadScore: number, leadScoreBreakdown: {...}`.
Sort by `leadScore` (desc/asc) supported via `?sort=leadScore`.

#### `GET /api/v1/contacts/:id` — extended

Response includes `leadScore` + `leadScoreBreakdown`.

#### `GET /api/v1/settings/lead-score-config` (new)

Admin-only. Returns current config (default if unset).

#### `PUT /api/v1/settings/lead-score-config`

Admin-only. Validate shape (Zod-style). Save to Organization JSON.

### Service

`backend/src/modules/contacts/lead-score-service.ts`:

```typescript
export async function computeLeadScore(
  contactId: string,
  config: LeadScoreConfig,
): Promise<{ score: number; breakdown: Record<string, number> }> {
  const [lastInbound, engagementCount, status, nextAppointment] = await Promise.all([
    fetchLastInboundAge(contactId),
    fetchEngagementCount(contactId),
    fetchContactStatus(contactId),
    fetchUpcomingAppointment(contactId),
  ]);
  // Apply BR-0001..BR-0004 to compute components.
  // Return total + breakdown.
}

export async function computeLeadScoresBatch(
  contactIds: string[],
  config: LeadScoreConfig,
): Promise<Map<string, { score: number; breakdown: Record<string, number> }>> {
  // Single batch query for each component instead of N+1.
}
```

### Frontend

- Contact list: thêm cột "Lead Score" với badge color.
- Click score → tooltip với breakdown.
- Settings → Lead Score Config page: form với inputs cho từng weight.

## 5. Edge Cases

- **EC-0001:** Contact mới tạo, chưa có inbound nào → score = 0 + statusPoint
  ('new'=5). Tổng = 5. OK.
- **EC-0002:** Contact merged (mergedIntoId set) → exclude khỏi list,
  KHÔNG compute.
- **EC-0003:** Config invalid (vd negative weights) → reject 400 ở PUT,
  fall back default ở GET nếu DB corrupt.
- **EC-0004:** Batch size > 1000 → endpoint paginate, batch compute per
  page.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Migration add `lead_score_config JSON NULL` → build pass.
- [ ] **AC-0002:** GET /contacts response items include `leadScore` 0-100.
- [ ] **AC-0003:** GET /contacts/:id response includes
      `leadScoreBreakdown` object.
- [ ] **AC-0004:** Contact với inbound trong 1h + 5 engagements + status
      'interested' + appointment 3 ngày → score = 40+5+20+10 = 75.
- [ ] **AC-0005:** Contact converted → status 0, regardless of other
      components.
- [ ] **AC-0006:** Sort by leadScore works descending.
- [ ] **AC-0007:** PUT config admin → 200, persist.
- [ ] **AC-0008:** PUT member → 403.
- [ ] **AC-0009:** PUT invalid config (negative weight) → 400.
- [ ] **AC-0010:** Performance: 100 contacts batch < 200ms.
- [ ] **AC-0011:** FE: badge color matches score band.
- [ ] **AC-0012:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Organization` model — thêm 1 JSON field.
- `backend/src/modules/contacts/lead-score-service.ts` — new.
- `backend/src/modules/contacts/contact-routes.ts` — extend list + detail
  responses.
- `backend/src/modules/settings/` (or contact-routes) — config endpoints.
- `frontend/src/pages/ContactList.vue` — new column.
- `frontend/src/pages/SettingsLeadScore.vue` — new.
- `frontend/src/types/contact.ts` — extend type.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema migration | ~5 |
| lead-score-service (batch + single) | ~120 |
| Routes integration + config CRUD | ~80 |
| FE contact list column + tooltip | ~50 |
| FE settings page | ~100 |
| Backend tests | ~120 |
| **Tổng** | **~475 LOC** |

### Risk: LOW-MEDIUM

Computation logic is straightforward. Risk: batch performance. Mitigate
with composite queries (GROUP BY contactId for engagement count, MIN
for lastInbound). EXPLAIN ANALYZE deliverable in PR.

### Test strategy

- Unit: scoring formula edge cases (each band).
- Integration: seed mixed contacts, batch compute < 200ms.
- Config: invalid input rejected.

### Deviations from ZaloCRM-3.0

3.0 release note brief. Our scoring buckets are educated defaults; admin
can tune via config.

### Out of scope (Phase 2)

- ML embedding scoring (conversation similarity to converted contacts).
- Time-decay weights (exponential decay instead of bucket).
- Per-rep scoring (different reps weight differently).
- Score history chart (trend over time).
- Alert when score crosses threshold (e.g. 'Lead nóng' notification).
