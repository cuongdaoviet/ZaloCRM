/**
 * Boot-time guard for JWT_SECRET — Feature 0046 BR-0004/BR-0005.
 *
 * Production startup MUST refuse to run when `JWT_SECRET` is missing, is
 * still the literal `dev-secret-change-me` placeholder, or is shorter than
 * 32 characters. Dev/test continues to accept the placeholder for
 * ergonomics (same pattern as `assertAiMasterKey()` in encrypt-config.ts).
 *
 * Why we don't allow the placeholder in prod: tokens signed with a
 * publicly known secret are forgeable by any attacker who has read the
 * repo. The boot guard turns this from a silent vulnerability into a
 * loud, fast failure during deploy.
 *
 * Why the 32-char minimum: HS256 (which `@fastify/jwt` defaults to) is a
 * symmetric algorithm; shorter secrets reduce brute-force cost. 32 chars
 * is the floor recommended by RFC 8725 / current Auth0 guidance.
 *
 * Rotation strategy: BR-0007 — operators rotate `JWT_SECRET` on deploy.
 * Old tokens fail verification → users see 401 → re-login. No DB
 * schema change needed.
 */
import { config } from '../../config/index.js';

/** Known placeholder shipped in the repo. */
const PLACEHOLDER_SECRET = 'dev-secret-change-me';

/** Minimum length in characters. */
const MIN_LENGTH = 32;

/**
 * Boot-time guard. Call from app.ts before `app.listen()` — same hook
 * point as `assertAiMasterKey()`.
 *
 * Throws when:
 * - `JWT_SECRET` is unset / empty (production only).
 * - `JWT_SECRET` equals the literal placeholder (production only).
 * - `JWT_SECRET` is shorter than 32 characters (production only).
 *
 * In dev/test the placeholder is acceptable — same ergonomics pattern as
 * `assertAiMasterKey()`.
 */
export function assertJwtSecret(): void {
  const secret = config.jwtSecret;

  if (!config.isProduction) {
    // Dev/test: accept anything (including the placeholder) so local
    // workflows don't need extra setup. Mirror of assertAiMasterKey().
    return;
  }

  if (!secret) {
    throw new Error(
      'JWT_SECRET must be set in production. Generate one with `openssl rand -base64 48` and set it in the environment.',
    );
  }
  if (secret === PLACEHOLDER_SECRET) {
    throw new Error(
      'JWT_SECRET is the dev placeholder ("dev-secret-change-me"). Generate a real secret with `openssl rand -base64 48` and set it in the environment before deploying.',
    );
  }
  if (secret.length < MIN_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_LENGTH} characters in production (got ${secret.length}). Generate one with \`openssl rand -base64 48\`.`,
    );
  }
}
