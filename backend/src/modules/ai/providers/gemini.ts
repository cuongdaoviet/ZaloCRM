/**
 * Google Gemini adapter.
 *
 * Ported from ZaloCRM-3.0's `generateWithGemini` (SPEC §9 / 1.b — port
 * verbatim). Gemini uses an unusual `?key=` query-string auth instead of a
 * header, and a different request body shape than OpenAI-compat.
 */
import type {
  AiGenerateOpts,
  AiGenerateResult,
  AiProvider,
} from './types.js';
import { combinedAbort } from './types.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/** USD per million tokens — best-effort, Google public pricing. */
const COST_TABLE: Record<string, { in: number; out: number }> = {
  'gemini-1.5-flash': { in: 0.075, out: 0.3 },
  'gemini-1.5-pro': { in: 1.25, out: 5 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemini-2.0-pro': { in: 1.25, out: 5 },
};

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string; code?: number };
}

export const geminiProvider: AiProvider = {
  name: 'gemini',

  async generate(opts: AiGenerateOpts): Promise<AiGenerateResult> {
    const base = (opts.apiEndpoint || DEFAULT_BASE_URL).replace(/\/$/, '');
    const url = `${base}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

    // Gemini supports a single `systemInstruction` separate from `contents`.
    const systemText = opts.messages.find((m) => m.role === 'system')?.content ?? '';
    const contents = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        // Gemini calls assistant messages "model".
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const { signal, cleanup } = combinedAbort(opts.signal);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: systemText
            ? { parts: [{ text: systemText }] }
            : undefined,
          contents,
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: opts.maxTokens ?? 600,
          },
        }),
        signal,
      });

      if (!response.ok) {
        const body = (await response.text().catch(() => '')) || '';
        // Be careful: Gemini echoes the api key in the URL it sometimes
        // reflects back. We drop the response body to a short snippet that
        // never includes the URL.
        throw new Error(
          `Gemini request failed (${response.status}): ${body.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('')
        .trim();
      if (!text) throw new Error('Gemini returned empty content');
      return {
        text,
        tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
      };
    } finally {
      cleanup();
    }
  },

  estimateCost(tokensIn: number, tokensOut: number, model: string): number {
    const key = Object.keys(COST_TABLE)
      .sort((a, b) => b.length - a.length)
      .find((k) => model.startsWith(k));
    const rate = key ? COST_TABLE[key] : { in: 1.25, out: 5 };
    return (tokensIn / 1_000_000) * rate.in + (tokensOut / 1_000_000) * rate.out;
  },
};
