/**
 * Provider registry — central directory of available AI providers and their
 * default model menus. Ported from ZaloCRM-3.0's pattern (SPEC §9.c) where a
 * declarative `m()` helper drops models whose env var is unset.
 *
 * In ZaloCRM-4.x the actual model choice + key live on `AiConfig` per org
 * (BYOK). This registry mostly serves the Settings UI: "what providers are
 * supported, and what models can the admin pick from for each?"
 */
import { anthropicProvider } from './providers/anthropic.js';
import { geminiProvider } from './providers/gemini.js';
import { ollamaProvider } from './providers/ollama.js';
import {
  openaiProvider,
  qwenProvider,
  kimiProvider,
} from './providers/openai-compat.js';
import type { AiProvider, ProviderId } from './providers/types.js';

export type ProviderModel = { title: string; value: string };

export interface ProviderDef {
  id: ProviderId;
  name: string;
  /** Whether the provider needs an API key at all (Ollama → no). */
  requiresApiKey: boolean;
  /** Default model menu rendered in the Settings dropdown. */
  models: ProviderModel[];
  /** Adapter implementation. */
  adapter: AiProvider;
}

/**
 * Declarative `m()` helper from SPEC §9.c. Returns null when the value is
 * falsy; the parent filter strips nulls. Kept around so future migrations can
 * env-gate models cheaply.
 */
function m(title: string, value: string | undefined | null): ProviderModel | null {
  return value ? { title, value } : null;
}

const ANTHROPIC_MODELS = [
  m('Claude Opus 4', 'claude-opus-4'),
  m('Claude Sonnet 4.6', 'claude-sonnet-4-6'),
  m('Claude Sonnet 4', 'claude-sonnet-4'),
  m('Claude Haiku 4.5', 'claude-haiku-4-5'),
].filter((x): x is ProviderModel => x !== null);

const OPENAI_MODELS = [
  m('GPT-4o', 'gpt-4o'),
  m('GPT-4o mini', 'gpt-4o-mini'),
  m('GPT-4 Turbo', 'gpt-4-turbo'),
].filter((x): x is ProviderModel => x !== null);

const GEMINI_MODELS = [
  m('Gemini 2.0 Flash', 'gemini-2.0-flash'),
  m('Gemini 1.5 Pro', 'gemini-1.5-pro'),
  m('Gemini 1.5 Flash', 'gemini-1.5-flash'),
].filter((x): x is ProviderModel => x !== null);

const QWEN_MODELS = [
  m('Qwen Max', 'qwen-max'),
  m('Qwen Plus', 'qwen-plus'),
  m('Qwen Turbo', 'qwen-turbo'),
].filter((x): x is ProviderModel => x !== null);

const KIMI_MODELS = [
  m('Moonshot v1 8k', 'moonshot-v1-8k'),
  m('Moonshot v1 32k', 'moonshot-v1-32k'),
  m('Moonshot v1 128k', 'moonshot-v1-128k'),
].filter((x): x is ProviderModel => x !== null);

const OLLAMA_MODELS = [
  m('Llama 3.1 8B', 'llama3.1:8b'),
  m('Llama 3.1 70B', 'llama3.1:70b'),
  m('Qwen 2.5 7B', 'qwen2.5:7b'),
  m('Mistral', 'mistral'),
].filter((x): x is ProviderModel => x !== null);

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    requiresApiKey: true,
    models: ANTHROPIC_MODELS,
    adapter: anthropicProvider,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    requiresApiKey: true,
    models: OPENAI_MODELS,
    adapter: openaiProvider,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    requiresApiKey: true,
    models: GEMINI_MODELS,
    adapter: geminiProvider,
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba)',
    requiresApiKey: true,
    models: QWEN_MODELS,
    adapter: qwenProvider,
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    requiresApiKey: true,
    models: KIMI_MODELS,
    adapter: kimiProvider,
  },
  {
    id: 'ollama',
    name: 'Ollama (self-hosted)',
    requiresApiKey: false,
    models: OLLAMA_MODELS,
    adapter: ollamaProvider,
  },
];

const BY_ID: Record<string, ProviderDef> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
);

/** Returns the registered provider definition or undefined. */
export function getProviderById(id: string): ProviderDef | undefined {
  return BY_ID[id];
}

/** Type-narrowing helper — returns true iff `id` is a known provider id. */
export function isKnownProvider(id: string): id is ProviderId {
  return id in BY_ID;
}

/**
 * Returns the public list of providers (no adapter reference, safe to send
 * to the frontend).
 */
export function listProviders(): Array<Omit<ProviderDef, 'adapter'>> {
  return PROVIDERS.map(({ adapter: _adapter, ...rest }) => rest);
}
