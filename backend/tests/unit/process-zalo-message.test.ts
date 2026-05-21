import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the downstream handler so we can inspect what processZaloMessage passes through
const handleIncomingMessageMock = vi.fn();

vi.mock('../../src/modules/chat/message-handler.js', () => ({
  handleIncomingMessage: handleIncomingMessageMock,
}));

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  prisma: { contact: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } },
}));

const { processZaloMessage, resolveZaloName, resolveGroupName } = await import(
  '../../src/modules/zalo/zalo-message-helpers.js'
);

function makeApi(overrides: any = {}) {
  return {
    getUserInfo: vi.fn().mockResolvedValue({
      changed_profiles: {
        'uid-1': { zaloName: 'Resolved Name', avatar: 'http://x/a.jpg' },
      },
    }),
    getGroupInfo: vi.fn().mockResolvedValue({
      gridInfoMap: { 'grp-1': { name: 'Resolved Group' } },
    }),
    ...overrides,
  };
}

describe('processZaloMessage', () => {
  beforeEach(() => {
    handleIncomingMessageMock.mockReset();
    handleIncomingMessageMock.mockResolvedValue({
      message: { id: 'm', conversationId: 'c' },
      conversationId: 'c',
      orgId: 'o',
      contactId: null,
      // Feature 0023 — required field on HandleMessageResult; default false
      // because none of these unit tests exercise the auto-promote path.
      tabPromoted: false,
    });
  });

  it('normalizes a 1-1 user message and resolves zaloName from API', async () => {
    const api = makeApi();
    await processZaloMessage({
      accountId: 'acc-1',
      api,
      message: {
        type: 0,
        threadId: 'uid-1',
        isSelf: false,
        data: {
          uidFrom: 'uid-1',
          dName: 'Fallback Name',
          content: 'Hello',
          msgType: 'webchat',
          msgId: 'mid-1',
          ts: String(1_700_000_000_000),
        },
      },
      isGroup: false,
      userInfoCache: new Map(),
    });

    expect(api.getUserInfo).toHaveBeenCalledWith('uid-1');
    const arg = handleIncomingMessageMock.mock.calls[0][0];
    expect(arg.senderName).toBe('Resolved Name'); // resolved API > dName fallback
    expect(arg.threadType).toBe('user');
    expect(arg.isSelf).toBe(false);
    expect(arg.timestamp).toBe(1_700_000_000_000);
    expect(arg.content).toBe('Hello');
    expect(arg.contentType).toBe('text');
  });

  it('falls back to dName when getUserInfo fails', async () => {
    const api = makeApi({
      getUserInfo: vi.fn().mockRejectedValue(new Error('zalo down')),
    });
    await processZaloMessage({
      accountId: 'acc-1',
      api,
      message: {
        type: 0,
        threadId: 'uid-1',
        isSelf: false,
        data: { uidFrom: 'uid-1', dName: 'Fallback Name', content: 'x', msgType: 'webchat', msgId: 'm', ts: '1' },
      },
      isGroup: false,
      userInfoCache: new Map(),
    });
    const arg = handleIncomingMessageMock.mock.calls[0][0];
    expect(arg.senderName).toBe('Fallback Name');
  });

  it('does NOT call getUserInfo for self messages', async () => {
    const api = makeApi();
    await processZaloMessage({
      accountId: 'acc-1',
      api,
      message: {
        type: 0,
        threadId: 'uid-target',
        isSelf: true,
        data: { uidFrom: 'me', dName: '', content: 'hi', msgType: 'webchat', msgId: 'm', ts: '1' },
      },
      isGroup: false,
      userInfoCache: new Map(),
    });
    expect(api.getUserInfo).not.toHaveBeenCalled();
  });

  it('resolves groupName for group messages', async () => {
    const api = makeApi();
    await processZaloMessage({
      accountId: 'acc-1',
      api,
      message: {
        type: 1,
        threadId: 'grp-1',
        isSelf: false,
        data: { uidFrom: 'uid-1', dName: 'M', content: 'x', msgType: 'webchat', msgId: 'm', ts: '1' },
      },
      isGroup: true,
      userInfoCache: new Map(),
    });
    expect(api.getGroupInfo).toHaveBeenCalledWith('grp-1');
    const arg = handleIncomingMessageMock.mock.calls[0][0];
    expect(arg.groupName).toBe('Resolved Group');
    expect(arg.threadType).toBe('group');
  });

  it('Feature 0034: forwards senderGlobalId from getUserInfo to handleIncomingMessage', async () => {
    const api = {
      getUserInfo: vi.fn().mockResolvedValue({
        changed_profiles: {
          'uid-1': {
            zaloName: 'Anh',
            avatar: 'http://x/a.jpg',
            globalId: 'gid-canonical-1',
          },
        },
      }),
      getGroupInfo: vi.fn(),
    };
    await processZaloMessage({
      accountId: 'acc-1',
      api,
      message: {
        type: 0,
        threadId: 'uid-1',
        isSelf: false,
        data: {
          uidFrom: 'uid-1',
          dName: '',
          content: 'hi',
          msgType: 'webchat',
          msgId: 'm',
          ts: '1',
        },
      },
      isGroup: false,
      userInfoCache: new Map(),
    });
    const arg = handleIncomingMessageMock.mock.calls[0][0];
    expect(arg.senderGlobalId).toBe('gid-canonical-1');
  });

  it('Feature 0034: senderGlobalId is null for self messages (no API call)', async () => {
    const api = {
      getUserInfo: vi.fn(),
      getGroupInfo: vi.fn(),
    };
    await processZaloMessage({
      accountId: 'acc-1',
      api,
      message: {
        type: 0,
        threadId: 'uid-target',
        isSelf: true,
        data: { uidFrom: 'me', dName: '', content: 'hi', msgType: 'webchat', msgId: 'm', ts: '1' },
      },
      isGroup: false,
      userInfoCache: new Map(),
    });
    const arg = handleIncomingMessageMock.mock.calls[0][0];
    expect(arg.senderGlobalId).toBeNull();
    expect(api.getUserInfo).not.toHaveBeenCalled();
  });

  it('stringifies non-string content', async () => {
    const api = makeApi();
    const richContent = { title: 'Hi', href: 'http://x' };
    await processZaloMessage({
      accountId: 'acc-1',
      api,
      message: {
        type: 0,
        threadId: 'uid-1',
        isSelf: false,
        data: { uidFrom: 'uid-1', dName: '', content: richContent, msgType: 'link', msgId: 'm', ts: '1' },
      },
      isGroup: false,
      userInfoCache: new Map(),
    });
    const arg = handleIncomingMessageMock.mock.calls[0][0];
    expect(arg.content).toBe(JSON.stringify(richContent));
    expect(arg.contentType).toBe('link');
  });
});

