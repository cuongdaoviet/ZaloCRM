/**
 * Ollama adapter — local / self-hosted models. SPEC §9 deviation (c): Ollama
 * is brand-new to ZaloCRM-4.x (3.0 did not support it).
 *
 * Ollama runs an HTTP daemon (default `http://localhost:11434`). Auth is
 * unused for the canonical bind; if the org puts Ollama behind a reverse proxy
 * with bearer auth, we forward whatever apiKey they configured.
 *
 * We use the `/api/chat` endpoint (Ollama supports OpenAI-style chat
 * messages). `stream: false` keeps the response a single JSON blob.
 */
import type {
  AiGenerateOpts,
  AiGenerateResult,
  AiProvider,
} from './types.js';
import { combinedAbort } from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number; // tokens in
  eval_count?: number; // tokens out
  error?: string;
}

export const ollamaProvider: AiProvider = {
  name: 'ollama',

  async generate(opts: AiGenerateOpts): Promise<AiGenerateResult> {
    const base = (opts.apiEndpoint || DEFAULT_BASE_URL).replace(/\/$/, '');
    const url = `${base}/api/chat`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (opts.apiKey) {
      headers.authorization = `Bearer ${opts.apiKey}`;
    }

    const { signal, cleanup } = combinedAbort(opts.signal);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          stream: false,
          options: { num_predict: opts.maxTokens ?? 600 },
        }),
        signal,
      });

      if (!response.ok) {
        const body = (await response.text().catch(() => '')) || '';
        throw new Error(
          `Ollama request failed (${response.status}): ${body.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as OllamaChatResponse;
      const text = data.message?.content?.trim();
      if (!text) {
        // EC-0007 — friendlier error message identifies endpoint clearly.
        throw new Error(
          `Ollama returned empty content (endpoint=${base}, model=${opts.model})`,
        );
      }
      return {
        text,
        tokensIn: data.prompt_eval_count ?? 0,
        tokensOut: data.eval_count ?? 0,
      };
    } catch (err: unknown) {
      // Connection-refused / DNS errors → wrap into the canonical EC-0007
      // message so the service layer can map cleanly to a 503.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('ECONNREFUSED') ||
        msg.includes('fetch failed') ||
        msg.includes('ENOTFOUND')
      ) {
        throw new Error(`Local Ollama not reachable at ${base}`);
      }
      throw err;
    } finally {
      cleanup();
    }
  },

  estimateCost(): number {
    // Self-hosted Ollama: no cost to the org (electricity excluded). We still
    // return 0 so the rest of the pipeline (logging, usage UI) is symmetric.
    return 0;
  },
};
