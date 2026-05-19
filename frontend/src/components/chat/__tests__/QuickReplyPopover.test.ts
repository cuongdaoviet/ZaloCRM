import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import QuickReplyPopover from '@/components/chat/QuickReplyPopover.vue';
import type { QuickReply } from '@/composables/use-quick-replies';

// Vuetify components used inside the popover (v-chip) need to be stubbed
// because we don't mount a Vuetify app for a unit-level test.
const STUBS = {
  'v-chip': { template: '<span><slot /></span>' },
};

const mockReplies: QuickReply[] = [
  {
    id: '1', shortcut: 'chao', content: 'Chào bạn',
    scope: 'user', createdByUserId: 'u1', createdByName: 'A',
    createdAt: '', updatedAt: '',
  },
  {
    id: '2', shortcut: 'chao_vp', content: 'Chào VIP',
    scope: 'org', createdByUserId: 'u1', createdByName: 'A',
    createdAt: '', updatedAt: '',
  },
  {
    id: '3', shortcut: 'gia', content: 'Bảng giá: ...',
    scope: 'user', createdByUserId: 'u1', createdByName: 'A',
    createdAt: '', updatedAt: '',
  },
];

describe('QuickReplyPopover', () => {
  it('does not render when open=false', () => {
    const wrapper = mount(QuickReplyPopover, {
      props: { open: false, query: '', replies: mockReplies, highlightedIndex: 0 },
      global: { stubs: STUBS },
    });
    expect(wrapper.find('.quick-reply-popover').exists()).toBe(false);
  });

  it('renders all replies when query is empty', () => {
    const wrapper = mount(QuickReplyPopover, {
      props: { open: true, query: '', replies: mockReplies, highlightedIndex: 0 },
      global: { stubs: STUBS },
    });
    const items = wrapper.findAll('.popover-item');
    expect(items).toHaveLength(3);
  });

  it('filters by shortcut prefix (case-insensitive)', () => {
    const wrapper = mount(QuickReplyPopover, {
      props: { open: true, query: 'chao', replies: mockReplies, highlightedIndex: 0 },
      global: { stubs: STUBS },
    });
    const items = wrapper.findAll('.popover-item');
    // chao + chao_vp match
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain('/chao');
    expect(items[1].text()).toContain('/chao_vp');
  });

  it('shows "no match" when query matches nothing', () => {
    const wrapper = mount(QuickReplyPopover, {
      props: { open: true, query: 'xyz', replies: mockReplies, highlightedIndex: 0 },
      global: { stubs: STUBS },
    });
    expect(wrapper.find('.popover-item').exists()).toBe(false);
    expect(wrapper.find('.popover-empty').text()).toContain('Không tìm thấy');
    expect(wrapper.find('.popover-empty').text()).toContain('xyz');
  });

  it('does not render empty state when query is empty and no replies', () => {
    const wrapper = mount(QuickReplyPopover, {
      props: { open: true, query: '', replies: [], highlightedIndex: 0 },
      global: { stubs: STUBS },
    });
    expect(wrapper.find('.quick-reply-popover').exists()).toBe(false);
  });

  it('marks the highlighted index as active', () => {
    const wrapper = mount(QuickReplyPopover, {
      props: { open: true, query: '', replies: mockReplies, highlightedIndex: 1 },
      global: { stubs: STUBS },
    });
    const items = wrapper.findAll('.popover-item');
    expect(items[0].classes()).not.toContain('active');
    expect(items[1].classes()).toContain('active');
    expect(items[2].classes()).not.toContain('active');
  });

  it('caps display at 8 items', () => {
    const many: QuickReply[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i), shortcut: `s${i}`, content: 'x',
      scope: 'user' as const, createdByUserId: 'u1', createdByName: 'A',
      createdAt: '', updatedAt: '',
    }));
    const wrapper = mount(QuickReplyPopover, {
      props: { open: true, query: '', replies: many, highlightedIndex: 0 },
      global: { stubs: STUBS },
    });
    expect(wrapper.findAll('.popover-item')).toHaveLength(8);
  });

  it('emits select event with the chosen reply', async () => {
    const wrapper = mount(QuickReplyPopover, {
      props: { open: true, query: '', replies: mockReplies, highlightedIndex: 0 },
      global: { stubs: STUBS },
    });
    await wrapper.findAll('.popover-item')[1].trigger('click');
    const emitted = wrapper.emitted('select');
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toMatchObject({ id: '2', shortcut: 'chao_vp' });
  });

  it('emits hover with the index when an item is hovered', async () => {
    const wrapper = mount(QuickReplyPopover, {
      props: { open: true, query: '', replies: mockReplies, highlightedIndex: 0 },
      global: { stubs: STUBS },
    });
    await wrapper.findAll('.popover-item')[2].trigger('mouseenter');
    expect(wrapper.emitted('hover')?.[0]).toEqual([2]);
  });
});
