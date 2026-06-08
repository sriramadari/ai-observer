import { AIError, isRetryableStatus } from "../errors";
import type { NormalizedRequest, Provider, ProviderResult } from "../types";

/** Injected so tests can stub the network and real use gets global fetch. */
export type FetchImpl = typeof fetch;

export interface AdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl: FetchImpl;
  timeoutMs?: number;
}

export interface ProviderAdapter {
  readonly name: Provider;
  readonly defaultModel: string;
  chat(req: NormalizedRequest, opts: AdapterOptions): Promise<ProviderResult>;
}

/** Parse a `retry-after` header (seconds or HTTP date) into ms, if present. */
function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * POST JSON and return the parsed body, converting transport and HTTP errors
 * into {@link AIError} with correct `retryable` / `retryAfterMs` flags so the
 * retry layer can act on them.
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: AdapterOptions,
  provider: Provider,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = opts.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure / timeout — retryable.
    throw new AIError(`${provider}: request failed: ${(err as Error).message}`, {
      provider,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    throw new AIError(`${provider}: HTTP ${res.status}: ${summarize(parsed) || text.slice(0, 200)}`, {
      provider,
      status: res.status,
      retryable: isRetryableStatus(res.status),
      retryAfterMs: parseRetryAfter(res.headers),
      body: parsed,
    });
  }
  return parsed;
}

function summarize(body: unknown): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: { message?: string } }).error;
    if (err?.message) return err.message;
  }
  return "";
}
