/**
 * Component tests for MetricCard — Feature 0052a AC-0002.
 *
 * Stubs Vuetify wrappers (v-card / v-card-text) with lightweight passthroughs
 * so we only assert on the rendered text + class structure under our control.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MetricCard from '@/components/shared/MetricCard.vue';

const STUBS = {
  'v-card': { template: '<div class="v-card"><slot /></div>' },
  'v-card-text': { template: '<div class="v-card-text"><slot /></div>' },
};

describe('MetricCard', () => {
  it('renders value and label as text', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: { value: 42, label: 'Tin nhắn hôm nay' },
    });
    expect(wrapper.find('.metric-value').text()).toBe('42');
    expect(wrapper.find('.metric-label').text()).toBe('Tin nhắn hôm nay');
  });

  it('renders a string value verbatim (caller pre-formats)', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: { value: '12.345.678 ₫', label: 'Doanh thu' },
    });
    expect(wrapper.find('.metric-value').text()).toBe('12.345.678 ₫');
  });

  it('applies text-{attentionColor} class on the number when set', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: { value: 3, label: 'Chưa trả lời', attentionColor: 'warning' },
    });
    expect(wrapper.find('.metric-value').classes()).toContain('text-warning');
  });

  it('omits attention class when attentionColor not set', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: { value: 0, label: 'Chưa trả lời' },
    });
    const classes = wrapper.find('.metric-value').classes();
    expect(classes.some((c) => c.startsWith('text-warning'))).toBe(false);
    expect(classes.some((c) => c.startsWith('text-success'))).toBe(false);
  });

  it('hides the delta block when delta prop is absent', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: { value: 10, label: 'Số đơn' },
    });
    expect(wrapper.find('.metric-delta').exists()).toBe(false);
  });

  it('renders the delta block with text + suffix when delta is provided', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: {
        value: 1_234,
        label: 'Doanh thu',
        delta: { text: '+353.9%', color: 'success', suffix: 'so với kỳ trước' },
      },
    });
    const delta = wrapper.find('.metric-delta');
    expect(delta.exists()).toBe(true);
    expect(delta.text()).toContain('+353.9%');
    expect(delta.text()).toContain('so với kỳ trước');
  });

  it('applies text-{delta.color} to the delta text', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: {
        value: 100,
        label: 'KH mới',
        delta: { text: '-10%', color: 'error' },
      },
    });
    const span = wrapper.find('.metric-delta span');
    expect(span.classes()).toContain('text-error');
  });

  it('falls back to muted color when delta.color not provided', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: {
        value: 0,
        label: 'KH mới',
        delta: { text: '— —' },
      },
    });
    const span = wrapper.find('.metric-delta span');
    expect(span.classes()).toContain('text-medium-emphasis');
  });

  it('renders #prepend slot content above the value', () => {
    const wrapper = mount(MetricCard, {
      global: { stubs: STUBS },
      props: { value: 5, label: 'Lịch hẹn' },
      slots: { prepend: '<span class="custom-prepend">PIN</span>' },
    });
    expect(wrapper.find('.custom-prepend').exists()).toBe(true);
    expect(wrapper.find('.custom-prepend').text()).toBe('PIN');
  });
});
