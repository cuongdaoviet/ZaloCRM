/**
 * Shared adapter for OpenAI-compatible chat/completions endpoints.
 *
 * Works against:
 *   - OpenAI (https://api.openai.com/v1/chat/completions)
 *   - Qwen / dashscope compat mode
 *     (https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions)
 *   - Kimi / Moonshot (https://api.moonshot.cn/v1/chat/completions)
 *
 * Ported from ZaloCRM-3.0's `generateWithOpenaiCompat` (SPEC §9 — keep verbatim
 * the request body / response parse logic). We provide a single factory that
 * stamps out provider-specific instances, each carrying its own base URL, cost
 * table, and name.
 */
import type {
  AiGenerateOpts,
  AiGenerateResult,
  AiProvider,
  ProviderId,
} from './types.js';
import { combinedAbort } from './types.js';

interface OpenAiCompatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

interface OpenAiCompatProviderConfig {
  name: ProviderId;
  /** Default base URL when AiConfig.apiEndpoint is not set. */
  defaultBaseUrl: string;
  /**
   * Suffix appended to baseUrl to form the chat-completions endpoint.
   * (OpenAI/Kimi: `/v1/chat/completions`. Qwen: `/compatible-mode/v1/chat/completions`.)
   */
  endpointPath: string;
  /** USD per million tokens by model prefix. Falls back to defaultCost. */
  costTable: Record<string, { in: number; out: number }>;
  defaultCost: { in: number; out: number };
}

function buildProvider(cfg: OpenAiCompatProviderConfig): AiProvider {
  return {
    name: cfg.name,

    async generate(opts: AiGenerateOpts): Promise<AiGenerateResult> {
      const base = (opts.apiEndpoint || cfg.defaultBaseUrl).replace(/\/$/, '');
      const url = `${base}${cfg.endpointPath}`;

      const { signal, cleanup } = combinedAbort(opts.signal);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            model: opts.model,
            messages: opts.messages,
            max_tokens: opts.maxTokens ?? 600,
          }),
          signal,
        });

        if (!response.ok) {
          const body = (await response.text().catch(() => '')) || '';
          throw new Error(
            `${cfg.name} request failed (${response.status}): ${body.slice(0, 200)}`,
          );
        }

        const data = (await response.json()) as OpenAiCompatResponse;
        const text = data.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error(`${cfg.name} returned empty content`);
        return {
          text,
          tokensIn: data.usage?.prompt_tokens ?? 0,
          tokensOut: data.usage?.completion_tokens ?? 0,
        };
      } finally {
        cleanup();
      }
    },

    estimateCost(tokensIn: number, tokensOut: number, model: string): number {
      const key = Object.keys(cfg.costTable)
        .sort((a, b) => b.length - a.length)
        .find((k) => model.startsWith(k));
      const rate = key ? cfg.costTable[key] : cfg.defaultCost;
      return (tokensIn / 1_000_000) * rate.in + (tokensOut / 1_000_000) * rate.out;
    },
  };
}

/** OpenAI public API — GPT family. */
export const openaiProvider = buildProvider({
  name: 'openai',
  defaultBaseUrl: 'https://api.openai.com',
  endpointPath: '/v1/chat/completions',
  costTable: {
    'gpt-4o-mini': { in: 0.15, out: 0.6 },
    'gpt-4o': { in: 2.5, out: 10 },
    'gpt-4-turbo': { in: 10, out: 30 },
    'gpt-4': { in: 30, out: 60 },
    'gpt-3.5': { in: 0.5, out: 1.5 },
  },
  defaultCost: { in: 2.5, out: 10 },
});

/** Qwen / Alibaba dashscope, OpenAI-compat mode. */
export const qwenProvider = buildProvider({
  name: 'qwen',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com',
  endpointPath: '/compatible-mode/v1/chat/completions',
  costTable: {
    'qwen-max': { in: 10, out: 30 },
    'qwen-plus': { in: 0.8, out: 2 },
    'qwen-turbo': { in: 0.3, out: 0.6 },
  },
  defaultCost: { in: 0.8, out: 2 },
});

/** Kimi / Moonshot. */
export const kimiProvider = buildProvider({
  name: 'kimi',
  defaultBaseUrl: 'https://api.moonshot.cn',
  endpointPath: '/v1/chat/completions',
  costTable: {
    'moonshot-v1-128k': { in: 8, out: 24 },
    'moonshot-v1-32k': { in: 3, out: 9 },
    'moonshot-v1-8k': { in: 1.5, out: 4.5 },
  },
  defaultCost: { in: 3, out: 9 },
});
