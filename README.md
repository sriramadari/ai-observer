# ai-observer

**One unified AI client for OpenAI, Anthropic & Gemini — with the production glue built in.** Retries, rate-limit handling, Redis response caching, request tracing, cost tracking, and prompt versioning, in a single zero-dependency package.

AI adoption is exploding, but every team re-implements the same plumbing around the raw SDKs. `ai-observer` is that plumbing, done once:

- 🔁 **Unified client** — same `chat()` call across OpenAI, Anthropic, and Gemini; switch providers with one line
- ♻️ **Retries & rate limits** — exponential backoff + jitter on 429/5xx, honors `retry-after`
- ⚡ **Response cache** — Redis or in-memory, keyed by a hash of the request
- 🔬 **Request tracing** — per-call latency, tokens, cost, cache-hit, errors + rolled-up stats
- 💵 **Cost tracking** — per-model pricing with live USD totals by provider and model
- 📝 **Prompt versioning** — register named prompt templates, render by version

```bash
npm install ai-observer
```

> Node ≥ 18, Bun, Deno, edge runtimes and browsers: anything with a global `fetch` (or pass `fetchImpl`). ESM + CJS, fully typed. **No runtime dependencies**, and no Node built-ins: providers are called over HTTPS, so you don't install (or version-pin) any vendor SDK.

---

## What it does and how it helps

**The problem.** Every app that calls an LLM ends up writing the same plumbing around the vendor SDK: retrying 429s, caching repeated prompts, working out what each call cost and remembering which prompt version produced an answer. Each vendor has a different SDK and response shape, so adding a second provider or switching models means writing that plumbing again.

**What it does**

- **One client, three providers.** chat() and complete() work the same across Anthropic, OpenAI and Gemini, over plain HTTPS with no vendor SDK. Every call returns one shape: text, usage, costUsd, cached, latencyMs, and the raw body.
- **Retries.** 429s, 5xx errors and network failures retry with exponential backoff and jitter, and a retry-after header is honoured. Other 4xx errors fail at once, so a bad request doesn't burn retries.
- **Response cache.** Redis (pass an ioredis client) or in-memory, keyed by a SHA-256 of the normalized request with a configurable TTL. Cache hits cost $0.
- **Cost tracking.** Per-model prices turn token usage into USD on every call. Override the table for new models or negotiated rates.
- **Tracing.** Every request is recorded, then rolled up into count, errors, cache hit rate, average latency, tokens and cost by provider and by model. onTrace streams records to your own logs.
- **Prompt versioning.** Register named templates with {{variables}} and pin a version with name@2, so a change to a prompt is deliberate and traceable.

**How it helps**

| Before | With `ai-observer` |
|---|---|
| Switching from OpenAI to Claude means new SDK calls and new response parsing. | Change provider and model; the rest of your code is untouched. |
| A burst of 429s from the provider turns into 500s for your users. | The client waits as told and retries; users see a slower answer, not an error. |
| Repeated prompts (FAQs, evals, users pressing retry) are billed every time. | Identical requests come from the cache at zero cost. |
| "What did we spend on gpt-4o this week?" needs a dashboard export. | getStats().byModel, or your own sink via onTrace. |

**Use it when**

- A backend calls one or more LLM APIs for text completions.
- You want caching, retries and cost numbers without adopting a framework.
- Code that must run on Node, Bun, Deno, edge runtimes or in the browser.

**Not the right tool for**

- Streaming responses or tool calling; it covers request/response text chat today.
- Agent orchestration. It is the HTTP layer underneath, not a framework on top.

**How it works.** Each call runs through a fixed pipeline: normalize the request, look up the cache, call the provider adapter inside the retry loop, price the usage, store the result, record a trace. Adapters are about fifty lines each and only translate between the unified shape and each vendor's wire format. It uses the global fetch (or one you inject) and has no dependencies.

---

## Quick start

```ts
import { createAI } from "ai-observer";
import Redis from "ioredis";

const ai = createAI({
  provider: "anthropic",          // "anthropic" | "openai" | "gemini"
  apiKey: process.env.ANTHROPIC_API_KEY, // or set the conventional env var
  cache: new Redis(),             // optional — also accepts memoryCache()
  tracing: true,                  // collect stats + per-request traces
});

const res = await ai.chat({ prompt: "Summarize Redis in one sentence." });
console.log(res.text);
console.log(res.costUsd, res.usage, res.cached, res.latencyMs);

console.log(ai.getStats());
// { count, totalCostUsd, cacheHitRate, avgLatencyMs, byProvider, byModel, ... }
```

The exact shape from the brief works as written:

```ts
const ai = createAI({ provider: "openai", cache: redis, tracing: true });
```

---

## Unified across providers

`chat()` takes the same request for every provider; `ai-observer` translates to each API and normalizes the response.

```ts
const anthropic = createAI({ provider: "anthropic" }); // default model: claude-opus-4-8
const openai    = createAI({ provider: "openai" });    // default model: gpt-4o
const gemini    = createAI({ provider: "gemini" });    // default model: gemini-1.5-pro

const req = { messages: [
  { role: "system", content: "You are concise." },
  { role: "user", content: "What is a vector database?" },
]};

for (const ai of [anthropic, openai, gemini]) {
  const { provider, text, costUsd } = await ai.chat(req);
  console.log(provider, costUsd, text);
}
```

