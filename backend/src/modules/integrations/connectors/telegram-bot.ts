/**
 * Telegram Bot connector — fire-and-forget event notifications.
 *
 * Pattern lifted from ZaloCRM-3.0 `providers/telegram-bot.ts:sendMessage`
 * (POST to /bot<token>/sendMessage with chat_id + text). Two deltas from 3.0:
 *
 *   1. 3.0 ran a daily summary on a schedule. Phase 1 of 0038 is event-driven:
 *      each emitWebhook tee'd through here pushes one formatted message.
 *      Daily summaries are phase 2 (separate `frequency` config field).
 *   2. We accept an optional `apiEndpoint` override (useful for local proxies
 *      and stage environments). 3.0 had no override. Because it's user
 *      input, the SSRF guard from shared/network/ssrf-guard.ts runs first.
 *
 * BR-0011: config carries `eventTypes` array; the dispatcher filters at the
 * webhook tee so this connector receives only events the user opted into.
 * We still defensively re-check inside onEvent so a stale subscription can't
 * leak through.
 *
 * BR-0013: message format per event type. Vietnamese strings to match the
 * rest of the product surface.
 */
import { logger } from '../../../shared/utils/logger.js';
import { checkUrlForSsrf } from '../../../shared/network/ssrf-guard.js';
import { maskSecret } from '../../../shared/crypto/encrypt-config.js';
import type {
  IntegrationConnector,
  IntegrationEvent,
  SupportedEventType,
  ValidateResult,
} from './types.js';

export interface TelegramBotConfig {
  botToken: string;
  chatId: string;
  eventTypes: SupportedEventType[];
  /**
   * Optional API endpoint override. Almost always omitted (we hit Telegram's
   * canonical `https://api.telegram.org`). Operators on restricted networks
   * sometimes need a proxy — SSRF guard protects against abuse.
   */
  apiEndpoint?: string;
}

const DEFAULT_API_ENDPOINT = 'https://api.telegram.org';
const SUPPORTED_EVENTS: ReadonlyArray<SupportedEventType> = [
  'contact.created',
  'order.created',
  'appointment.reminder',
  'message.escalated',
];
const REQUEST_TIMEOUT_MS = 15_000;

function isTelegramBotConfig(c: unknown): c is TelegramBotConfig {
  if (!c || typeof c !== 'object') return false;
  const x = c as Record<string, unknown>;
  if (typeof x.botToken !== 'string' || x.botToken.length < 10) return false;
  if (typeof x.chatId !== 'string' || x.chatId.length === 0) return false;
  if (!Array.isArray(x.eventTypes) || x.eventTypes.length === 0) return false;
  for (const e of x.eventTypes) {
    if (typeof e !== 'string') return false;
    if (!SUPPORTED_EVENTS.includes(e as SupportedEventType)) return false;
  }
  if (x.apiEndpoint !== undefined && typeof x.apiEndpoint !== 'string') {
    return false;
  }
  return true;
}

/**
 * Build the bot API base. Production path uses the official endpoint;
 * override path runs the SSRF guard so user input can't target internal
 * services.
 */
function resolveBaseUrl(config: TelegramBotConfig): { ok: true; baseUrl: string } | { ok: false; error: string } {
  if (!config.apiEndpoint) {
    return { ok: true, baseUrl: DEFAULT_API_ENDPOINT };
  }
  const guard = checkUrlForSsrf(config.apiEndpoint);
  if (!guard.ok) {
    return { ok: false, error: guard.error ?? 'apiEndpoint rejected' };
  }
  // Strip trailing slash for predictable concat.
  return { ok: true, baseUrl: config.apiEndpoint.replace(/\/$/, '') };
}

/**
 * Format a webhook event into the Vietnamese-language Telegram message
 * defined in BR-0013. Falls back to a generic "<event>: <key>=<value>"
 * dump for unfamiliar event types so we never silently drop notifications.
 */
