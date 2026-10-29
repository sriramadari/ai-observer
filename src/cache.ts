import { sha256Hex } from "./sha256";
import type { CacheAdapter, NormalizedRequest, Provider } from "./types";

/** Deterministic cache key for a normalized request. */
export function cacheKey(provider: Provider, req: NormalizedRequest): string {
  const payload = JSON.stringify({
    provider,
    model: req.model,
    messages: req.messages,
    maxTokens: req.maxTokens,
    temperature: req.temperature ?? null,
    extra: req.extra ?? null,
  });
  return "ai-observer:" + sha256Hex(payload);
}

/** In-process LRU-ish cache with TTL. Good for a single instance / tests. */
export function memoryCache(options: { max?: number } = {}): CacheAdapter {
  const max = options.max ?? 1000;
  const store = new Map<string, { value: string; expiresAt: number }>();

  return {
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      // Refresh recency.
      store.delete(key);
      store.set(key, hit);
      return hit.value;
    },
    async set(key, value, ttlSeconds) {
      if (store.size >= max) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
  };
}

interface IoRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  sendCommand?: unknown;
}

/** Wrap an ioredis client as a {@link CacheAdapter}. */
export function redisCache(client: IoRedisLike): CacheAdapter {
  return {
    get: (key) => client.get(key),
    set: async (key, value, ttlSeconds) => {
      await client.set(key, value, "EX", ttlSeconds);
    },
  };
}

/**
 * Accept either a ready {@link CacheAdapter}, a raw ioredis client (auto-wrapped),
 * or `undefined`. Lets `createAI({ cache: redis })` work ergonomically.
 */
export function normalizeCache(cache: unknown): CacheAdapter | undefined {
  if (!cache) return undefined;
  const c = cache as Record<string, unknown>;
  if (typeof c.get !== "function" || typeof c.set !== "function") return undefined;
  // ioredis exposes sendCommand; its set() takes (key, val, 'EX', ttl).
  if (typeof c.sendCommand === "function") return redisCache(cache as IoRedisLike);
  // Otherwise assume it already conforms to CacheAdapter (our 3-arg set).
  return cache as CacheAdapter;
}