Every response is a `ChatResponse`: `{ text, provider, model, usage, costUsd, cached, latencyMs, finishReason, raw }`. API keys default to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`.

> **Anthropic note:** `system` messages are hoisted to the top-level `system` parameter, and `temperature` is automatically dropped for **Opus 4.8 / 4.7** (which reject sampling parameters) — so the same request is safe across models.

---

## Caching

Pass an ioredis client (auto-wrapped), a built-in cache, or anything implementing `CacheAdapter`:

```ts
import { createAI, memoryCache, redisCache } from "ai-observer";

createAI({ provider: "openai", cache: new Redis() });        // ioredis, auto-detected
createAI({ provider: "openai", cache: redisCache(client) }); // explicit wrap
createAI({ provider: "openai", cache: memoryCache() });      // in-process, for one instance/tests

// per call
await ai.chat({ prompt: "...", noCache: true }); // skip cache (still traced)
```

Cache hits return instantly with `cached: true` and `costUsd: 0`. TTL defaults to 1 hour (`cacheTtlSeconds`). Keys are a SHA-256 of `{provider, model, messages, maxTokens, temperature, extra}`.

## Retries & rate limits

Retryable failures (`429`, `5xx`, network errors) are retried with exponential backoff + jitter; a server `retry-after` is honored. Non-retryable `4xx` errors throw immediately as an `AIError` (with `.status`, `.provider`, `.body`).

```ts
createAI({ provider: "anthropic", retry: { maxRetries: 5, baseDelayMs: 500 } });
```

## Cost tracking

Costs are computed from a per-model pricing table (USD per 1M tokens). Anthropic prices ship current; **verify and override** OpenAI/Gemini for billing-critical use:

```ts
createAI({
  provider: "openai",
  tracing: true,
  pricing: { openai: { "gpt-4o": { input: 2.5, output: 10 } } }, // merged over defaults
});

ai.getStats().totalCostUsd;     // running total
ai.getStats().byModel;          // { "gpt-4o": { count, costUsd }, ... }
```

## Tracing

With `tracing: true`, every call is recorded. Get aggregates or the raw ring buffer, or stream each record live:

```ts
const ai = createAI({
  provider: "anthropic",
  tracing: true,
  onTrace: (r) => metrics.emit(r), // optional live sink
});

ai.getStats();   // { count, errors, cacheHitRate, totalCostUsd, avgLatencyMs, totalInputTokens, byProvider, byModel }
ai.getTraces();  // recent TraceRecord[] (bounded ring buffer)
```

## Prompt versioning

Register named prompt templates with versions and `{{variable}}` interpolation; pin a version when you need reproducibility.

```ts
import { createPromptManager } from "ai-observer";

const prompts = createPromptManager();
prompts.register("summarize", { version: 1, template: "Summarize: {{text}}" });
prompts.register("summarize", { version: 2, template: "Give a TL;DR of:\n{{text}}" });

await ai.chat({ prompt: prompts.render("summarize", { text: doc }) });    // latest (v2)
await ai.chat({ prompt: prompts.render("summarize@1", { text: doc }) });  // pinned to v1

prompts.renderMessage("summarize", { text: doc }); // -> { role, content }
```

---

## API

| Export | Purpose |
| --- | --- |
| `createAI(options)` → `AIClient` | The unified client. |
| `ai.chat(request)` → `ChatResponse` | One completion through cache → retry → cost → trace. |
| `ai.complete(prompt)` → `string` | Convenience: prompt in, text out. |
| `ai.getStats()` / `ai.getTraces()` | Aggregated stats / recent traces (needs `tracing: true`). |
| `memoryCache()` / `redisCache(client)` | Cache adapters. |
| `createPromptManager()` | Versioned prompt registry. |
| `computeCost` / `DEFAULT_PRICING` / `mergePricing` | Cost helpers. |
| `withRetry(fn, opts)` | Standalone retry helper. |
| `Tracer` | Standalone tracer. |
| `anthropicAdapter` / `openaiAdapter` / `geminiAdapter` | Low-level provider adapters. |
| `AIError` | Typed provider error (`status`, `provider`, `retryable`, `body`). |

### `createAI` options

`provider` (required), `apiKey`, `model`, `maxTokens` (1024), `cache`, `cacheTtlSeconds` (3600), `tracing` (false), `traceBufferSize` (500), `onTrace`, `retry`, `pricing`, `baseUrl`, `timeoutMs` (120000), `fetchImpl`, `logger`.

## Notes & caveats

- Providers are called via raw HTTPS using the documented request shapes; pass `baseUrl` to route through a proxy/gateway or a local mock.
- Default OpenAI/Gemini **pricing is best-effort** and may lag provider changes — override `pricing` for anything billing-critical. Unknown models cost `0` and log a one-time warning.
- `usage` token counts come straight from each provider's response.
- The package never installs a vendor SDK; bring your own keys.

## License

MIT