export function formatEventMessage(event: IntegrationEvent): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'contact.created': {
      const name = String(p.fullName ?? p.name ?? 'KH mới');
      const phone = String(p.phone ?? '—');
      const source = String(p.source ?? 'unknown');
      return `🆕 KH mới: ${name} (${phone}) — nguồn: ${source}`;
    }
    case 'order.created': {
      const orderNumber = String(p.orderNumber ?? p.id ?? '?');
      const amount = formatNumber(p.amount);
      const name = String(p.fullName ?? p.contactName ?? 'KH');
      return `💰 Đơn mới: ${orderNumber} — ${amount} VND — KH: ${name}`;
    }
    case 'appointment.reminder': {
      const name = String(p.contactName ?? p.fullName ?? 'KH');
      const time = String(p.time ?? p.appointmentDate ?? '');
      return `📅 Hẹn sắp tới (15min): ${name} @ ${time}`;
    }
    case 'message.escalated': {
      const name = String(p.contactName ?? p.fullName ?? 'KH');
      const reason = String(p.reason ?? 'cần xử lý');
      return `⚠️ Tin nhắn cần xử lý: ${name} — ${reason}`;
    }
    default: {
      // Defensive: surface unknown events so admins can debug, but trim the
      // payload to avoid blowing the 4096-char Telegram message limit.
      const summary = JSON.stringify(p).slice(0, 200);
      return `🔔 ${event.type}: ${summary}`;
    }
  }
}

function formatNumber(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString('vi-VN');
  }
  if (typeof value === 'string') return value;
  return '0';
}

async function postToTelegram(
  baseUrl: string,
  config: TelegramBotConfig,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${baseUrl}/bot${config.botToken}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text();
      // Truncate AND mask. Provider error bodies sometimes echo the bot
      // token URL fragment back to us; the maskSecret keeps it safe in logs.
      const masked = body.replace(config.botToken, maskSecret(config.botToken));
      return {
        ok: false,
        error: `Telegram ${response.status}: ${masked.slice(0, 200)}`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export const telegramBotConnector: IntegrationConnector<TelegramBotConfig> = {
  type: 'telegram_bot',

  validateConfig(config: unknown): ValidateResult {
    if (!isTelegramBotConfig(config)) {
      return { ok: false, error: 'Invalid telegram_bot config shape' };
    }
    if ((config as TelegramBotConfig).apiEndpoint) {
      const guard = checkUrlForSsrf((config as TelegramBotConfig).apiEndpoint);
      if (!guard.ok) return { ok: false, error: guard.error };
    }
    return { ok: true };
  },

  async testConnection(config: TelegramBotConfig): Promise<ValidateResult> {
    const base = resolveBaseUrl(config);
    if (!base.ok) return { ok: false, error: base.error };
    const result = await postToTelegram(
      base.baseUrl,
      config,
      '✅ ZaloCRM: kết nối Telegram bot thành công.',
    );
    if (!result.ok) {
      logger.warn(
        `[telegram-bot] testConnection failed for bot ${maskSecret(config.botToken)}: ${result.error}`,
      );
      return { ok: false, error: result.error };
    }
    return { ok: true };
  },

  async onEvent(event: IntegrationEvent, config: TelegramBotConfig): Promise<void> {
    // Defence-in-depth: dispatcher filters by eventTypes, but a stale config
    // could be in-flight when the user removes a subscription. Skip silently.
    if (!config.eventTypes.includes(event.type as SupportedEventType)) {
      return;
    }
    const base = resolveBaseUrl(config);
    if (!base.ok) {
      logger.warn(`[telegram-bot] onEvent skipped — base URL rejected: ${base.error}`);
      return;
    }
    const text = formatEventMessage(event);
    const result = await postToTelegram(base.baseUrl, config, text);
    if (!result.ok) {
      logger.warn(
        `[telegram-bot] onEvent delivery failed (${event.type}) bot=${maskSecret(config.botToken)}: ${result.error}`,
      );
    }
  },
};
