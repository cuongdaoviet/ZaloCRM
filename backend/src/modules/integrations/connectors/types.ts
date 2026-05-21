/**
 * Connector contract for Feature 0038.
 *
 * Why an interface (and a registry) instead of a switch-dispatch (3.0
 * pattern): adding phase-2 connectors (Slack, Zapier, FB Messenger) means
 * implementing one new file and registering it. Zero edits to the dispatcher.
 *
 * Discriminated union for results mirrors 3.0's SyncResult — guarantees we
 * always log a row even on the failure path.
 */

export type ConnectorType = 'google_sheets' | 'telegram_bot';

export type SupportedEventType =
  | 'contact.created'
  | 'order.created'
  | 'appointment.reminder'
  | 'message.escalated';

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

export type SyncResult =
  | { status: 'succeeded'; recordsProcessed: number }
  | { status: 'failed'; recordsProcessed: number; error: string };

export interface IntegrationEvent {
  orgId: string;
  type: SupportedEventType | string;
  payload: Record<string, unknown>;
  emittedAt: Date;
}

export interface IntegrationConnector<Config = unknown> {
  type: ConnectorType;

  /**
   * Surface-validate the user-supplied config shape (no remote calls). Cheap
   * — should pass for any structurally complete config.
   */
  validateConfig(config: unknown): ValidateResult;

  /**
   * Hit the remote API once to confirm credentials work. Called on create +
   * config change. Side-effect free where possible (Telegram = sendMessage
   * with a "Test from ZaloCRM" body, Sheets = a metadata get).
   */
  testConnection(config: Config): Promise<ValidateResult>;

  /**
   * Scheduled connectors (Sheets) implement this. Worker calls it every tick
   * once the schedule says it's due. Telegram leaves it undefined.
   */
  sync?(orgId: string, config: Config): Promise<SyncResult>;

  /**
   * Event-driven connectors (Telegram) implement this. Webhook tee fires it
   * fire-and-forget. Errors are swallowed (and logged); the dispatcher
   * persists no row per event in phase 1.
   */
  onEvent?(event: IntegrationEvent, config: Config): Promise<void>;

  /**
   * When the worker needs to know "is this integration due to run again?"
   * Optional — non-scheduled connectors skip the worker entirely. Returns
   * true when (now - lastSyncedAt) exceeds the configured cadence.
   */
  isDue?(config: Config, lastSyncedAt: Date | null): boolean;
}
