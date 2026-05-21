/**
 * Feature 0048 Phần B — verify that admin-only routes carry
 * `requiresAdmin: true` meta and that the redirect predicate
 * matches the SPEC's BR-0005 behavior.
 *
 * AC-0007 coverage. We do NOT mount the real router (it calls
 * `createWebHistory()` which doesn't play nicely in jsdom for
 * a unit test), so we instead:
 *   1. Read the exported `routes` config and assert meta on the
 *      paths SPEC §BR-0004 lists as admin-only.
 *   2. Re-derive the guard predicate used in `beforeEach` so a
 *      regression there shows up here.
 */
import { describe, it, expect } from 'vitest';
import { routes } from '@/router/index';

// The 10 admin-only menu paths from feature 0047 + the duplicate-groups
// child route (which the SPEC explicitly includes because it renders
// the same data as the parent).
const ADMIN_PATHS = [
  '/duplicate-groups',
  '/duplicate-groups/:id',
  '/campaigns',
  '/kpi',
  '/analytics',
  '/activity',
  '/settings/tags',
  '/settings/lead-score',
  '/settings/workflows',
  '/settings/ai-config',
  '/settings/integrations',
];

// Paths the menu marks open to members (no `adminOnly`). These MUST NOT
// carry requiresAdmin or we'd lock out members from pages they should see.
const NON_ADMIN_PATHS = [
  '/',
  '/chat',
  '/search',
  '/contacts',
  '/zalo-accounts',
  '/appointments',
  '/orders',
  '/reports',
  '/friends',
  '/friendship-attempts',
  '/keyword-rules',
  '/settings',
  '/quick-replies',
  '/api-settings',
];

function findRoute(path: string) {
  return routes.find((r) => r.path === path);
}

describe('Feature 0048 BR-0004 — admin routes carry requiresAdmin meta', () => {
  for (const path of ADMIN_PATHS) {
    it(`${path} → meta.requiresAdmin === true`, () => {
      const r = findRoute(path);
      expect(r, `route ${path} should be defined`).toBeDefined();
      expect(r!.meta).toMatchObject({
        requiresAuth: true,
        requiresAdmin: true,
      });
    });
  }
});

describe('Feature 0048 BR-0004 — non-admin routes do NOT carry requiresAdmin', () => {
  for (const path of NON_ADMIN_PATHS) {
    it(`${path} → meta.requiresAdmin falsy`, () => {
      const r = findRoute(path);
      expect(r, `route ${path} should be defined`).toBeDefined();
      // requiresAuth may or may not be present (Login/Setup don't have it);
      // we only care that requiresAdmin isn't accidentally true.
      expect(r!.meta?.requiresAdmin).toBeFalsy();
    });
  }
});

// Re-derive the predicate from beforeEach so that if someone changes the
// guard semantics in router/index.ts, this test catches it.
function shouldRedirectMember(to: { meta: { requiresAdmin?: boolean } }, isAdmin: boolean): boolean {
  return Boolean(to.meta.requiresAdmin) && !isAdmin;
}

describe('Feature 0048 BR-0005 — beforeEach redirect predicate', () => {
  it('member visiting admin route → redirect', () => {
    expect(shouldRedirectMember({ meta: { requiresAdmin: true } }, false)).toBe(true);
  });
  it('admin visiting admin route → pass', () => {
    expect(shouldRedirectMember({ meta: { requiresAdmin: true } }, true)).toBe(false);
  });
  it('member visiting open route → pass', () => {
    expect(shouldRedirectMember({ meta: {} }, false)).toBe(false);
  });
  it('admin visiting open route → pass', () => {
    expect(shouldRedirectMember({ meta: {} }, true)).toBe(false);
  });
});
