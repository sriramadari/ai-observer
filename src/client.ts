import { cacheKey, normalizeCache } from "./cache";
import { computeCost, hasPrice, mergePricing, type PricingTable } from "./pricing";
import { getAdapter, type FetchImpl } from "./providers";
import { withRetry, type RetryOptions } from "./retry";
import { Tracer, type TracerStats } from "./tracer";
import type {
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

const consoleLogger: Logger = {
  info: (m) => console.log(m),
  error: (m) => console.error(m),
  warn: (m) => console.warn(m),
  debug: () => {},
};

export interface CreateAIOptions {
  /** Which provider this client targets. */
  provider: Provider;
  /** API key. Defaults to the provider's conventional env var (see below). */
  apiKey?: string;
  /** Default model for every call. Defaults to the provider's default. */
  model?: string;
  /** Default max output tokens. Default: 1024. */
  maxTokens?: number;
  /**
   * Response cache. Pass an ioredis client (auto-wrapped), a {@link CacheAdapter}
   * from `redisCache()`/`memoryCache()`, or omit to disable caching.
   */
  cache?: unknown;
  /** Cache TTL in seconds. Default: 3600. */
  cacheTtlSeconds?: number;
  /** Enable request tracing + cost aggregation. Default: false. */
  tracing?: boolean;
  /** Ring-buffer size for retained traces. Default: 500. */
  traceBufferSize?: number;
  /** Called for every completed request when tracing is on. */
  onTrace?: (record: TraceRecord) => void;
  /** Retry behavior for 429 / 5xx / network errors. */
  retry?: RetryOptions;
  /** Per-model pricing override (USD per 1M tokens), merged over defaults. */
  pricing?: PricingTable;
  /** Override the provider base URL (proxies, gateways, local mocks). */
  baseUrl?: string;
  /** Per-request timeout in ms. Default: 120000. */
  timeoutMs?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: FetchImpl;
  /** Logger for warnings (unknown pricing, etc.). Default: console. */
  logger?: Logger;
}

const ENV_KEYS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

/** A configured client. Created via {@link createAI}. */
export class AIClient {
  readonly provider: Provider;
  readonly model: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly cache: CacheAdapter | undefined;
  private readonly cacheTtl: number;
  private readonly tracer: Tracer | undefined;
  private readonly retry: RetryOptions;
  private readonly pricing: PricingTable;
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: FetchImpl;
  private readonly logger: Logger;
  private readonly warnedModels = new Set<string>();

  constructor(options: CreateAIOptions) {
    this.provider = options.provider;
    const adapter = getAdapter(options.provider);
    this.model = options.model ?? adapter.defaultModel;
    this.apiKey = options.apiKey ?? process.env[ENV_KEYS[options.provider]] ?? "";
    this.maxTokens = options.maxTokens ?? 1024;
    this.cache = normalizeCache(options.cache);
    this.cacheTtl = options.cacheTtlSeconds ?? 3600;
    this.retry = options.retry ?? {};
    this.pricing = mergePricing(options.pricing);
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger ?? consoleLogger;
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchImpl | undefined);
    if (!fetchImpl) {
      throw new Error("ai-observer: global fetch is unavailable (need Node 18+) and no fetchImpl was provided");
    }
    this.fetchImpl = fetchImpl;
    if (options.tracing) {
      this.tracer = new Tracer(options.traceBufferSize ?? 500, options.onTrace);
    }
  }

  /**
   * Run one chat completion through the middleware stack:
   * cache → retry(provider call) → cost → trace.
   *
   * @param promptLabel internal — set by {@link AIClient.run} to tag traces.
   */
  async chat(request: ChatRequest, promptLabel?: string): Promise<ChatResponse> {
    if (!this.apiKey) {
      throw new Error(
        `ai-observer: missing API key for ${this.provider} (set ${ENV_KEYS[this.provider]} or pass apiKey)`,
      );
    }
    const normalized = this.normalize(request);
    const key = this.cache && !request.noCache ? cacheKey(this.provider, normalized) : undefined;
    const start = Date.now();

    // 1. Cache lookup.
    if (key && this.cache) {
      const hit = await this.cache.get(key).catch(() => null);
      if (hit) {
        const cachedResult = JSON.parse(hit) as ProviderResult;
        const response = this.toResponse(cachedResult, true, Date.now() - start);
        this.trace(response, true, promptLabel);
        return response;
      }
    }

    // 2. Provider call with retries.
    const adapter = getAdapter(this.provider);
    let result: ProviderResult;
    try {
      result = await withRetry(
        () =>
          adapter.chat(normalized, {
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            fetchImpl: this.fetchImpl,
            timeoutMs: this.timeoutMs,
          }),
        this.retry,
      );
    } catch (err) {
      this.traceError(normalized.model, Date.now() - start, err, promptLabel);
      throw err;
    }

    const response = this.toResponse(result, false, Date.now() - start);

    // 3. Cache store (best-effort).
    if (key && this.cache) {
      await this.cache.set(key, JSON.stringify(result), this.cacheTtl).catch(() => {});
    }

    // 4. Trace.
    this.trace(response, false, promptLabel);
    return response;
  }

  /** Convenience: send a single user prompt string, get the text back. */
  async complete(prompt: string, options: Omit<ChatRequest, "prompt" | "messages"> = {}): Promise<string> {
    const res = await this.chat({ ...options, prompt });
    return res.text;
  }

  /** Aggregated stats. Throws if tracing wasn't enabled. */
  getStats(): TracerStats {
    if (!this.tracer) throw new Error("ai-observer: tracing is disabled (pass tracing: true)");
    return this.tracer.getStats();
  }

  /** Recent trace records. Throws if tracing wasn't enabled. */
  getTraces(): TraceRecord[] {
    if (!this.tracer) throw new Error("ai-observer: tracing is disabled (pass tracing: true)");
    return this.tracer.getTraces();
  }

  // ---- internals ----

  private normalize(request: ChatRequest): NormalizedRequest {
    const messages: Message[] =
      request.messages ?? (request.prompt !== undefined ? [{ role: "user", content: request.prompt }] : []);
    if (messages.length === 0) {
      throw new Error("ai-observer: chat() requires `messages` or `prompt`");
    }
    return {
      model: request.model ?? this.model,
      messages,
      maxTokens: request.maxTokens ?? this.maxTokens,
      temperature: request.temperature,
      extra: request.extra,
    };
  }

  private toResponse(result: ProviderResult, cached: boolean, latencyMs: number): ChatResponse {
    if (!cached && !hasPrice(this.provider, result.model, this.pricing) && !this.warnedModels.has(result.model)) {
      this.warnedModels.add(result.model);
      this.logger.warn?.(
        `ai-observer: no pricing for ${this.provider}/${result.model}; cost reported as 0. Pass a pricing override.`,
      );
    }
    const costUsd = cached ? 0 : computeCost(this.provider, result.model, result.usage, this.pricing);
    return {
      text: result.text,
      provider: this.provider,
      model: result.model,
      usage: result.usage,
      costUsd,
      cached,
      latencyMs,
      finishReason: result.finishReason,
      raw: result.raw,
    };
  }

  private trace(response: ChatResponse, cached: boolean, promptLabel?: string): void {
    this.tracer?.record({
      provider: response.provider,
      model: response.model,
      usage: response.usage,
      costUsd: response.costUsd,
      latencyMs: response.latencyMs,
      cached,
      ok: true,
      ...(promptLabel ? { prompt: promptLabel } : {}),
      at: new Date().toISOString(),
    });
  }

  private traceError(model: string, latencyMs: number, err: unknown, promptLabel?: string): void {
    const empty: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this.tracer?.record({
      provider: this.provider,
      model,
      usage: empty,
      costUsd: 0,
      latencyMs,
      cached: false,
      ok: false,
      error: (err as Error).message,
      ...(promptLabel ? { prompt: promptLabel } : {}),
      at: new Date().toISOString(),
    });
  }
}

/**
 * Create a unified AI client.
 *
 * @example
 * ```ts
 * const ai = createAI({ provider: "anthropic", cache: redis, tracing: true });
 * const res = await ai.chat({ prompt: "Summarize Redis in one line." });
 * console.log(res.text, res.costUsd, res.cached);
 * console.log(ai.getStats());
 * ```
 */
export function createAI(options: CreateAIOptions): AIClient {
  return new AIClient(options);
}
