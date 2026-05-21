# Feature 0041: Advanced analytics — funnel + team performance dashboard

## 1. Mô tả

Feature 0007 (KPI leaderboard) + existing Reports đã có team-level KPIs.
ZaloCRM-3.0 v2.0 release notes mention "Advanced Analytics" với 3 sub:
funnel view, team perf dashboard extension, report builder.

Phase 1 scope: **funnel view + team perf extension**. Report builder
(visual query designer) là big component, defer phase 2.

## 2. User Stories

- **US-0041-1:** Là Admin, tôi xem funnel `new → contacted → interested
  → converted` với count + conversion rate per stage cho period (this
  week / month / quarter).
- **US-0041-2:** Là Admin, tôi xem team perf dashboard extended với:
  avg response time per rep, total messages sent, contacts converted.
- **US-0041-3:** Là Admin, tôi filter cả 2 dashboards theo team / date
  range.

## 3. Business Rules

### Funnel

- **BR-0001:** Stages = `Contact.status` values: `new → contacted →
  interested → converted` (linear progression). Skip `lost` (exit branch).
- **BR-0002:** Count per stage = contacts CURRENTLY có status đó (snapshot
  view) HOẶC đã từng đi qua stage trong period (cumulative — needs status
  history). Phase 1: SNAPSHOT (đơn giản, đủ value).
- **BR-0003:** Conversion rate = `count(stage[i+1]) / count(stage[i]) ×
  100%` clamped 0-100. Display next-stage rate.
- **BR-0004:** Filter:
  - `dateFrom/dateTo` — restrict contacts created in window.
  - `assignedUserId` (optional) — only contacts assigned to user.
  - `teamId` (optional) — only contacts assigned to team members.

### Team perf metrics

- **BR-0005:** Per-rep metrics in selected period:
  - **avgResponseTimeMinutes**: avg `(first outbound after inbound) -
    inbound timestamp` for messages where rep was assigned to contact.
  - **outboundMessageCount**: total `senderType='self'` messages on rep's
    assigned conversations.
  - **convertedContactsCount**: contacts where rep was assignedUser AND
    `status='converted'` AND `updatedAt` in period.
  - **activeConversationsCount**: conversations with rep's assigned contact
    + inbound trong 7 ngày (reuse Feature 0033 logic).

### Endpoint design

- **BR-0006:** Two endpoints. Both admin/owner only:
  - `GET /api/v1/analytics/funnel`
  - `GET /api/v1/analytics/team-performance`

### Performance

- **BR-0007:** Both endpoints target < 500ms for org với 10k contacts +
  100k messages. Use indexes already exist on Contact.status, Contact.
  assignedUserId. Add composite `(orgId, status, createdAt)` if needed.

## 4. Input / Output

### Schema

NO new tables. Possibly 1 new index (verify).

### Endpoints

#### `GET /api/v1/analytics/funnel?dateFrom=&dateTo=&teamId=&assignedUserId=`

```json
{
  "stages": [
    { "name": "new",        "count": 230, "conversionRate": null },
    { "name": "contacted",  "count": 145, "conversionRate": 63 },
    { "name": "interested", "count":  68, "conversionRate": 47 },
    { "name": "converted",  "count":  21, "conversionRate": 31 }
  ],
  "lost":            { "count": 12 },
  "totalContacts":   406,
  "period": { "dateFrom": "...", "dateTo": "..." }
}
```

#### `GET /api/v1/analytics/team-performance?dateFrom=&dateTo=&teamId=`

```json
{
  "byUser": [
    {
      "userId": "uuid",
      "fullName": "Lan Anh",
      "avgResponseTimeMinutes": 12.4,
      "outboundMessageCount": 432,
      "convertedContactsCount": 8,
      "activeConversationsCount": 34
    },
    ...
  ],
  "totals": {
    "outboundMessageCount": 2340,
    "convertedContactsCount": 41
  },
  "period": { "dateFrom": "...", "dateTo": "..." }
}
```

### Frontend

- `frontend/src/pages/AnalyticsDashboard.vue` — extends existing dashboard
  with 2 new sections.
- `FunnelChart.vue` — new component (use existing chart lib).
- `TeamPerfTable.vue` — new (table + sort).

## 5. Edge Cases

- **EC-0001:** No contacts in stage → 0, conversionRate = null hoặc 0
  (consistent — pick 0 if previous stage > 0 else null).
- **EC-0002:** Date range edge: include or exclude boundary contacts?
  Use `gte`/`lte` for inclusivity.
- **EC-0003:** AvgResponseTime: contact mới chưa có inbound nào → exclude
  từ avg (NaN protection).
- **EC-0004:** Rep with no assigned contacts → empty row (count = 0).

## 6. Acceptance Criteria

- [ ] **AC-0001:** GET /analytics/funnel admin → 200 với expected shape.
- [ ] **AC-0002:** Member → 403.
- [ ] **AC-0003:** Funnel filter by dateFrom/dateTo correctly restricts
      count.
- [ ] **AC-0004:** Conversion rates compute correctly.
- [ ] **AC-0005:** GET /analytics/team-performance admin → 200.
- [ ] **AC-0006:** Per-user metrics: 1 rep + 1 contact + known
      response time → expected avg.
- [ ] **AC-0007:** Cross-org isolation.
- [ ] **AC-0008:** Performance: query < 500ms for 10k contacts.
- [ ] **AC-0009:** FE: FunnelChart renders với expected stages.
- [ ] **AC-0010:** FE: TeamPerfTable sortable.
- [ ] **AC-0011:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Contact` + `Message` + `User` models — đọc only.
- `backend/src/modules/analytics/` — new module (or extend kpi-routes).
- `frontend/src/pages/AnalyticsDashboard.vue` — extend.
- `frontend/src/components/analytics/FunnelChart.vue` + `TeamPerfTable.vue`
  — new.
- Chart lib — verify what's already installed (Chart.js / ECharts /
  Vuetify v-sparkline). Pick simplest.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Funnel endpoint + query | ~80 |
| Team perf endpoint + query | ~120 |
| FE FunnelChart | ~100 |
| FE TeamPerfTable | ~80 |
| FE dashboard integration | ~50 |
| Backend tests | ~150 |
| **Tổng** | **~580 LOC** |

### Risk: LOW-MEDIUM

Aggregate queries similar to Feature 0033. Performance manageable. Risk:
chart lib choice + tasteful UI without external designer input.

### Test strategy

- Integration: seed mixed contacts + messages, assert counts + rates.
- Performance: 10k contacts + 100k messages, run timer.
- FE: snapshot test charts with stub data.

### Deviations from ZaloCRM-3.0

We pull report builder out of scope. Funnel + team perf are achievable
without it.

### Out of scope (Phase 2)

- **Report builder** (visual query designer) — its own feature, big.
- Funnel cumulative view (needs status history table — Feature 0042+).
- Custom time buckets (currently dateFrom/dateTo flat).
- Export to CSV/Excel.
- Schedule auto-email reports.
