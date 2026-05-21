/**
 * Feature 0039 AC-0008 — touch target floor enforcement.
 *
 * jsdom does not lay out CSS, so we can't measure actual heights at
 * runtime. We instead lock the contract by asserting:
 *   (a) `tokens.css` exposes the `--smax-touch-target-min` design token
 *       at exactly 44 px (BR-0009 / iOS HIG / WCAG 2.5.5).
 *   (b) `tokens.css` ships the `@media (max-width: 600px)` override that
 *       lifts Vuetify's compact button heights to that floor.
 *   (c) The MobileBottomNav buttons declare `min-height` against that
 *       same token in their scoped CSS, so a future regression in
 *       Vuetify's default `v-bottom-navigation` height can't sneak the
 *       buttons below the floor.
 *
 * If a future redesign needs to lower the floor below 44 px, every
 * one of these assertions has to be edited — making the deviation
 * intentional rather than accidental.
 */
/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolve absolute paths against this test file's directory so the test
// runs from any cwd. `import.meta.url` is the standard ESM-safe path
// resolver; we avoid `__dirname` which isn't defined under ESM.
const here = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(resolve(here, '../../../', rel), 'utf-8');
}

const tokensCss = readSrc('assets/tokens.css');
const mobileBottomNavVue = readSrc('components/layout/MobileBottomNav.vue');
const mobileLayoutVue = readSrc('layouts/MobileLayout.vue');

describe('Feature 0039 — AC-0008 touch target enforcement', () => {
  it('declares the 44 px floor as a CSS variable in tokens.css', () => {
    const css = tokensCss;
    // Match the value with whitespace tolerance.
    expect(css).toMatch(/--smax-touch-target-min:\s*44px/);
  });

  it('overrides Vuetify x-small / small button heights on phones', () => {
    const css = tokensCss;
    expect(css).toMatch(/@media \(max-width: 600px\)/);
    // The override must reference both compact button selectors so a
    // `size="x-small"` or `size="small"` button can't drop below 44 px
    // anywhere in the mobile chrome.
    expect(css).toMatch(/\.v-btn--size-x-small[\s\S]*?--smax-touch-target-min/);
    expect(css).toMatch(/\.v-btn--size-small[\s\S]*?--smax-touch-target-min/);
    expect(css).toMatch(/\.v-list-item[\s\S]*?--smax-touch-target-min/);
  });

  it('ships a `.smax-touch-target` utility class anchored at the floor', () => {
    const css = tokensCss;
    expect(css).toMatch(
      /\.smax-touch-target\s*{[\s\S]*?min-height:\s*var\(--smax-touch-target-min\);[\s\S]*?min-width:\s*var\(--smax-touch-target-min\);/,
    );
  });

  it('safe-area inset helper is wired so the home indicator does not eat the nav', () => {
    const css = tokensCss;
    expect(css).toMatch(/\.smax-safe-bottom\s*{[\s\S]*?padding-bottom:\s*env\(safe-area-inset-bottom\)/);
  });

  it('MobileBottomNav scopes its button min-height to the floor token', () => {
    const vue = mobileBottomNavVue;
    // Each tap target button declares min-height against the token; the
    // drawer list rows do too.
    expect(vue).toMatch(/\.mobile-bottom-nav__btn[\s\S]*?min-height:\s*var\(--smax-touch-target-min\)/);
    expect(vue).toMatch(/\.mobile-more-drawer[\s\S]*?\.v-list-item[\s\S]*?min-height:\s*var\(--smax-touch-target-min\)/);
  });

  it('MobileLayout reserves enough bottom padding to clear the nav + safe area', () => {
    const vue = mobileLayoutVue;
    // Padding bottom must combine the bottom-nav height token with
    // env(safe-area-inset-bottom). Both tokens must appear inside the
    // padding-bottom rule (the rule body can span a few lines because
    // of `calc(var(--smax-bottom-nav-h, 56px) + env(...))`).
    const ruleMatch = vue.match(/padding-bottom:[\s\S]*?;/);
    expect(ruleMatch, 'mobile-main padding-bottom rule missing').not.toBeNull();
    const rule = ruleMatch![0];
    expect(rule).toContain('--smax-bottom-nav-h');
    expect(rule).toContain('safe-area-inset-bottom');
  });
});
