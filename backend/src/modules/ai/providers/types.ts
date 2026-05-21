/**
 * Shared types for the provider abstraction layer.
 * Every adapter exports a function that satisfies AiProvider.generate.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'qwen' | 'kimi' | 'ollama';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiGenerateOpts {
  apiKey: string;
  apiEndpoint?: string;
  model: string;
  messages: AiMessage[];
  /** Hard cap on output tokens. Default 600. */
  maxTokens?: number;
  /** Optional AbortSignal to share with the caller's timeout. */
  signal?: AbortSignal;
}

export interface AiGenerateResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface AiProvider {
  name: ProviderId;
  generate(opts: AiGenerateOpts): Promise<AiGenerateResult>;
  /** USD per request — best-effort estimate using a static rate table. */
  estimateCost(tokensIn: number, tokensOut: number, model: string): number;
}

/**
 * Default per-provider timeout for outbound requests. Ported from 3.0
 * (`AbortController.timeout(30_000)` on every fetch).
 */
export const PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Compose two AbortSignals — one external (caller-provided), one internal
 * (timeout). Returns a new controller plus a cleanup function.
 */
export function combinedAbort(external?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Provider request timed out')), PROVIDER_TIMEOUT_MS);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener?.('abort', onAbort);
    },
  };
}
