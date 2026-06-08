import type { Provider } from "../types";
import { anthropicAdapter } from "./anthropic";
import type { ProviderAdapter } from "./base";
import { geminiAdapter } from "./gemini";
import { openaiAdapter } from "./openai";

export const ADAPTERS: Record<Provider, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(provider: Provider): ProviderAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(
      `ai-observer: unknown provider "${provider}" (expected anthropic | openai | gemini)`,
    );
  }
  return adapter;
}

export type { ProviderAdapter, AdapterOptions, FetchImpl } from "./base";
export { anthropicAdapter, openaiAdapter, geminiAdapter };
