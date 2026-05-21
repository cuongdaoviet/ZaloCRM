/**
 * MessageThread sticker render — Feature 0028.
 *
 *  - AC-0002: a message with contentType='sticker' that carries a CDN URL
 *    in its JSON content renders an `<img class="chat-sticker">`, NOT a
 *    fallback text placeholder.
 *  - Sticker button is hidden when no accountId is provided (read-only).
 *  - Sticker button is shown when conversation has a zaloAccountId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';

// Stub network-touching modules used by MessageThread.
vi.mock('@/api/index', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { catalogues: [] } }), post: vi.fn() },
}));
vi.mock('@/composables/use-quick-replies', () => ({
  useQuickReplies: () => ({ replies: { value: [] }, fetchReplies: vi.fn() }),
  substitutePlaceholders: (s: string) => s,
}));
vi.mock('@/composables/use-appointment-parser', () => ({
  useAppointmentParser: () => ({
    parseLatestIncoming: vi.fn().mockResolvedValue(null),
  }),
}));
vi.mock('@/composables/use-contact-name', () => ({
  secondaryZaloName: () => null,
}));

import MessageThread from '@/components/chat/MessageThread.vue';

// Minimum Vuetify stub set so the template renders in jsdom.
const STUBS = {
  'v-icon': { template: '<i><slot /></i>' },
  'v-btn': {
    template: '<button :class="$attrs.class" v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
    emits: ['click'],
  },
  'v-avatar': { template: '<div><slot /></div>' },
  'v-img': { template: '<img />' },
  'v-progress-linear': { template: '<div />' },
  'v-textarea': { template: '<textarea />' },
  'v-snackbar': { template: '<div />' },
  'v-dialog': { template: '<div><slot /></div>' },
  'v-card': { template: '<div><slot /></div>' },
  'v-chip': { template: '<span><slot /></span>' },
  // Children components we don't need to test transitively.
  StickerPicker: { template: '<div class="stub-sticker-picker" />' },
  QuickReplyPopover: { template: '<div />' },
  ReactionPicker: { template: '<div />' },
  ReactionChips: { template: '<div />' },
  UserInfoPopover: { template: '<div />' },
};

const conv = {
  id: 'c1',
  threadType: 'user' as const,
  contact: { id: 'k1', fullName: 'Khách', avatarUrl: null },
  zaloAccount: { id: 'a1', displayName: 'A' },
  lastMessageAt: null,
  unreadCount: 0,
  isReplied: false,
};

function stickerMessage(content: string) {
  return {
    id: 'm1',
    content,
    contentType: 'sticker',
    senderType: 'self',
    senderName: 'me',
    senderUid: null,
    sentAt: new Date().toISOString(),
    isDeleted: false,
    zaloMsgId: '9001',
    reactions: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MessageThread sticker rendering', () => {
  it('renders <img.chat-sticker> when contentType=sticker has a cdnUrl', async () => {
    const msg = stickerMessage(
      JSON.stringify({
        stickerId: 4179,
        catId: 1,
        type: 1,
        cdnUrl: 'https://cdn.zalo.test/stickers/4179.webp',
      }),
    );
    const wrapper = mount(MessageThread, {
      props: {
        conversation: conv as any,
        messages: [msg as any],
        loading: false,
        sending: false,
      },
      global: { stubs: STUBS },
    });
    const img = wrapper.find('img.chat-sticker');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe(
      'https://cdn.zalo.test/stickers/4179.webp',
    );
    // No fallback text "Sticker" string should be visible.
    expect(wrapper.find('.sticker-cell span.text-grey').exists()).toBe(false);
  });

  it('falls back to caption when sticker JSON has no usable URL', () => {
    const msg = stickerMessage(JSON.stringify({ stickerId: 4179, catId: 1, type: 1 }));
    const wrapper = mount(MessageThread, {
      props: {
        conversation: conv as any,
        messages: [msg as any],
        loading: false,
        sending: false,
      },
      global: { stubs: STUBS },
    });
    expect(wrapper.find('img.chat-sticker').exists()).toBe(false);
    expect(wrapper.find('.sticker-cell').text()).toContain('Sticker');
  });

  it('shows the composer sticker button when conversation has a zaloAccountId', () => {
    const wrapper = mount(MessageThread, {
      props: {
        conversation: conv as any,
        messages: [],
        loading: false,
        sending: false,
      },
      global: { stubs: STUBS },
    });
    expect(wrapper.find('.sticker-launcher').exists()).toBe(true);
    expect(wrapper.find('.sticker-btn').exists()).toBe(true);
  });

  it('hides the composer sticker button when conversation has no Zalo account', () => {
    const readOnly = { ...conv, zaloAccount: null };
    const wrapper = mount(MessageThread, {
      props: {
        conversation: readOnly as any,
        messages: [],
        loading: false,
        sending: false,
      },
      global: { stubs: STUBS },
    });
    expect(wrapper.find('.sticker-launcher').exists()).toBe(false);
  });

  it('opens the picker when the sticker button is clicked', async () => {
    const wrapper = mount(MessageThread, {
      props: {
        conversation: conv as any,
        messages: [],
        loading: false,
        sending: false,
      },
      global: { stubs: STUBS },
    });
    expect(wrapper.find('.stub-sticker-picker').exists()).toBe(false);
    await wrapper.find('.sticker-btn').trigger('click');
    expect(wrapper.find('.stub-sticker-picker').exists()).toBe(true);
  });
});
