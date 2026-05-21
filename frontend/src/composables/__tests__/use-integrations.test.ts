/**
 * Unit tests for use-integrations.ts (Feature 0038 FE composable).
 *
 * Focus areas:
 *  - Label maps (STATUS_LABELS / STATUS_COLORS / SCHEDULE_LABELS /
 *    EVENT_TYPE_LABELS) — these are referenced by templates so a typo in any
 *    key surfaces an empty cell on the integrations page.
 *  - createIntegration / fetchAll / updateIntegration / deleteIntegration /
 *    triggerSync / listRuns / getGoogleOAuthUrl call shapes — guards against
 *    accidental URL renames during refactors.
 *  - Error envelope mapping — surface the server's `error` field to the user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@/api/index', () => ({ api: apiMock }));

import {
  useIntegrations,
  STATUS_LABELS,
  STATUS_COLORS,
  SCHEDULE_LABELS,
  EVENT_TYPE_LABELS,
} from '@/composables/use-integrations';

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.patch.mockReset();
  apiMock.delete.mockReset();
});

describe('label maps', () => {
  it('STATUS_LABELS covers the three run states', () => {
    expect(STATUS_LABELS.running).toBeTruthy();
    expect(STATUS_LABELS.succeeded).toBeTruthy();
    expect(STATUS_LABELS.failed).toBeTruthy();
  });

  it('STATUS_COLORS matches Vuetify color names', () => {
    expect(STATUS_COLORS.running).toBe('info');
    expect(STATUS_COLORS.succeeded).toBe('success');
    expect(STATUS_COLORS.failed).toBe('error');
  });

  it('SCHEDULE_LABELS covers all phase-1 schedules', () => {
    expect(SCHEDULE_LABELS.manual).toBeTruthy();
    expect(SCHEDULE_LABELS.hourly).toBeTruthy();
    expect(SCHEDULE_LABELS.daily).toBeTruthy();
  });

  it('EVENT_TYPE_LABELS covers all SupportedEventType values', () => {
    expect(EVENT_TYPE_LABELS['contact.created']).toBeTruthy();
    expect(EVENT_TYPE_LABELS['order.created']).toBeTruthy();
    expect(EVENT_TYPE_LABELS['appointment.reminder']).toBeTruthy();
    expect(EVENT_TYPE_LABELS['message.escalated']).toBeTruthy();
  });
});

describe('useIntegrations CRUD wiring', () => {
  it('fetchAll calls GET /integrations', async () => {
    apiMock.get.mockResolvedValue({ data: { integrations: [{ id: 'a' }] } });
    const composable = useIntegrations();
    await composable.fetchAll();
    expect(apiMock.get).toHaveBeenCalledWith('/integrations');
    expect(composable.integrations.value).toHaveLength(1);
  });

  it('createIntegration POSTs to /integrations + unshifts result', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'i1', type: 'telegram_bot' } });
    const composable = useIntegrations();
    const res = await composable.createIntegration({
      type: 'telegram_bot',
      name: 'X',
      config: { botToken: 't', chatId: '1', eventTypes: ['contact.created'] },
    });
    expect(res.ok).toBe(true);
    expect(apiMock.post).toHaveBeenCalledWith(
      '/integrations',
      expect.objectContaining({ type: 'telegram_bot', name: 'X' }),
    );
  });

  it('createIntegration surfaces server error message', async () => {
    apiMock.post.mockRejectedValue({
      response: { data: { error: 'Bad bot token' } },
    });
    const composable = useIntegrations();
    const res = await composable.createIntegration({
      type: 'telegram_bot',
      name: 'X',
      config: { botToken: 'bad', chatId: '1', eventTypes: ['contact.created'] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Bad bot token');
  });

  it('updateIntegration PATCHes /:id and replaces existing row', async () => {
    apiMock.get.mockResolvedValue({
      data: { integrations: [{ id: 'i1', name: 'Old', type: 'telegram_bot' }] },
    });
    apiMock.patch.mockResolvedValue({
      data: { id: 'i1', name: 'New', type: 'telegram_bot' },
    });
    const composable = useIntegrations();
    await composable.fetchAll();
    const res = await composable.updateIntegration('i1', { name: 'New' });
    expect(res.ok).toBe(true);
    expect(apiMock.patch).toHaveBeenCalledWith(
      '/integrations/i1',
      { name: 'New' },
    );
    expect(composable.integrations.value[0].name).toBe('New');
  });

  it('deleteIntegration DELETEs /:id and removes row', async () => {
    apiMock.get.mockResolvedValue({
      data: { integrations: [{ id: 'i1' }, { id: 'i2' }] },
    });
    apiMock.delete.mockResolvedValue({});
    const composable = useIntegrations();
    await composable.fetchAll();
    const res = await composable.deleteIntegration('i1');
    expect(res.ok).toBe(true);
    expect(apiMock.delete).toHaveBeenCalledWith('/integrations/i1');
    expect(composable.integrations.value.map((i) => i.id)).toEqual(['i2']);
  });

  it('triggerSync POSTs /:id/sync', async () => {
    apiMock.post.mockResolvedValue({ data: { runId: 'r-1' } });
    const composable = useIntegrations();
    const res = await composable.triggerSync('i1');
    expect(res.ok).toBe(true);
    expect(apiMock.post).toHaveBeenCalledWith('/integrations/i1/sync');
    if (res.ok) expect(res.value.runId).toBe('r-1');
  });

  it('listRuns GETs /:id/runs with limit', async () => {
    apiMock.get.mockResolvedValue({ data: { runs: [{ id: 'r1' }, { id: 'r2' }] } });
    const composable = useIntegrations();
    const res = await composable.listRuns('i1', 5);
    expect(res.ok).toBe(true);
    expect(apiMock.get).toHaveBeenCalledWith('/integrations/i1/runs', {
      params: { limit: 5 },
    });
    if (res.ok) expect(res.value).toHaveLength(2);
  });

  it('getGoogleOAuthUrl GETs /oauth/google/url', async () => {
    apiMock.get.mockResolvedValue({ data: { url: 'https://accounts.google.com/o' } });
    const composable = useIntegrations();
    const res = await composable.getGoogleOAuthUrl();
    expect(res.ok).toBe(true);
    expect(apiMock.get).toHaveBeenCalledWith('/integrations/oauth/google/url');
  });
});
