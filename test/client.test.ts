import { describe, expect, it, vi } from "vitest";
import { createAI } from "../src/client";
import { memoryCache } from "../src/cache";
import type { FetchImpl } from "../src/providers";

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** Build a mock fetch returning `responseBody`, capturing the last request. */
function mockFetch(responseBody: unknown, status = 200): { fetchImpl: FetchImpl; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers ?? {} });
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

const ANTHROPIC_OK = {
  content: [{ type: "text", text: "hello world" }],
  model: "claude-opus-4-8",
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe("AIClient — anthropic", () => {
  it("calls the Messages API and maps the response + cost", async () => {
    const { fetchImpl, calls } = mockFetch(ANTHROPIC_OK);
    const ai = createAI({ provider: "anthropic", apiKey: "k", fetchImpl });
    const res = await ai.chat({ prompt: "hi" });

    expect(res.text).toBe("hello world");
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe("claude-opus-4-8");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(res.costUsd).toBeCloseTo(0.000175, 9);
    expect(res.cached).toBe(false);

    expect(calls[0]!.url).toContain("/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe("k");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]!.body.max_tokens).toBe(1024);
    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("hoists system messages to the top-level system param", async () => {
    const { fetchImpl, calls } = mockFetch(ANTHROPIC_OK);
    const ai = createAI({ provider: "anthropic", apiKey: "k", fetchImpl });
    await ai.chat({ messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "hi" }] });
    expect(calls[0]!.body.system).toBe("Be terse.");
    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("drops temperature for Opus 4.8 but keeps it for Sonnet 4.6", async () => {
    const m1 = mockFetch(ANTHROPIC_OK);
    await createAI({ provider: "anthropic", apiKey: "k", fetchImpl: m1.fetchImpl }).chat({ prompt: "hi", temperature: 0.7 });
    expect(m1.calls[0]!.body.temperature).toBeUndefined();

    const m2 = mockFetch({ ...ANTHROPIC_OK, model: "claude-sonnet-4-6" });
    await createAI({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-4-6", fetchImpl: m2.fetchImpl }).chat({ prompt: "hi", temperature: 0.7 });
    expect(m2.calls[0]!.body.temperature).toBe(0.7);
  });

  it("serves the second identical call from cache (no second fetch)", async () => {
    const { fetchImpl, calls } = mockFetch(ANTHROPIC_OK);
    const ai = createAI({ provider: "anthropic", apiKey: "k", fetchImpl, cache: memoryCache() });
    const first = await ai.chat({ prompt: "same" });
    const second = await ai.chat({ prompt: "same" });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.text).toBe("hello world");
    expect(second.costUsd).toBe(0); // cache hits are free
    expect(calls.length).toBe(1);
  });

  it("bypasses cache when noCache is set", async () => {
    const { fetchImpl, calls } = mockFetch(ANTHROPIC_OK);
    const ai = createAI({ provider: "anthropic", apiKey: "k", fetchImpl, cache: memoryCache() });
    await ai.chat({ prompt: "x" });
    await ai.chat({ prompt: "x", noCache: true });
    expect(calls.length).toBe(2);
  });

  it("complete() returns just the text", async () => {
    const { fetchImpl } = mockFetch(ANTHROPIC_OK);
    const ai = createAI({ provider: "anthropic", apiKey: "k", fetchImpl });
    expect(await ai.complete("hi")).toBe("hello world");
  });

  it("throws a clear error when the API key is missing", async () => {
    const { fetchImpl } = mockFetch(ANTHROPIC_OK);
    const ai = createAI({ provider: "anthropic", apiKey: "", fetchImpl });
    await expect(ai.chat({ prompt: "hi" })).rejects.toThrow(/missing API key/);
  });
});

describe("AIClient — openai & gemini mapping", () => {
  it("maps OpenAI chat completions", async () => {
    const { fetchImpl, calls } = mockFetch({
      choices: [{ message: { content: "oai" }, finish_reason: "stop" }],
      model: "gpt-4o",
      usage: { prompt_tokens: 3, completion_tokens: 7 },
    });
    const ai = createAI({ provider: "openai", apiKey: "k", fetchImpl });
    const res = await ai.chat({ prompt: "hi", temperature: 0.5 });
    expect(res.text).toBe("oai");
    expect(res.usage.totalTokens).toBe(10);
    expect(calls[0]!.url).toContain("/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
    expect(calls[0]!.body.temperature).toBe(0.5);
  });

  it("maps Gemini generateContent (assistant -> model role)", async () => {
    const { fetchImpl, calls } = mockFetch({
      candidates: [{ content: { parts: [{ text: "gem" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 },
    });
    const ai = createAI({ provider: "gemini", apiKey: "k", model: "gemini-1.5-pro", fetchImpl });
    const res = await ai.chat({ messages: [{ role: "assistant", content: "prev" }, { role: "user", content: "hi" }] });
    expect(res.text).toBe("gem");
    expect(res.usage.totalTokens).toBe(10);
    expect(calls[0]!.url).toContain(":generateContent?key=k");
    expect(calls[0]!.body.contents[0].role).toBe("model");
  });
});

describe("AIClient — tracing & retries", () => {
  it("records stats and tags prompt traces", async () => {
    const { fetchImpl } = mockFetch(ANTHROPIC_OK);
    const ai = createAI({ provider: "anthropic", apiKey: "k", fetchImpl, tracing: true, cache: memoryCache() });
    await ai.chat({ prompt: "a" });
    await ai.chat({ prompt: "a" }); // cache hit
    const stats = ai.getStats();
    expect(stats.count).toBe(2);
    expect(stats.cacheHits).toBe(1);
    expect(stats.totalCostUsd).toBeCloseTo(0.000175, 9);
  });

  it("retries on 503 then succeeds, and records the eventual success", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify(ANTHROPIC_OK), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as FetchImpl;
    const ai = createAI({ provider: "anthropic", apiKey: "k", fetchImpl, tracing: true, retry: { baseDelayMs: 1, sleep: async () => {}, jitter: () => 0 } });
    const res = await ai.chat({ prompt: "hi" });
    expect(res.text).toBe("hello world");
    expect(n).toBe(2);
  });

  it("records an error trace and rethrows on non-retryable failure", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as FetchImpl;
    const ai = createAI({ provider: "anthropic", apiKey: "k", fetchImpl, tracing: true });
    await expect(ai.chat({ prompt: "hi" })).rejects.toThrow(/HTTP 400/);
    const stats = ai.getStats();
    expect(stats.errors).toBe(1);
    expect(ai.getTraces()[0]!.error).toContain("bad");
  });
});
