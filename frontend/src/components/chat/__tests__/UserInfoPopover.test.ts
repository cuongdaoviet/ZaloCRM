/**
 * Frontend unit tests for Feature 0030 — UserInfoPopover.vue.
 *
 * Covers:
 *  - AC-0008: open=true + uid + accountId → fetches and renders info.
 *  - AC-0010: "Tạo Contact" emits create-contact with prefill payload.
 *  - "Xem trong CRM" branch when contactId is set.
 *  - Esc key emits close.
 *
 * Self-avatar skip (AC-0009) is enforced in MessageThread.onAvatarClick,
 * exercised separately (no popover mount happens at all in that path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import UserInfoPopover from '@/components/chat/UserInfoPopover.vue';

// Hoisted mock state — `vi.mock` is hoisted, so any vars it references
// must be inside the factory (or hoisted with vi.hoisted).
const apiState = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/api/index', () => ({
  api: {
    get: (...args: unknown[]) => apiState.get(...args),
  },
}));

const STUBS = {
  'v-progress-circular': { template: '<div class="stub-spinner" />' },
  'v-avatar': { template: '<div class="stub-avatar"><slot /></div>' },
  'v-img': {
    template: '<img class="stub-img" :src="src" :alt="alt" />',
    props: ['src', 'alt'],
  },
  'v-icon': { template: '<i class="stub-icon"><slot /></i>' },
  'v-btn': {
    template: '<button class="stub-btn" @click="$emit(\'click\')"><slot /></button>',
    emits: ['click'],
  },
  'v-spacer': { template: '<span class="stub-spacer" />' },
  'v-divider': { template: '<hr class="stub-divider" />' },
};

function makeAnchor(): HTMLElement {
  const el = document.createElement('button');
  document.body.appendChild(el);
  // jsdom returns zeros for getBoundingClientRect — override to test
  // the right-of-anchor positioning branch.
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () =>
      ({ left: 100, right: 140, top: 200, bottom: 240, width: 40, height: 40 }) as DOMRect,
  });
  return el;
}

function purgeDom() {
  // Avoid setting innerHTML (security-hook flags it). Replacing the body
  // node achieves the same teardown without using innerHTML.
  const fresh = document.createElement('body');
  document.body.replaceWith(fresh);
}

describe('UserInfoPopover (Feature 0030)', () => {
  beforeEach(() => {
    apiState.get.mockReset();
  });
  afterEach(() => {
    purgeDom();
  });

  it('AC-0008: fetches user info on mount when open=true', async () => {
    apiState.get.mockResolvedValue({
      data: {
        uid: '111',
        displayName: 'Lan Anh',
        avatarUrl: 'https://cdn/avatar.jpg',
        gender: 'female',
        phone: '0901234567',
        contactId: null,
        online: true,
        cached: false,
      },
    });

    const wrapper = mount(UserInfoPopover, {
      props: { open: true, uid: '111', accountId: 'acc-1', anchorEl: makeAnchor() },
      global: { stubs: STUBS },
    });
    await flushPromises();

    expect(apiState.get).toHaveBeenCalledWith(
      '/zalo/users/111',
      expect.objectContaining({ params: { accountId: 'acc-1' } }),
    );
    expect(wrapper.text()).toContain('Lan Anh');
    expect(wrapper.text()).toContain('111');
    expect(wrapper.text()).toContain('0901234567');
    // contactId null → shows "Tạo Contact"
    expect(wrapper.text()).toContain('Tạo Contact');
    expect(wrapper.text()).not.toContain('Xem trong CRM');
  });

  it('AC-0010: clicking "Tạo Contact" emits create-contact with prefill', async () => {
    apiState.get.mockResolvedValue({
      data: {
        uid: '222',
        displayName: 'Khách Mới',
        avatarUrl: 'https://cdn/x.jpg',
        gender: null,
        phone: '0902345678',
        contactId: null,
        online: true,
        cached: false,
      },
    });
    const wrapper = mount(UserInfoPopover, {
      props: { open: true, uid: '222', accountId: 'acc-1', anchorEl: makeAnchor() },
      global: { stubs: STUBS },
    });
    await flushPromises();

    const btns = wrapper.findAll('button.stub-btn');
    const create = btns.find((b) => b.text().includes('Tạo Contact'));
    expect(create).toBeTruthy();
    await create!.trigger('click');

    const events = wrapper.emitted('create-contact');
    expect(events).toBeTruthy();
    expect(events![0]![0]).toEqual({
      fullName: 'Khách Mới',
      zaloUid: '222',
      avatarUrl: 'https://cdn/x.jpg',
      phone: '0902345678',
    });
  });

  it('renders "Xem trong CRM" when contactId is set', async () => {
    apiState.get.mockResolvedValue({
      data: {
        uid: '333',
        displayName: 'Đã có',
        avatarUrl: null,
        gender: null,
        phone: null,
        contactId: 'contact-uuid-99',
        online: true,
        cached: false,
      },
    });
    const wrapper = mount(UserInfoPopover, {
      props: { open: true, uid: '333', accountId: 'acc-1', anchorEl: makeAnchor() },
      global: { stubs: STUBS },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Xem trong CRM');
    expect(wrapper.text()).not.toContain('Tạo Contact');

    const view = wrapper
      .findAll('button.stub-btn')
      .find((b) => b.text().includes('Xem trong CRM'));
    await view!.trigger('click');
    expect(wrapper.emitted('open-contact')?.[0]?.[0]).toBe('contact-uuid-99');
  });

  it('shows offline warning when info.online=false', async () => {
    apiState.get.mockResolvedValue({
      data: {
        uid: '444',
        displayName: 'Unknown',
        avatarUrl: null,
        gender: null,
        phone: null,
        contactId: null,
        online: false,
        cached: false,
      },
    });
    const wrapper = mount(UserInfoPopover, {
      props: { open: true, uid: '444', accountId: 'acc-1', anchorEl: makeAnchor() },
      global: { stubs: STUBS },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('offline');
  });

  it('Esc key emits close', async () => {
    apiState.get.mockResolvedValue({
      data: {
        uid: '555',
        displayName: 'A',
        avatarUrl: null,
        gender: null,
        phone: null,
        contactId: null,
        online: true,
        cached: false,
      },
    });
    const wrapper = mount(UserInfoPopover, {
      props: { open: true, uid: '555', accountId: 'acc-1', anchorEl: makeAnchor() },
      attachTo: document.body,
      global: { stubs: STUBS },
    });
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.emitted('close')).toBeTruthy();
    wrapper.unmount();
  });

  it('does not fetch when open=false', async () => {
    mount(UserInfoPopover, {
      props: { open: false, uid: '666', accountId: 'acc-1', anchorEl: null },
      global: { stubs: STUBS },
    });
    await flushPromises();
    expect(apiState.get).not.toHaveBeenCalled();
  });
});
