/**
 * Component tests for TeamPerfTable — Feature 0041 AC-0010.
 *
 * The real v-data-table is hard to mount without a full Vuetify install, so we
 * stub it with a lightweight version that:
 *  - exposes the `headers` array on the root for `sortable` introspection
 *  - renders each row by name-slot so the cell formatters under test still run
 *
 * AC-0010 ("sortable") is verified by asserting every header declares
 * `sortable: true`. The actual click-to-sort behavior is Vuetify-native and
 * out of scope here.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import TeamPerfTable from '@/components/analytics/TeamPerfTable.vue';
import type { TeamPerfResponse, TeamPerfRow } from '@/composables/use-analytics';

interface HeaderDef {
  key: string;
  sortable?: boolean;
}
type SlotFn = (props: { item: TeamPerfRow }) => unknown;

// v-data-table stub — render each cell using the column-specific named slots
// so the formatter logic under test (responseClass, formatMinutes…) runs.
const VDataTableStub = defineComponent({
  name: 'VDataTableStub',
  props: {
    headers: { type: Array, required: true },
    items: { type: Array, required: true },
    loading: Boolean,
    noDataText: String,
    density: String,
    hideDefaultFooter: Boolean,
    itemsPerPage: [String, Number],
  },
  setup(props, { slots }) {
    return () => {
      const headers = props.headers as HeaderDef[];
      const items = props.items as TeamPerfRow[];
      return h('table', { 'data-test': 'tp-table' }, [
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            headers.map((hdr) =>
              h(
                'th',
                {
                  key: hdr.key,
                  'data-key': hdr.key,
                  'data-sortable': String(hdr.sortable ?? false),
                },
                hdr.key,
              ),
            ),
          ),
        ),
        h(
          'tbody',
          {},
          items.map((item, idx) =>
            h(
              'tr',
              { key: idx, 'data-test': 'tp-row' },
              headers.map((hdr) => {
                const slotFn = slots[`item.${hdr.key}`] as SlotFn | undefined;
                const content = slotFn
                  ? (slotFn({ item }) as string | object)
                  : String((item as unknown as Record<string, unknown>)[hdr.key]);
                return h(
                  'td',
                  { key: hdr.key, 'data-cell': hdr.key },
                  content as never,
                );
              }),
            ),
          ),
        ),
      ]);
    };
  },
});

const STUBS = {
  'v-card': { template: '<div class="v-card"><slot /></div>' },
  'v-card-title': { template: '<div class="v-card-title"><slot /></div>' },
  'v-icon': { template: '<i class="v-icon"><slot /></i>' },
  'v-spacer': { template: '<span class="v-spacer" />' },
  'v-data-table': VDataTableStub,
};

function makeData(overrides: Partial<TeamPerfResponse> = {}): TeamPerfResponse {
  return {
    byUser: [
      {
        userId: 'u1',
        fullName: 'Lan Anh',
        avgResponseTimeMinutes: 12.4,
        outboundMessageCount: 432,
        convertedContactsCount: 8,
        activeConversationsCount: 34,
      },
      {
        userId: 'u2',
        fullName: 'Bình',
        avgResponseTimeMinutes: null,
        outboundMessageCount: 0,
        convertedContactsCount: 0,
        activeConversationsCount: 0,
      },
    ],
    totals: { outboundMessageCount: 432, convertedContactsCount: 8 },
    period: { dateFrom: '2026-04-01T00:00:00Z', dateTo: '2026-05-01T00:00:00Z' },
    ...overrides,
  };
}

describe('TeamPerfTable', () => {
  it('renders one row per rep', () => {
    const wrapper = mount(TeamPerfTable, {
      global: { stubs: STUBS },
      props: { data: makeData() },
    });
    expect(wrapper.findAll('[data-test="tp-row"]')).toHaveLength(2);
  });

  it('AC-0010: every column declares sortable=true', () => {
    const wrapper = mount(TeamPerfTable, {
      global: { stubs: STUBS },
      props: { data: makeData() },
    });
    const headers = wrapper.findAll('th');
    expect(headers.length).toBeGreaterThan(0);
    for (const th of headers) {
      expect(th.attributes('data-sortable')).toBe('true');
    }
  });

  it('renders dash for null avgResponseTimeMinutes (EC-0003)', () => {
    const wrapper = mount(TeamPerfTable, {
      global: { stubs: STUBS },
      props: { data: makeData() },
    });
    const cells = wrapper.findAll('td[data-cell="avgResponseTimeMinutes"]');
    expect(cells[0].text()).toMatch(/12[.,]4/);
    expect(cells[1].text()).toBe('—');
  });

  it('formats integer counts with thousand separators', () => {
    const wrapper = mount(TeamPerfTable, {
      global: { stubs: STUBS },
      props: {
        data: makeData({
          byUser: [
            {
              userId: 'u1',
              fullName: 'Big',
              avgResponseTimeMinutes: 5,
              outboundMessageCount: 12_345,
              convertedContactsCount: 1_234,
              activeConversationsCount: 99,
            },
          ],
        }),
      },
    });
    const outbound = wrapper.find('td[data-cell="outboundMessageCount"]').text();
    expect(outbound).toMatch(/12[.,  ]345/);
  });

  it('renders totals chip in the title bar', () => {
    const wrapper = mount(TeamPerfTable, {
      global: { stubs: STUBS },
      props: { data: makeData({ totals: { outboundMessageCount: 1_000, convertedContactsCount: 50 } }) },
    });
    // The string contains both totals — be liberal about separator format.
    expect(wrapper.find('.v-card-title').text()).toContain('1');
    expect(wrapper.find('.v-card-title').text()).toContain('50');
  });
});
