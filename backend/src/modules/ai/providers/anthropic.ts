/**
 * Anthropic adapter (Claude family). Uses raw fetch instead of
 * @anthropic-ai/sdk so we keep tight control over headers and timeouts.
 *
 * Auth header note (SPEC §9.deviate-f): 3.0 sent BOTH `x-api-key` and
 * `Authorization: Bearer <key>` — the latter was a copy-paste artifact.
 * Only `x-api-key` is canonical. We send only the canonical header.
 */
import type {
  AiGenerateOpts,
  AiGenerateResult,
  AiProvider,
} from './types.js';
import { combinedAbort } from './types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** USD per million tokens — best-effort, Anthropic public pricing as of 2026-05. */
const COST_TABLE: Record<string, { in: number; out: number }> = {
  'claude-opus-4': { in: 15.0, out: 75.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-sonnet-4': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5': { in: 0.8, out: 4.0 },
  'claude-haiku-4': { in: 0.25, out: 1.25 },
};

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

export const anthropicProvider: AiProvider = {
  name: 'anthropic',

  async generate(opts: AiGenerateOpts): Promise<AiGenerateResult> {
    const base = (opts.apiEndpoint || DEFAULT_BASE_URL).replace(/\/$/, '');
    const url = `${base}/v1/messages`;

    // Anthropic wants system prompt as a top-level `system` field, not a
    // role:'system' message in the array.
    const system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
    const conv = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const { signal, cleanup } = combinedAbort(opts.signal);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // BR-0013 / SPEC §9.f: only the canonical header — no Bearer dup.
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 600,
          system,
          messages: conv,
        }),
        signal,
      });

      if (!response.ok) {
        const body = (await response.text().catch(() => '')) || '';
        // Strip any raw key the server might echo back; we don't include
        // the key in the error message either way.
        throw new Error(
          `Anthropic request failed (${response.status}): ${body.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as AnthropicResponse;
      const text = data.content?.find((item) => item.type === 'text')?.text?.trim();
      if (!text) throw new Error('Anthropic returned empty content');
      return {
        text,
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0,
      };
    } finally {
      cleanup();
    }
  },

  estimateCost(tokensIn: number, tokensOut: number, model: string): number {
    // Match the most specific prefix.
    const key = Object.keys(COST_TABLE)
      .sort((a, b) => b.length - a.length)
      .find((k) => model.startsWith(k));
    const rate = key ? COST_TABLE[key] : { in: 3, out: 15 };
    return (tokensIn / 1_000_000) * rate.in + (tokensOut / 1_000_000) * rate.out;
  },
};
