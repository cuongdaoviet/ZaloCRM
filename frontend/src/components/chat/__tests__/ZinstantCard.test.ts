import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ZinstantCard from '@/components/chat/ZinstantCard.vue';
import type { ZinstantData } from '@/utils/parse-zinstant';

// Vuetify components used inside the card need stubbing because we don't
// mount a full Vuetify app for unit tests. v-icon is a no-op span,
// v-snackbar renders its slot so we can assert toast text.
const STUBS = {
  'v-icon': { template: '<i class="v-icon"><slot /></i>' },
  'v-snackbar': {
    props: ['modelValue', 'color', 'timeout'],
    template:
      '<div v-if="modelValue" class="v-snackbar" :data-color="color"><slot /></div>',
  },
};

const fullData: ZinstantData = {
  bankCode: 'BIDV',
  bankName: 'BIDV',
  accountNumber: '4271001234567',
  accountName: 'NGUYEN VAN A',
  amount: 500000,
  description: 'Thanh toan don hang 123',
  qrUrl: 'https://example.com/qr.png',
};

describe('ZinstantCard', () => {
  beforeEach(() => {
    // Reset clipboard stub each test
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('renders bank name, account number, name, amount, description (AC-0002)', () => {
    const wrapper = mount(ZinstantCard, {
      props: { data: fullData },
      global: { stubs: STUBS },
    });
    expect(wrapper.text()).toContain('BIDV');
    expect(wrapper.text()).toContain('4271001234567');
    expect(wrapper.text()).toContain('NGUYEN VAN A');
    expect(wrapper.text()).toContain('Thanh toan don hang 123');
    expect(wrapper.find('img.zinstant-qr').exists()).toBe(true);
  });

  it('hides amount when null and description when empty', () => {
    const wrapper = mount(ZinstantCard, {
      props: {
        data: {
          ...fullData,
          amount: null,
          description: '',
        },
      },
      global: { stubs: STUBS },
    });
    expect(wrapper.find('.zinstant-amount').exists()).toBe(false);
    expect(wrapper.find('.zinstant-desc').exists()).toBe(false);
  });

  it('copies account number to clipboard on click (AC-0003)', async () => {
    const wrapper = mount(ZinstantCard, {
      props: { data: fullData },
      global: { stubs: STUBS },
    });
    await wrapper.find('.zinstant-account').trigger('click');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('4271001234567');
    // Wait for next tick so the snackbar binding updates
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.v-snackbar').exists()).toBe(true);
    expect(wrapper.find('.v-snackbar').text()).toContain('Đã copy');
  });

  it('emits "preview" with QR url when QR clicked (AC-0004)', async () => {
    const wrapper = mount(ZinstantCard, {
      props: { data: fullData },
      global: { stubs: STUBS },
    });
    await wrapper.find('img.zinstant-qr').trigger('click');
    expect(wrapper.emitted('preview')?.[0]).toEqual([fullData.qrUrl]);
  });

  it('swaps to placeholder when QR image errors (EC-0003)', async () => {
    const wrapper = mount(ZinstantCard, {
      props: { data: fullData },
      global: { stubs: STUBS },
    });
    await wrapper.find('img.zinstant-qr').trigger('error');
    expect(wrapper.find('img.zinstant-qr').exists()).toBe(false);
    expect(wrapper.find('.zinstant-qr-placeholder').exists()).toBe(true);
    expect(wrapper.text()).toContain('QR không tải được');
  });

  it('shows error toast when clipboard write rejects (EC-0004)', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      },
    });
    const wrapper = mount(ZinstantCard, {
      props: { data: fullData },
      global: { stubs: STUBS },
    });
    await wrapper.find('.zinstant-account').trigger('click');
    // Allow promise rejection chain + nextTick to settle
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    const snack = wrapper.find('.v-snackbar');
    expect(snack.exists()).toBe(true);
    expect(snack.attributes('data-color')).toBe('error');
  });
});
