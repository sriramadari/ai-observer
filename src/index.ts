// Client
export { AIClient, createAI } from "./client";
export type { CreateAIOptions } from "./client";

// Caching
export { cacheKey, memoryCache, normalizeCache, redisCache } from "./cache";

// Pricing / cost
export { computeCost, DEFAULT_PRICING, hasPrice, mergePricing } from "./pricing";
export type { ModelPrice, PricingTable } from "./pricing";

// Retry
export { withRetry } from "./retry";
export type { RetryOptions } from "./retry";

// Tracing
export { Tracer } from "./tracer";
export type { TracerStats } from "./tracer";

// Prompt versioning
export { createPromptManager, PromptManager } from "./prompts";
export type { PromptVersion } from "./prompts";

// Providers (advanced / custom use)
export { ADAPTERS, anthropicAdapter, geminiAdapter, getAdapter, openaiAdapter } from "./providers";
export type { AdapterOptions, FetchImpl, ProviderAdapter } from "./providers";

// Errors
export { AIError } from "./errors";

// Types
export type {
  CacheAdapter,
  ChatRequest,
  ChatResponse,
  Logger,
  Message,
  NormalizedRequest,
  Provider,
  ProviderResult,
  TraceRecord,
  Usage,
} from "./types";