describe('resolveZaloName cache (5-minute TTL)', () => {
  it('returns cached value without calling the API on second invocation', async () => {
    const api = makeApi();
    const cache = new Map();
    const first = await resolveZaloName(api, 'uid-1', cache);
    const second = await resolveZaloName(api, 'uid-1', cache);
    // Feature 0034 — return shape now includes `globalId` (empty when the
    // mock profile doesn't surface one).
    expect(first).toEqual({
      zaloName: 'Resolved Name',
      avatar: 'http://x/a.jpg',
      globalId: '',
    });
    expect(second).toEqual(first);
    expect(api.getUserInfo).toHaveBeenCalledTimes(1);
  });

  it('returns empty defaults if API throws', async () => {
    const api = makeApi({ getUserInfo: vi.fn().mockRejectedValue(new Error('x')) });
    const r = await resolveZaloName(api, 'uid-1', new Map());
    expect(r).toEqual({ zaloName: '', avatar: '', globalId: '' });
  });

  it('Feature 0034: returns globalId when profile includes it', async () => {
    const api = {
      getUserInfo: vi.fn().mockResolvedValue({
        changed_profiles: {
          'uid-1': {
            zaloName: 'Anh',
            avatar: 'http://x/a.jpg',
            globalId: 'gid-canonical',
          },
        },
      }),
    };
    const r = await resolveZaloName(api, 'uid-1', new Map());
    expect(r).toEqual({
      zaloName: 'Anh',
      avatar: 'http://x/a.jpg',
      globalId: 'gid-canonical',
    });
  });

  it('Feature 0034: snake_case global_id is also read', async () => {
    const api = {
      getUserInfo: vi.fn().mockResolvedValue({
        changed_profiles: {
          'uid-1': {
            zalo_name: 'Anh',
            avatar: '',
            global_id: 'gid-snake',
          },
        },
      }),
    };
    const r = await resolveZaloName(api, 'uid-1', new Map());
    expect(r.globalId).toBe('gid-snake');
  });
});

describe('resolveGroupName', () => {
  it('returns empty string when getGroupInfo throws', async () => {
    const api = makeApi({ getGroupInfo: vi.fn().mockRejectedValue(new Error('x')) });
    expect(await resolveGroupName(api, 'grp-1')).toBe('');
  });
});
