/** Supported providers. */
export type Provider = "anthropic" | "openai" | "gemini";

/** A chat message in the unified format. */
export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Minimal logger contract. `console` satisfies it. */
export interface Logger {
  info(message: string): void;
  error(message: string | Error): void;
  warn?(message: string): void;
  debug?(message: string): void;
}

/** A unified chat request. */
export interface ChatRequest {
  /** Either `messages`, or a single `prompt` string (becomes one user message). */
  messages?: Message[];
  prompt?: string;
  /** Override the client's default model for this call. */
  model?: string;
  /** Max output tokens. Defaults to 1024 (required by Anthropic). */
  maxTokens?: number;
  /**
   * Sampling temperature. NOTE: silently dropped for Anthropic Opus 4.8 / 4.7,
   * which reject sampling parameters.
   */
  temperature?: number;
  /** Skip the cache for this request (still records a trace). */
  noCache?: boolean;
  /** Provider-specific fields merged into the request body verbatim. */
  extra?: Record<string, unknown>;
}

/** Token usage for a single call. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** A unified chat response. */
export interface ChatResponse {
  text: string;
  provider: Provider;
  model: string;
  usage: Usage;
  /** Estimated cost in USD (0 if model not in the pricing table, or served from cache). */
  costUsd: number;
  /** True when served from the response cache. */
  cached: boolean;
  /** Wall-clock latency in ms (cache lookups are fast; provider calls include network). */
  latencyMs: number;
  finishReason?: string;
  /** The raw provider response body (undefined for cache hits unless cached). */
  raw?: unknown;
}

/** Normalized request handed to a provider adapter. */
export interface NormalizedRequest {
  model: string;
  messages: Message[];
  maxTokens: number;
  temperature?: number;
  extra?: Record<string, unknown>;
}

/** What a provider adapter returns. */
export interface ProviderResult {
  text: string;
  model: string;
  usage: Usage;
  finishReason?: string;
  raw: unknown;
}

/** A pluggable cache. `redisCache()` and `memoryCache()` produce these. */
export interface CacheAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** One recorded request, surfaced via {@link AIClient.getTraces}. */
export interface TraceRecord {
  provider: Provider;
  model: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  cached: boolean;
  ok: boolean;
  error?: string;
  /** Prompt name@version when the call came from a registered prompt. */
  prompt?: string;
  at: string;
}
