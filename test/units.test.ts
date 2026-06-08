import { describe, expect, it, vi } from "vitest";
import { computeCost, mergePricing, DEFAULT_PRICING } from "../src/pricing";
import { createPromptManager } from "../src/prompts";
import { cacheKey, memoryCache, normalizeCache, redisCache } from "../src/cache";
import { withRetry } from "../src/retry";
import { AIError } from "../src/errors";
import { Tracer } from "../src/tracer";

describe("pricing", () => {
  it("computes cost from per-1M rates", () => {
    const cost = computeCost("anthropic", "claude-opus-4-8", { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, DEFAULT_PRICING);
    // 10/1e6*5 + 5/1e6*25 = 0.000175
    expect(cost).toBeCloseTo(0.000175, 9);
  });
  it("returns 0 for unknown models", () => {
    expect(computeCost("openai", "made-up", { inputTokens: 100, outputTokens: 100, totalTokens: 200 }, DEFAULT_PRICING)).toBe(0);
  });
  it("merges overrides over defaults", () => {
    const merged = mergePricing({ openai: { "gpt-4o": { input: 1, output: 2 } } });
    expect(merged.openai!["gpt-4o"]).toEqual({ input: 1, output: 2 });
    expect(merged.anthropic!["claude-opus-4-8"]).toEqual({ input: 5, output: 25 }); // untouched
  });
});

describe("PromptManager", () => {
  it("renders latest version with {{var}} substitution", () => {
    const p = createPromptManager();
    p.register("greet", { version: 1, template: "Hello {{name}}" });
    p.register("greet", { version: 2, template: "Hi {{name}}!" });
    expect(p.render("greet", { name: "Bob" })).toBe("Hi Bob!");
    expect(p.render("greet@1", { name: "Bob" })).toBe("Hello Bob");
    expect(p.label("greet")).toBe("greet@2");
    expect(p.versions("greet")).toEqual([1, 2]);
  });
  it("renders a message with the configured role", () => {
    const p = createPromptManager();
    p.register("sys", { version: 1, template: "You are {{x}}.", role: "system" });
    expect(p.renderMessage("sys", { x: "helpful" })).toEqual({ role: "system", content: "You are helpful." });
  });
  it("throws on missing prompt or version", () => {
    const p = createPromptManager();
    expect(() => p.render("nope")).toThrow(/no prompt registered/);
    p.register("x", { version: 1, template: "a" });
    expect(() => p.render("x@9")).toThrow(/no version 9/);
  });
});

describe("cache", () => {
  it("cacheKey is deterministic and order-sensitive on content", () => {
    const base = { model: "m", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 10 };
    expect(cacheKey("openai", base)).toBe(cacheKey("openai", { ...base }));
    expect(cacheKey("openai", base)).not.toBe(cacheKey("anthropic", base));
  });
  it("memoryCache stores, expires, and evicts", async () => {
    const c = memoryCache({ max: 2 });
    await c.set("a", "1", 60);
    expect(await c.get("a")).toBe("1");
    await c.set("a", "2", -1); // already expired
    expect(await c.get("a")).toBe(null);
  });
  it("normalizeCache wraps an ioredis-like client", async () => {
    const calls: any[] = [];
    const fakeRedis = {
      get: async (k: string) => (k === "x" ? "v" : null),
      set: async (...args: any[]) => { calls.push(args); },
      sendCommand: () => {},
    };
    const adapter = normalizeCache(fakeRedis)!;
    expect(await adapter.get("x")).toBe("v");
    await adapter.set("k", "val", 30);
    expect(calls[0]).toEqual(["k", "val", "EX", 30]);
  });
  it("normalizeCache passes through a CacheAdapter unchanged", () => {
    const c = memoryCache();
    expect(normalizeCache(c)).toBe(c);
    expect(normalizeCache(undefined)).toBeUndefined();
  });
});

describe("withRetry", () => {
  const opts = { sleep: async () => {}, jitter: () => 0, baseDelayMs: 1 };

  it("retries retryable errors then succeeds", async () => {
    let n = 0;
    const result = await withRetry(async () => {
      n++;
      if (n < 3) throw new AIError("503", { status: 503, retryable: true });
      return "ok";
    }, opts);
    expect(result).toBe("ok");
    expect(n).toBe(3);
  });
  it("does not retry non-retryable errors", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new AIError("400", { status: 400, retryable: false }); }, opts)).rejects.toThrow("400");
    expect(n).toBe(1);
  });
  it("gives up after maxRetries", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new AIError("429", { status: 429, retryable: true }); }, { ...opts, maxRetries: 2 })).rejects.toThrow("429");
    expect(n).toBe(2);
  });
  it("honors server retry-after", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(async () => {
      n++;
      if (n === 1) throw new AIError("429", { status: 429, retryable: true, retryAfterMs: 1234 });
      return "ok";
    }, { ...opts, sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([1234]);
  });
});

describe("Tracer", () => {
  it("aggregates stats across records", () => {
    const t = new Tracer();
    t.record({ provider: "anthropic", model: "claude-opus-4-8", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, costUsd: 0.001, latencyMs: 100, cached: false, ok: true, at: "t" });
    t.record({ provider: "anthropic", model: "claude-opus-4-8", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, costUsd: 0, latencyMs: 2, cached: true, ok: true, at: "t" });
    t.record({ provider: "openai", model: "gpt-4o", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, costUsd: 0, latencyMs: 50, cached: false, ok: false, error: "boom", at: "t" });
    const s = t.getStats();
    expect(s.count).toBe(3);
    expect(s.errors).toBe(1);
    expect(s.cacheHits).toBe(1);
    expect(s.cacheHitRate).toBeCloseTo(1 / 3);
    expect(s.totalCostUsd).toBeCloseTo(0.001);
    expect(s.byProvider.anthropic!.count).toBe(2);
    expect(s.byModel["gpt-4o"]!.count).toBe(1);
  });
  it("bounds the ring buffer", () => {
    const t = new Tracer(2);
    for (let i = 0; i < 5; i++) t.record({ provider: "openai", model: "gpt-4o", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, costUsd: 0, latencyMs: 1, cached: false, ok: true, at: String(i) });
    expect(t.getTraces().map((r) => r.at)).toEqual(["3", "4"]);
    expect(t.getStats().count).toBe(5); // lifetime
  });
});
