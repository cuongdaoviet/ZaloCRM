/**
 * Auth service — handles setup, login, and profile operations.
 * Uses bcryptjs for password hashing and Fastify JWT for token signing.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import {
  recordFailure as recordLoginFailure,
  clear as clearLoginAttempts,
} from '../../shared/security/login-attempt-tracker.js';
import { logActivityAsync } from '../activity/activity-service.js';

export interface JwtPayload {
  id: string;
  email: string;
  role: string;
  orgId: string;
}

// Check if any users exist — true means first-run setup is needed
export async function checkSetupStatus(): Promise<{ needsSetup: boolean }> {
  const count = await prisma.user.count();
  return { needsSetup: count === 0 };
}

// Create the initial organization + owner user, return JWT payload
export async function setup(
  orgName: string,
  fullName: string,
  email: string,
  password: string,
): Promise<JwtPayload> {
  const existing = await prisma.user.count();
  if (existing > 0) {
    const err = new Error('Setup already completed') as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: orgName } });
    const user = await tx.user.create({
      data: {
        orgId: org.id,
        email: email.toLowerCase().trim(),
        passwordHash,
        fullName,
        role: 'owner',
      },
    });
    return { org, user };
  });

  logger.info(`Setup complete — org=${result.org.id}, user=${result.user.id}`);

  return {
    id: result.user.id,
    email: result.user.email,
    role: result.user.role,
    orgId: result.org.id,
  };
}

// Verify credentials, return JWT payload.
//
// Feature 0046 BR-0018/BR-0020:
// - On failure (unknown user, inactive user, wrong password): record a
//   failure in the in-memory tracker AND audit-log the attempt. The
//   tracker drives the 429 path in the route handler.
// - On success: clear the tracker entry so honest typos don't carry
//   over.
// `ipAddress` is optional so existing callers without a request
// context (tests, scripts) keep working; the route handler passes
// request.ip.
export async function login(
  email: string,
  password: string,
  ipAddress?: string | null,
): Promise<JwtPayload> {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user || !user.isActive) {
    const state = recordLoginFailure(normalizedEmail);
    // BR-0020 — log even when the user is unknown. We don't know orgId
    // in that case; if the user exists we attach orgId for audit
    // attribution. The activity_log row carries the email in details
    // either way.
    if (user) {
      logActivityAsync({
        orgId: user.orgId,
        userId: user.id,
        action: 'auth.login.failed',
        details: {
          email: normalizedEmail,
          ip: ipAddress ?? null,
          reason: !user.isActive ? 'inactive' : 'no_user',
          attemptCount: state.count,
        },
      });
    } else {
      logger.warn(
        `[auth] login.failed unknown-user email=${normalizedEmail} ip=${ipAddress ?? 'n/a'} attempt=${state.count}`,
      );
    }
    const err = new Error('Invalid email or password') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const state = recordLoginFailure(normalizedEmail);
    logActivityAsync({
      orgId: user.orgId,
      userId: user.id,
      action: 'auth.login.failed',
      details: {
        email: normalizedEmail,
        ip: ipAddress ?? null,
        reason: 'bad_password',
        attemptCount: state.count,
      },
    });
    const err = new Error('Invalid email or password') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }

  // Success — clear the failure window so the next honest typo doesn't
  // count against a fresh budget.
  clearLoginAttempts(normalizedEmail);

  return { id: user.id, email: user.email, role: user.role, orgId: user.orgId };
}

// Return safe user profile (no password hash)
export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      orgId: true,
      teamId: true,
      isActive: true,
      createdAt: true,
      org: { select: { id: true, name: true } },
    },
  });

  if (!user) {
    const err = new Error('User not found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  return user;
}
