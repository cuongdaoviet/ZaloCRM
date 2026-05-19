/**
 * Activity log writer — feature 0012.
 *
 * Fire-and-forget from anywhere. Errors are swallowed so an audit-log
 * failure can't break the action it was logging.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { trackBackground } from '../../shared/utils/background-tasks.js';

export interface LogActivityInput {
  orgId: string;
  /** null for system actions (worker, listener) — UI renders as "Hệ thống" */
  userId?: string | null;
  /** snake_case, e.g. "campaign.cancelled" */
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

export async function logActivity(opts: LogActivityInput): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        orgId: opts.orgId,
        userId: opts.userId ?? null,
        action: opts.action,
        entityType: opts.entityType ?? null,
        entityId: opts.entityId ?? null,
        details: (opts.details ?? {}) as object,
      },
    });
  } catch (err) {
    // BR-0004: never propagate. Worst case: missing 1 audit row, not a
    // 500 to the user who just did the action
    logger.warn('[activity] logActivity failed:', err);
  }
}

/**
 * Convenience: fire without awaiting. Use when the caller doesn't need to
 * sequence anything after the log write (most cases).
 */
export function logActivityAsync(opts: LogActivityInput): void {
  trackBackground(logActivity(opts));
}
