/**
 * Component tests for FunnelChart — Feature 0041 AC-0009.
 *
 * Verifies the chart renders one row per funnel stage with the correct count
 * + conversion-rate label, and surfaces the "lost" exit branch only when
 * non-zero.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FunnelChart from '@/components/analytics/FunnelChart.vue';
import type { FunnelResponse } from '@/composables/use-analytics';

// Stub Vuetify wrappers — we only care about the rendered HTML structure
// (rows, counts, rates), not Vuetify's runtime.
const STUBS = {
  'v-card': { template: '<div class="v-card"><slot /></div>' },
  'v-card-title': { template: '<div class="v-card-title"><slot /></div>' },
  'v-card-text': { template: '<div class="v-card-text"><slot /></div>' },
  'v-icon': { template: '<i class="v-icon"><slot /></i>' },
  'v-spacer': { template: '<span class="v-spacer" />' },
};

function makeData(overrides: Partial<FunnelResponse> = {}): FunnelResponse {
  return {
    stages: [
      { name: 'new', count: 100, conversionRate: null },
      { name: 'contacted', count: 60, conversionRate: 60 },
      { name: 'interested', count: 30, conversionRate: 50 },
      { name: 'converted', count: 10, conversionRate: 33 },
    ],
    lost: { count: 5 },
    totalContacts: 205,
    period: { dateFrom: '2026-04-01T00:00:00Z', dateTo: '2026-05-01T00:00:00Z' },
    ...overrides,
  };
}

describe('FunnelChart', () => {
  it('renders one row per stage', () => {
    const wrapper = mount(FunnelChart, {
      global: { stubs: STUBS },
      props: { data: makeData() },
    });
    const rows = wrapper.findAll('.funnel-row');
    expect(rows).toHaveLength(4);
  });

  it('renders Vietnamese stage labels in funnel order', () => {
    const wrapper = mount(FunnelChart, {
      global: { stubs: STUBS },
      props: { data: makeData() },
    });
    const labels = wrapper.findAll('.funnel-row-label').map((w) => w.text());
    expect(labels).toEqual(['Mới', 'Đã liên hệ', 'Quan tâm', 'Chuyển đổi']);
  });

  it('formats counts with thousand separators (vi-VN)', () => {
    const wrapper = mount(FunnelChart, {
      global: { stubs: STUBS },
      props: {
        data: makeData({
          stages: [
            { name: 'new', count: 12_345, conversionRate: null },
            { name: 'contacted', count: 6_000, conversionRate: 49 },
            { name: 'interested', count: 1_500, conversionRate: 25 },
            { name: 'converted', count: 230, conversionRate: 15 },
          ],
        }),
      },
    });
    const counts = wrapper.findAll('.funnel-row-count').map((w) => w.text());
    // vi-VN uses '.' as thousand separator (some Node ICU builds emit U+00A0 or ',').
    expect(counts[0]).toMatch(/12[.,  ]345/);
  });

  it('renders dash for null conversion rate on the first stage', () => {
    const wrapper = mount(FunnelChart, {
      global: { stubs: STUBS },
      props: { data: makeData() },
    });
    const rates = wrapper.findAll('.funnel-row-rate').map((w) => w.text());
    expect(rates[0]).toBe('—');
    expect(rates[1]).toBe('60%');
    expect(rates[2]).toBe('50%');
    expect(rates[3]).toBe('33%');
  });

  it('shows the lost-row when lost.count > 0', () => {
    const wrapper = mount(FunnelChart, {
      global: { stubs: STUBS },
      props: { data: makeData({ lost: { count: 7 } }) },
    });
    expect(wrapper.find('.funnel-lost').exists()).toBe(true);
    expect(wrapper.find('.funnel-lost').text()).toContain('7');
  });

  it('hides the lost-row when lost.count is zero', () => {
    const wrapper = mount(FunnelChart, {
      global: { stubs: STUBS },
      props: { data: makeData({ lost: { count: 0 } }) },
    });
    expect(wrapper.find('.funnel-lost').exists()).toBe(false);
  });

  it('renders an empty state when data is null', () => {
    const wrapper = mount(FunnelChart, {
      global: { stubs: STUBS },
      props: { data: null },
    });
    expect(wrapper.text()).toContain('Không có dữ liệu');
    expect(wrapper.findAll('.funnel-row')).toHaveLength(0);
  });

  it('sizes each bar relative to the largest stage', () => {
    const wrapper = mount(FunnelChart, {
      global: { stubs: STUBS },
      props: {
        data: makeData({
          stages: [
            { name: 'new', count: 100, conversionRate: null },
            { name: 'contacted', count: 50, conversionRate: 50 },
            { name: 'interested', count: 25, conversionRate: 50 },
            { name: 'converted', count: 0, conversionRate: 0 },
          ],
        }),
      },
    });
    const bars = wrapper.findAll('.funnel-bar');
    const styles = bars.map((b) => b.attributes('style') ?? '');
    // First (biggest) bar is 100%; halves halve.
    expect(styles[0]).toContain('width: 100%');
    expect(styles[1]).toContain('width: 50%');
  });
});
