/**
 * Unit tests for backend/src/shared/crypto/assert-jwt-secret.ts.
 *
 * Covers Feature 0046 BR-0004 / AC-0003 / AC-0004 / AC-0005:
 *   - production refuses unset secret
 *   - production refuses dev placeholder
 *   - production refuses short secret
 *   - production accepts a real 32+ char secret
 *   - dev/test accepts anything (including placeholder)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertJwtSecret } from '../../src/shared/crypto/assert-jwt-secret.js';

interface MutableConfig {
  isProduction: boolean;
  jwtSecret: string;
}

async function getConfig(): Promise<MutableConfig> {
  const { config } = await import('../../src/config/index.js');
  return config as unknown as MutableConfig;
}

afterEach(async () => {
  // Reset to safe defaults so other test files aren't polluted by the
  // last case run here. Tests in this file always set both fields
  // explicitly before calling assertJwtSecret().
  const config = await getConfig();
  config.isProduction = false;
  config.jwtSecret = 'dev-secret-change-me';
});

describe('assertJwtSecret', () => {
  it('throws in production when JWT_SECRET is unset', async () => {
    const config = await getConfig();
    config.isProduction = true;
    config.jwtSecret = '';
    expect(() => assertJwtSecret()).toThrow(/must be set/i);
  });

  it('throws in production when JWT_SECRET equals the dev placeholder', async () => {
    const config = await getConfig();
    config.isProduction = true;
    config.jwtSecret = 'dev-secret-change-me';
    expect(() => assertJwtSecret()).toThrow(/placeholder/i);
  });

  it('throws in production when JWT_SECRET is shorter than 32 chars', async () => {
    const config = await getConfig();
    config.isProduction = true;
    config.jwtSecret = 'short-but-not-placeholder';
    expect(() => assertJwtSecret()).toThrow(/at least 32/i);
  });

  it('accepts in production when JWT_SECRET is a real 32+ char value', async () => {
    const config = await getConfig();
    config.isProduction = true;
    // 64 hex chars — what `openssl rand -base64 48` produces (~64 chars).
    config.jwtSecret = 'a'.repeat(64);
    expect(() => assertJwtSecret()).not.toThrow();
  });

  it('accepts the dev placeholder outside production', async () => {
    const config = await getConfig();
    config.isProduction = false;
    config.jwtSecret = 'dev-secret-change-me';
    expect(() => assertJwtSecret()).not.toThrow();
  });

  it('accepts an empty string outside production (dev ergonomics)', async () => {
    const config = await getConfig();
    config.isProduction = false;
    config.jwtSecret = '';
    expect(() => assertJwtSecret()).not.toThrow();
  });
});
