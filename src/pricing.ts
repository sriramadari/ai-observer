import type { Provider, Usage } from "./types";

/** USD per 1,000,000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

export type PricingTable = Record<string, Record<string, ModelPrice>>;

/**
 * Default per-model pricing (USD per 1M tokens).
 *
 * Anthropic prices are current as of 2026-05. OpenAI and Gemini prices are
 * best-effort and may lag provider changes — **verify and override** via the
 * `pricing` option to {@link createAI} for billing-critical use. Unknown models
 * cost `0` (and a warning is logged once).
 */
export const DEFAULT_PRICING: PricingTable = {
  anthropic: {
    "claude-opus-4-8": { input: 5, output: 25 },
    "claude-opus-4-7": { input: 5, output: 25 },
    "claude-opus-4-6": { input: 5, output: 25 },
    "claude-opus-4-5": { input: 5, output: 25 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-sonnet-4-5": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 1, output: 5 },
  },
  openai: {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4.1": { input: 2, output: 8 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4 },
    "o3-mini": { input: 1.1, output: 4.4 },
  },
  gemini: {
    "gemini-2.0-flash": { input: 0.1, output: 0.4 },
    "gemini-1.5-pro": { input: 1.25, output: 5 },
    "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  },
};

/** Deep-merge a user pricing override over the defaults (override wins). */
export function mergePricing(override?: PricingTable): PricingTable {
  if (!override) return DEFAULT_PRICING;
  const out: PricingTable = {};
  for (const provider of new Set([...Object.keys(DEFAULT_PRICING), ...Object.keys(override)])) {
    out[provider] = { ...(DEFAULT_PRICING[provider] ?? {}), ...(override[provider] ?? {}) };
  }
  return out;
}

/** Compute the USD cost of one call. Returns 0 for unpriced models. */
export function computeCost(
  provider: Provider,
  model: string,
  usage: Usage,
  pricing: PricingTable,
): number {
  const price = pricing[provider]?.[model];
  if (!price) return 0;
  const cost = (usage.inputTokens / 1e6) * price.input + (usage.outputTokens / 1e6) * price.output;
  // Round to 6 decimal places (micro-dollar precision).
  return Math.round(cost * 1e6) / 1e6;
}

/** True when the (provider, model) pair has a known price. */
export function hasPrice(provider: Provider, model: string, pricing: PricingTable): boolean {
  return Boolean(pricing[provider]?.[model]);
}
