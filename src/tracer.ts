import type { Provider, TraceRecord } from "./types";

export interface TracerStats {
  count: number;
  errors: number;
  cacheHits: number;
  cacheHitRate: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Record<string, { count: number; costUsd: number }>;
  byModel: Record<string, { count: number; costUsd: number }>;
}

/**
 * Collects per-request {@link TraceRecord}s in a bounded ring buffer and rolls
 * them up into {@link TracerStats}. Aggregate counters are lifetime totals; the
 * ring buffer holds only the most recent `bufferSize` traces.
 */
export class Tracer {
  private readonly buffer: TraceRecord[] = [];
  private readonly bufferSize: number;

  private count = 0;
  private errors = 0;
  private cacheHits = 0;
  private totalCost = 0;
  private totalLatency = 0;
  private totalInput = 0;
  private totalOutput = 0;
  private readonly byProvider = new Map<string, { count: number; costUsd: number }>();
  private readonly byModel = new Map<string, { count: number; costUsd: number }>();

  constructor(
    bufferSize = 500,
    private readonly onRecord?: (record: TraceRecord) => void,
  ) {
    this.bufferSize = Math.max(1, bufferSize);
  }

  record(record: TraceRecord): void {
    this.count++;
    if (!record.ok) this.errors++;
    if (record.cached) this.cacheHits++;
    this.totalCost += record.costUsd;
    this.totalLatency += record.latencyMs;
    this.totalInput += record.usage.inputTokens;
    this.totalOutput += record.usage.outputTokens;
    bump(this.byProvider, record.provider, record.costUsd);
    bump(this.byModel, record.model, record.costUsd);

    this.buffer.push(record);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();

    try {
      this.onRecord?.(record);
    } catch {
      /* never let a trace sink break the request path */
    }
  }

  getTraces(): TraceRecord[] {
    return [...this.buffer];
  }

  getStats(): TracerStats {
    return {
      count: this.count,
      errors: this.errors,
      cacheHits: this.cacheHits,
      cacheHitRate: this.count ? this.cacheHits / this.count : 0,
      totalCostUsd: Math.round(this.totalCost * 1e6) / 1e6,
      avgLatencyMs: this.count ? Math.round(this.totalLatency / this.count) : 0,
      totalInputTokens: this.totalInput,
      totalOutputTokens: this.totalOutput,
      byProvider: mapToObject(this.byProvider),
      byModel: mapToObject(this.byModel),
    };
  }
}

function bump(m: Map<string, { count: number; costUsd: number }>, key: string, cost: number): void {
  const e = m.get(key) ?? { count: 0, costUsd: 0 };
  e.count++;
  e.costUsd = Math.round((e.costUsd + cost) * 1e6) / 1e6;
  m.set(key, e);
}

function mapToObject(
  m: Map<string, { count: number; costUsd: number }>,
): Record<string, { count: number; costUsd: number }> {
  return Object.fromEntries(m);
}

export type { Provider };
