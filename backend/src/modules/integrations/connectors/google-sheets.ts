/**
 * Google Sheets connector — one-way export of CRM contacts to a Sheet.
 *
 * Ported call shape from ZaloCRM-3.0 `providers/google-sheets.ts` but
 * switched from API-key auth to OAuth 2.0 refresh-token auth (per Feature
 * 0038 BR-0004). API key only works for public sheets; refresh tokens give
 * us per-user-authorised access to private sheets, which is what admins
 * actually want.
 *
 * Storage policy: BR-0007 — overwrite each run. Phase 2: append-only with a
 * timestamp column.
 *
 * Rate-limit-safe: BR-0003 calls out >100k rows requires chunking. We cap
 * the worst case at 5000 rows in phase 1 and document the limit in EC-0003;
 * a real chunked write helper is phase-2 work.
 */
import { google } from 'googleapis';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import type {
  IntegrationConnector,
  SyncResult,
  ValidateResult,
} from './types.js';

export interface GoogleSheetsConfig {
  refreshToken: string;
  spreadsheetId: string;
  sheetName: string;
  // ISO 8601 cron-lite: 'hourly' | 'daily' | 'manual'. Phase 2 supports raw cron.
  schedule: 'hourly' | 'daily' | 'manual';
  filter?: {
    status?: string;
    tags?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
}

const HEADERS = [
  'id',
  'fullName',
  'phone',
  'status',
  'tags',
  'source',
  'createdAt',
  'assignedUserName',
];

const MAX_ROWS_PHASE_1 = 5000;

function clientId(): string | undefined {
  return process.env.GOOGLE_OAUTH_CLIENT_ID;
}
function clientSecret(): string | undefined {
  return process.env.GOOGLE_OAUTH_CLIENT_SECRET;
}
function redirectUri(): string | undefined {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI;
}

/**
 * Build an OAuth2 client primed with a refresh token. Caller can then call
 * `getAccessToken()` or pass the client into a Sheets API constructor.
 */
export function buildOAuth2Client(refreshToken: string) {
  const oauth2 = new google.auth.OAuth2(
    clientId(),
    clientSecret(),
    redirectUri(),
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

/**
 * Step 1 of the OAuth dance: redirect URL the admin's browser is sent to.
 * `state` is opaque CSRF the route handler chooses and verifies on callback.
 */
export function buildAuthUrl(state: string): string {
  const oauth2 = new google.auth.OAuth2(
    clientId(),
    clientSecret(),
    redirectUri(),
  );
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force refresh_token issuance even on re-auth
    scope: ['https://www.googleapis.com/auth/spreadsheets'],
    state,
  });
}

/**
 * Step 2: exchange the one-shot code for a refresh token. Throws on error.
 */
export async function exchangeCode(code: string): Promise<{
  refreshToken: string;
}> {
  const oauth2 = new google.auth.OAuth2(
    clientId(),
    clientSecret(),
    redirectUri(),
  );
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh_token in OAuth response — user likely already authorised this app. Revoke + retry.',
    );
  }
  return { refreshToken: tokens.refresh_token };
}

function isGoogleSheetsConfig(c: unknown): c is GoogleSheetsConfig {
  if (!c || typeof c !== 'object') return false;
  const x = c as Record<string, unknown>;
  return (
    typeof x.refreshToken === 'string' &&
    x.refreshToken.length > 0 &&
    typeof x.spreadsheetId === 'string' &&
    x.spreadsheetId.length > 0 &&
    typeof x.sheetName === 'string' &&
    typeof x.schedule === 'string' &&
    ['hourly', 'daily', 'manual'].includes(x.schedule as string)
  );
}

export const googleSheetsConnector: IntegrationConnector<GoogleSheetsConfig> = {
  type: 'google_sheets',

  validateConfig(config: unknown): ValidateResult {
    if (!isGoogleSheetsConfig(config)) {
      return { ok: false, error: 'Invalid google_sheets config shape' };
    }
    return { ok: true };
  },

  async testConnection(config: GoogleSheetsConfig): Promise<ValidateResult> {
    try {
      const auth = buildOAuth2Client(config.refreshToken);
      const sheets = google.sheets({ version: 'v4', auth });
      // Cheap metadata check — fails fast on bad refresh token or wrong sheet.
      await sheets.spreadsheets.get({
        spreadsheetId: config.spreadsheetId,
        fields: 'spreadsheetId,properties.title',
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Google Sheets: ${msg.slice(0, 200)}` };
    }
  },

  async sync(orgId: string, config: GoogleSheetsConfig): Promise<SyncResult> {
    try {
      const where = buildFilterWhere(orgId, config.filter);
      const contacts = await prisma.contact.findMany({
        where,
        include: {
          assignedUser: { select: { fullName: true } },
          contactTags: { include: { tag: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS_PHASE_1,
      });

      const rows = contacts.map((c) => [
        c.id,
        c.fullName ?? '',
        c.phone ?? '',
        c.status ?? '',
        c.contactTags.map((ct) => ct.tag.name).join(','),
        c.source ?? '',
        c.createdAt.toISOString(),
        c.assignedUser?.fullName ?? '',
      ]);

      const values = [HEADERS, ...rows];

      const auth = buildOAuth2Client(config.refreshToken);
      const sheets = google.sheets({ version: 'v4', auth });
      const range = `${config.sheetName}!A1`;

      // Clear + overwrite (BR-0007).
      await sheets.spreadsheets.values.clear({
        spreadsheetId: config.spreadsheetId,
        range: config.sheetName,
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values },
      });

      logger.info(
        `[google-sheets] sync orgId=${orgId} rows=${rows.length} sheet=${config.spreadsheetId}`,
      );
      return { status: 'succeeded', recordsProcessed: rows.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        recordsProcessed: 0,
        error: msg.slice(0, 500),
      };
    }
  },

  isDue(config: GoogleSheetsConfig, lastSyncedAt: Date | null): boolean {
    if (config.schedule === 'manual') return false;
    if (!lastSyncedAt) return true;
    const elapsed = Date.now() - lastSyncedAt.getTime();
    const threshold = config.schedule === 'hourly' ? 60 * 60_000 : 24 * 60 * 60_000;
    return elapsed >= threshold;
  },
};

function buildFilterWhere(
  orgId: string,
  filter: GoogleSheetsConfig['filter'] | undefined,
): Record<string, unknown> {
  const where: Record<string, unknown> = { orgId, mergedIntoId: null };
  if (!filter) return where;
  if (filter.status) where.status = filter.status;
  if (filter.dateFrom || filter.dateTo) {
    const range: Record<string, Date> = {};
    if (filter.dateFrom) range.gte = new Date(filter.dateFrom);
    if (filter.dateTo) range.lte = new Date(filter.dateTo);
    where.createdAt = range;
  }
  if (filter.tags && filter.tags.length > 0) {
    where.contactTags = {
      some: { tag: { name: { in: filter.tags } } },
    };
  }
  return where;
}
