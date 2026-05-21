/**
 * In-memory per-email login attempt tracker — Feature 0046 BR-0018..BR-0021.
 *
 * Why we need it: `/api/v1/auth/login` currently has no per-account rate
 * limit. Credential-stuffing attackers can burn through password lists
 * one email at a time. Fastify's @fastify/rate-limit is configured per
 * IP and per `x-api-key`, which doesn't bind to the account being
 * attacked — a distributed attack from many IPs against one email
 * sails through.
 *
 * Why in-memory and not Redis/DB (BR-0021): Phase 1 is single-process
 * (Feature 0045 already documents the single-process assumption).
 * Multi-process replication is explicitly out of scope. When this
 * codebase moves to >1 worker the tracker can be ported to Redis with
 * the same interface, no callsite changes required.
 *
 * Threshold (BR-0018): 5 failures in 15 minutes → next attempt for that
 * email returns 429 with Retry-After. Successful login (BR-0018 last
 * bullet) clears the entry. 15-minute window starts at firstFailedAt;
 * after the window expires the next failure resets the counter.
 *
 * BR-0019: callers must check `consume()` BEFORE bcrypt.compare — we
 * don't want an attacker to spend our bcrypt CPU on a rate-limited
 * request.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

interface Entry {
  count: number;
  firstFailedAt: number;
}

/** Map keyed by lower-cased trimmed email. */
const attempts = new Map<string, Entry>();

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CheckResult {
  /** True when the request should proceed (not rate-limited). */
  allowed: boolean;
  /** Seconds until the limit window resets — present when allowed=false. */
  retryAfterSeconds?: number;
}

/**
 * Inspect the tracker WITHOUT mutating state. Use this BEFORE
 * bcrypt.compare so a hot-locked account doesn't waste CPU on the
 * password hash.
 *
 * Returns `{ allowed: true }` when the email is below the failure
 * threshold (or the previous window has expired and will be reset on
 * the next failure).
 */
export function check(email: string): CheckResult {
  const key = normEmail(email);
  const entry = attempts.get(key);
  if (!entry) return { allowed: true };

  // Window expired → next failure resets, treat as fresh.
  if (Date.now() - entry.firstFailedAt >= WINDOW_MS) {
    return { allowed: true };
  }

  if (entry.count >= MAX_ATTEMPTS) {
    const retryAt = entry.firstFailedAt + WINDOW_MS;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((retryAt - Date.now()) / 1000),
    );
    return { allowed: false, retryAfterSeconds };
  }
  return { allowed: true };
}

/**
 * Record a failed login attempt for this email. Increments the counter,
 * lazily resetting the window if the previous one has expired.
 *
 * Returns the new state, which the caller can use to log audit events
 * (e.g. include the new attempt count in an activity log row).
 */
export function recordFailure(email: string): Entry {
  const key = normEmail(email);
  const now = Date.now();
  const existing = attempts.get(key);
  if (!existing || now - existing.firstFailedAt >= WINDOW_MS) {
    const fresh: Entry = { count: 1, firstFailedAt: now };
    attempts.set(key, fresh);
    return fresh;
  }
  existing.count += 1;
  return existing;
}

/**
 * Clear the entry for an email — call on successful login (BR-0018
 * "Clear on success") so 4 failed attempts followed by 1 success
 * doesn't leave a hot tracker that locks the legit user out on the
 * next typo.
 */
export function clear(email: string): void {
  attempts.delete(normEmail(email));
}

/**
 * Test-only helper to drop the entire tracker between cases. Not
 * exported in the production API surface; the only callers are test
 * setup hooks.
 */
export function __resetForTests(): void {
  attempts.clear();
}

/** Test-only — snapshot tracker for assertions. */
export function __snapshotForTests(): Map<string, Entry> {
  return new Map(attempts);
}

/** Public constants for tests + Retry-After response headers. */
export const LOGIN_MAX_ATTEMPTS = MAX_ATTEMPTS;
export const LOGIN_WINDOW_MS = WINDOW_MS;
