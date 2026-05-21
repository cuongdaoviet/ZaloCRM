/**
 * StickerPicker — Feature 0028 (AC-0008 partial: picker UX).
 *
 * Boots the picker with a stubbed `api.get` resolver, asserts:
 *  - catalogues are fetched on mount
 *  - sticker grid renders ≥ 1 item once catalogue resolves
 *  - clicking a sticker emits `select` with the {stickerId, catId, type}
 *  - clicking the close button emits `close`
 *  - error state surfaces a retry button when the catalogue fetch fails
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('@/api/index', () => ({
  api: {
    get: vi.fn(),
  },
}));

import StickerPicker from '@/components/chat/StickerPicker.vue';
import { api } from '@/api/index';

const STUBS = {
  'v-icon': { template: '<i><slot /></i>' },
};

const sampleCatalogue = {
  catalogues: [
    {
      id: 1,
      name: 'Default',
      stickers: [
        { stickerId: 4179, catId: 1, type: 1 },
        { stickerId: 4180, catId: 1, type: 1 },
        { stickerId: 4181, catId: 1, type: 1 },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StickerPicker', () => {
  it('fetches catalogues on mount and renders the sticker grid', async () => {
    (api.get as any).mockImplementation((url: string) => {
      if (url === '/zalo/sticker-catalogues') {
        return Promise.resolve({ data: sampleCatalogue });
      }
      // sticker detail — return a CDN url so <img> renders.
      return Promise.resolve({
        data: { cdnUrl: 'https://cdn.zalo.test/sticker.webp' },
      });
    });
    const wrapper = mount(StickerPicker, {
      props: { accountId: 'acc-1' },
      global: { stubs: STUBS },
    });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith(
      '/zalo/sticker-catalogues',
      expect.objectContaining({ params: { accountId: 'acc-1' } }),
    );
    const items = wrapper.findAll('.sticker-picker__item');
    expect(items.length).toBe(3);
  });

  it('emits `select` with the sticker triplet on click', async () => {
    (api.get as any).mockImplementation((url: string) => {
      if (url === '/zalo/sticker-catalogues') {
        return Promise.resolve({ data: sampleCatalogue });
      }
      return Promise.resolve({ data: { cdnUrl: 'https://cdn/x.webp' } });
    });
    const wrapper = mount(StickerPicker, {
      props: { accountId: 'acc-1' },
      global: { stubs: STUBS },
    });
    await flushPromises();
    await wrapper.findAll('.sticker-picker__item')[1].trigger('click');
    const emitted = wrapper.emitted('select');
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toEqual({ stickerId: 4180, catId: 1, type: 1 });
  });

  it('emits `close` when the close button is clicked', async () => {
    (api.get as any).mockResolvedValue({ data: sampleCatalogue });
    const wrapper = mount(StickerPicker, {
      props: { accountId: 'acc-1' },
      global: { stubs: STUBS },
    });
    await flushPromises();
    await wrapper.find('.sticker-picker__close').trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('renders the retry control when the catalogue fetch fails', async () => {
    (api.get as any).mockRejectedValueOnce(new Error('boom'));
    const wrapper = mount(StickerPicker, {
      props: { accountId: 'acc-1' },
      global: { stubs: STUBS },
    });
    await flushPromises();
    expect(wrapper.find('.sticker-picker__retry').exists()).toBe(true);
    expect(wrapper.findAll('.sticker-picker__item')).toHaveLength(0);
  });
});
