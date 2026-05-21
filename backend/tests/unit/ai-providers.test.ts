/**
 * Unit tests for AI provider adapters — Feature 0036.
 *
 * Each test stubs `global.fetch` to return a canned upstream response, then
 * asserts:
 *   - Outgoing request shape (URL + headers + body).
 *   - Decoded result fields.
 *   - Special cases per provider (Anthropic dual-auth bug NOT replicated;
 *     Gemini systemInstruction split; Ollama ECONNREFUSED → reachable msg).
 *
 * Note on the Anthropic header check: the deviation in SPEC §9.f is THE
 * point of this feature; we assert `authorization` is absent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { anthropicProvider } from '../../src/modules/ai/providers/anthropic.js';
import { geminiProvider } from '../../src/modules/ai/providers/gemini.js';
import { ollamaProvider } from '../../src/modules/ai/providers/ollama.js';
import {
  openaiProvider,
  qwenProvider,
  kimiProvider,
} from '../../src/modules/ai/providers/openai-compat.js';

type FetchMock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Replace global.fetch with a per-test mock.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockOk(body: unknown): void {
  (globalThis.fetch as FetchMock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function mockFail(status: number, body = 'boom'): void {
  (globalThis.fetch as FetchMock).mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: body }),
    text: async () => body,
  });
}

describe('anthropicProvider', () => {
  it('sends only x-api-key — NOT Authorization Bearer (SPEC §9.f)', async () => {
    mockOk({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    await anthropicProvider.generate({
      apiKey: 'sk-ant-test',
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
      ],
    });
    const fetchMock = globalThis.fetch as FetchMock;
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // ★ The whole point of the recon note: no Bearer header here.
    expect(headers['authorization']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
  });

  it('decodes content + usage from a successful response', async () => {
    mockOk({
      content: [{ type: 'text', text: '  hi  ' }],
      usage: { input_tokens: 11, output_tokens: 4 },
    });
    const r = await anthropicProvider.generate({
      apiKey: 'k',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(r).toEqual({ text: 'hi', tokensIn: 11, tokensOut: 4 });
  });

  it('throws on non-2xx with status code in the message', async () => {
    mockFail(401, 'auth bad');
    await expect(
      anthropicProvider.generate({
        apiKey: 'bad',
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/401/);
  });

  it('estimateCost falls back to default rate when model unknown', () => {
    expect(anthropicProvider.estimateCost(1_000_000, 0, 'unknown')).toBeGreaterThan(0);
  });
});

describe('openaiProvider (and qwen/kimi compat)', () => {
  it('sends Authorization Bearer (the canonical header for OpenAI-compat)', async () => {
    mockOk({
      choices: [{ message: { content: 'hello back' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    await openaiProvider.generate({
      apiKey: 'sk-proj-XXX',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping' }],
    });
    const [, init] = (globalThis.fetch as FetchMock).mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-proj-XXX');
  });

  it('hits the canonical OpenAI endpoint by default', async () => {
    mockOk({ choices: [{ message: { content: 'x' } }] });
    await openaiProvider.generate({
      apiKey: 'k',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'q' }],
    });
    const [url] = (globalThis.fetch as FetchMock).mock.calls[0]!;
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('respects an apiEndpoint override for self-hosted OpenAI-compat', async () => {
    mockOk({ choices: [{ message: { content: 'x' } }] });
    await openaiProvider.generate({
      apiKey: 'k',
      apiEndpoint: 'https://self.host',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'q' }],
    });
    const [url] = (globalThis.fetch as FetchMock).mock.calls[0]!;
    expect(String(url)).toBe('https://self.host/v1/chat/completions');
  });

  it('qwen uses the dashscope compatible-mode endpoint', async () => {
    mockOk({ choices: [{ message: { content: 'x' } }] });
    await qwenProvider.generate({
      apiKey: 'k',
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'q' }],
    });
    const [url] = (globalThis.fetch as FetchMock).mock.calls[0]!;
    expect(String(url)).toContain('/compatible-mode/v1/chat/completions');
  });

  it('kimi uses moonshot.cn', async () => {
    mockOk({ choices: [{ message: { content: 'x' } }] });
    await kimiProvider.generate({
      apiKey: 'k',
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'q' }],
    });
    const [url] = (globalThis.fetch as FetchMock).mock.calls[0]!;
    expect(String(url)).toContain('moonshot.cn');
  });
});

describe('geminiProvider', () => {
  it('puts apiKey in the URL ?key= param, not headers', async () => {
    mockOk({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    });
    await geminiProvider.generate({
      apiKey: 'AIzaSyTEST',
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
      ],
    });
    const [url, init] = (globalThis.fetch as FetchMock).mock.calls[0]!;
    expect(String(url)).toContain('key=AIzaSyTEST');
    expect(String(url)).toContain('/v1beta/models/gemini-1.5-flash');
    const headers = init.headers as Record<string, string>;
    // No Authorization header for Gemini.
    expect(headers['authorization']).toBeUndefined();
    // System prompt goes to systemInstruction, not into contents.
    const parsed = JSON.parse(init.body as string);
    expect(parsed.systemInstruction.parts[0].text).toBe('be concise');
    expect(parsed.contents).toHaveLength(1);
  });

  it('decodes joined parts text and usage tokens', async () => {
    mockOk({
      candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    });
    const r = await geminiProvider.generate({
      apiKey: 'k',
      model: 'gemini-1.5-pro',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(r).toEqual({ text: 'ab', tokensIn: 3, tokensOut: 4 });
  });
});

describe('ollamaProvider', () => {
  it('hits /api/chat with no Authorization when apiKey is empty', async () => {
    mockOk({
      message: { content: 'hi' },
      prompt_eval_count: 4,
      eval_count: 2,
    });
    await ollamaProvider.generate({
      apiKey: '',
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'q' }],
    });
    const [url, init] = (globalThis.fetch as FetchMock).mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:11434/api/chat');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  it('forwards Bearer when an apiKey is provided (reverse-proxied Ollama)', async () => {
    mockOk({ message: { content: 'hi' } });
    await ollamaProvider.generate({
      apiKey: 'tok',
      apiEndpoint: 'https://my-ollama.example',
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'q' }],
    });
    const [url, init] = (globalThis.fetch as FetchMock).mock.calls[0]!;
    expect(String(url)).toBe('https://my-ollama.example/api/chat');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('translates ECONNREFUSED into the EC-0007 friendly message', async () => {
    (globalThis.fetch as FetchMock).mockRejectedValue(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    );
    await expect(
      ollamaProvider.generate({
        apiKey: '',
        apiEndpoint: 'http://localhost:11434',
        model: 'llama3.1:8b',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/not reachable/i);
  });

  it('cost estimate is always 0 (self-hosted)', () => {
    expect(ollamaProvider.estimateCost(1000, 1000, 'llama3.1:8b')).toBe(0);
  });
});
