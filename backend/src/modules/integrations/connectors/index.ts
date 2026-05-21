/**
 * Connector registry — single source of truth for dispatch.
 *
 * Why a registry (Map) instead of a `switch (type)` dispatcher: adding a
 * phase-2 connector (Slack, Zapier, FB Messenger) is one new file + one new
 * line in REGISTRY. Zero edits to call sites in the routes layer or worker.
 * The 3.0 codebase used switch-dispatch in `sync-engine.ts` and every new
 * provider required edits in two places — we don't want to repeat that.
 *
 * Lookup is O(1) at runtime; the array form is exposed via `listConnectors`
 * for cases (FE registry endpoint, admin diagnostics) that want to iterate.
 */
import type { ConnectorType, IntegrationConnector } from './types.js';
import { googleSheetsConnector } from './google-sheets.js';
import { telegramBotConnector } from './telegram-bot.js';

const REGISTRY = new Map<ConnectorType, IntegrationConnector<any>>([
  ['google_sheets', googleSheetsConnector],
  ['telegram_bot', telegramBotConnector],
]);

export function getConnector(type: string): IntegrationConnector<any> | undefined {
  return REGISTRY.get(type as ConnectorType);
}

export function listConnectors(): IntegrationConnector<any>[] {
  return Array.from(REGISTRY.values());
}

export { googleSheetsConnector, telegramBotConnector };
