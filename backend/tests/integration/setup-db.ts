/**
 * Spins up an ephemeral Postgres container, runs `prisma db push` to create
 * the schema, then exports a Prisma client bound to it.
 *
 * Each integration test file imports this and calls `setupDb()` in beforeAll
 * + `teardownDb()` in afterAll. The container is reused across tests in the
 * same file (Vitest runs in a single fork via vitest.config.ts).
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

let container: StartedPostgreSqlContainer | null = null;
let prisma: PrismaClient | null = null;

export async function setupDb(): Promise<PrismaClient> {
  if (prisma) return prisma;

  let url: string;

  if (process.env.USE_CI_DB === '1') {
    // CI path: a Postgres service container is already running. Reuse it and
    // assume the schema has been pushed by the workflow step before tests run.
    const ciUrl = process.env.DATABASE_URL;
    if (!ciUrl) {
      throw new Error('USE_CI_DB=1 but DATABASE_URL is not set');
    }
    url = ciUrl;
  } else {
    // Local path: spin up an ephemeral container via testcontainers and push
    // the schema into it. Slower (~3s) but fully isolated.
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('zalocrm_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    url = container.getConnectionUri();
    process.env.DATABASE_URL = url;

    // Push the Prisma schema to the fresh DB. execFileSync avoids any
    // shell interpolation — only static arguments are passed.
    // Prisma 7 with @prisma/adapter-pg doesn't auto-read DATABASE_URL.
    execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--url', url], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  }

  const adapter = new PrismaPg({ connectionString: url });
  prisma = new PrismaClient({ adapter });
  await prisma.$connect();

  // In CI the same DB is reused across test files. Make sure each
  // beforeAll() starts with a clean slate.
  if (process.env.USE_CI_DB === '1') {
    await resetDb(prisma);
  }

  return prisma;
}

export async function teardownDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  if (container) {
    await container.stop();
    container = null;
  }
  // In CI the service container outlives the test process — nothing to stop.
}

export async function resetDb(client: PrismaClient): Promise<void> {
  // Truncate all tables in FK-respecting order
  await client.$executeRawUnsafe(
    'TRUNCATE TABLE messages, conversations, contacts, zalo_accounts, users, teams, organizations RESTART IDENTITY CASCADE',
  );
}
