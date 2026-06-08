import type { Provider } from "./types";

/**
 * Error thrown by provider adapters. Carries the HTTP status, provider, whether
 * the failure is retryable (429 / 5xx / network), and any `retry-after` hint.
 */
export class AIError extends Error {
  readonly provider: Provider | undefined;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly body: unknown;

  constructor(
    message: string,
    opts: {
      provider?: Provider;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "AIError";
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

/** A status is retryable if it's a rate-limit (429) or a server error (>=500). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
