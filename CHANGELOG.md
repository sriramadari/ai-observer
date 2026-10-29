# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.2.0

- **Runs outside Node.** Dropped the `node:crypto` import: cache keys now use a
  built-in pure-JS SHA-256 that produces byte-identical keys, so existing Redis
  entries stay valid. The API-key env lookup no longer assumes `process` exists.
  The client now works in Bun, Deno, edge runtimes and the browser.
- `prepare` script builds `dist/`, so the package can be installed straight from git.

## 0.1.0

Initial release.

- **Unified client** — `createAI({ provider })` with one `chat()` / `complete()`
  surface across Anthropic, OpenAI, and Gemini, called over raw HTTPS (no vendor
  SDK dependency). Responses normalized to `ChatResponse`.
- **Retries** — `withRetry` with exponential backoff + jitter on 429/5xx/network,
  honoring `retry-after`; typed `AIError`.
- **Caching** — `memoryCache()` and `redisCache()` adapters; ioredis clients are
  auto-wrapped. Request-hash keys, configurable TTL, per-call `noCache`.
- **Cost tracking** — per-model pricing tables (`DEFAULT_PRICING`, `mergePricing`,
  `computeCost`) with current Anthropic rates; per-call `costUsd`.
- **Tracing** — `Tracer` with bounded ring buffer + rolled-up stats
  (`getStats`/`getTraces`, `onTrace` sink): count, errors, cache-hit rate, cost,
  latency, tokens, by-provider, by-model.
- **Prompt versioning** — `createPromptManager()` with versioned templates,
  `{{variable}}` interpolation, and `name@version` pinning.
