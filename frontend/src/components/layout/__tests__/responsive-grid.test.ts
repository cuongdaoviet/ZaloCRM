/**
 * Feature 0039 AC-0007 — responsive grid contract for FriendsView.
 *
 * Locks the `cols="12" sm="6" md="4"` triplet on the v-col that wraps
 * each FriendCard. Vuetify resolves these to a 1-column layout at xs,
 * 2-column at sm, and 3-column at md+. If a future refactor reshuffles
 * the breakpoints we want this test to flag it before merging.
 *
 * jsdom can't measure rendered widths, so we read the SFC template
 * source directly — same shape as the touch-target test.
 */
/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// See MobileBottomNav.touch-target.test.ts for the rationale on reading
// SFC source text via `fs.readFileSync` instead of Vite's `?raw` (CSS
// files come back empty when vitest's `css: false` is on, so we use the
// same fs strategy for consistency).
const here = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(resolve(here, '../../../', rel), 'utf-8');
}

const appVue = readSrc('App.vue');
const friendsViewVue = readSrc('views/FriendsView.vue');
const contactsViewVue = readSrc('views/ContactsView.vue');
const chatViewVue = readSrc('views/ChatView.vue');

describe('Feature 0039 AC-0007 — Friends responsive grid', () => {
  it('FriendsView renders FriendCard inside a v-col with 1/2/3-col breakpoints', () => {
    const src = friendsViewVue;
    // Match the v-col tag whose body contains the FriendCard. The
    // attribute order can drift across edits so we assert each one
    // separately rather than the literal element.
    const friendColRegion = src.match(
      /<v-col[\s\S]*?<FriendCard/,
    );
    expect(friendColRegion, 'FriendCard must be wrapped in a v-col').not.toBeNull();
    const region = friendColRegion![0];
    expect(region).toMatch(/cols="12"/);
    expect(region).toMatch(/sm="6"/);
    expect(region).toMatch(/md="4"/);
  });

  it('skeleton loader row mirrors the same breakpoint triplet', () => {
    const src = friendsViewVue;
    // Find a v-col that contains a v-skeleton-loader so we cover the
    // initial loading state, not just the populated grid.
    const skeletonRegion = src.match(
      /<v-col[\s\S]*?<v-skeleton-loader/,
    );
    expect(skeletonRegion).not.toBeNull();
    const region = skeletonRegion![0];
    expect(region).toMatch(/cols="12"/);
    expect(region).toMatch(/sm="6"/);
    expect(region).toMatch(/md="4"/);
  });
});

describe('Feature 0039 AC-0001 — App layout switcher', () => {
  it('App.vue swaps DefaultLayout / MobileLayout off Vuetify useDisplay().smAndDown', () => {
    const src = appVue;
    expect(src).toMatch(/from\s+['"]vuetify['"]/);
    expect(src).toMatch(/useDisplay\(\)/);
    expect(src).toMatch(/smAndDown/);
    // Both layouts must be referenced — the test would otherwise let an
    // accidental delete slip through.
    expect(src).toMatch(/MobileLayout/);
    expect(src).toMatch(/DefaultLayout/);
    expect(src).toMatch(/AuthLayout/);
  });
});

describe('Feature 0039 AC-0005 — ContactsView mobile branching', () => {
  it('ContactsView renders MobileContactView on smAndDown', () => {
    const src = contactsViewVue;
    expect(src).toMatch(/smAndDown/);
    expect(src).toMatch(/<MobileContactView/);
    // The desktop branch must still exist (v-data-table) so we don't
    // accidentally regress the table.
    expect(src).toMatch(/<v-data-table/);
  });
});

describe('Feature 0039 AC-0004 — ChatView preserves Feature 0042 mobile pane switch', () => {
  it('ChatView still toggles the mobile-thread class off isMobile + hasSelection', () => {
    const src = chatViewVue;
    // The Feature 0042 mobile pane switch hinges on these three pieces:
    //   - an isMobile reactive flag derived from viewport width,
    //   - a hasSelection computed,
    //   - a `chat-container--mobile-thread` class on the root.
    expect(src).toMatch(/isMobile/);
    expect(src).toMatch(/hasSelection/);
    expect(src).toMatch(/chat-container--mobile-thread/);
    // And the inline back-bar that the back button lives in:
    expect(src).toMatch(/chat-mobile-back-bar/);
  });
});
