import { AIError } from "./errors";

export interface RetryOptions {
  /** Max attempts (including the first). Default: 3. */
  maxRetries?: number;
  /** Base backoff in ms (doubles each attempt). Default: 500. */
  baseDelayMs?: number;
  /** Cap on a single backoff in ms. Default: 20000. */
  maxDelayMs?: number;
  /** Deterministic sleep + jitter hooks (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number; // returns [0,1)
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying on retryable {@link AIError}s (429 / 5xx / network) with
 * exponential backoff + jitter. Honors a server `retry-after` when present.
 * Non-retryable errors (4xx other than 429) propagate immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 20_000;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AIError ? err.retryable : false;
      if (!retryable || attempt === maxRetries) throw err;

      const serverHint = err instanceof AIError ? err.retryAfterMs : undefined;
      const backoff = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      const delay = serverHint ?? backoff + Math.floor(jitter() * baseDelay);
      options.onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }
  throw lastError;
}
