const PERF_BUFFER_KEY = '__twe_perf_events_v1';
const PERF_SUMMARY_KEY = '__twe_perf_summary_v1';
const PERF_EVENT_NAME = 'twe:perf-event-v1';
const PERF_BUFFER_LIMIT = 1000;

export type PerfEventKind = 'search' | 'viewer' | 'export' | 'db' | 'worker' | 'hook' | 'longtask';

export type PerfMetricEvent = {
  schema: 'twe.perf.event.v1';
  id: string;
  name: string;
  kind: PerfEventKind;
  atMs: number;
  durationMs?: number;
  value?: number;
  tags?: Record<string, string | number | boolean | undefined>;
};

type PerfSummaryBucket = {
  count: number;
  totalMs: number;
  maxMs: number;
  values: number[];
};

export type PerfDiagnosticsSummary = {
  schema: 'twe.perf.diagnostics.v1';
  generatedAtMs: number;
  eventsBuffered: number;
  buckets: Record<
    string,
    {
      count: number;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      avgMs: number;
    }
  >;
  counters: Record<string, number>;
  workers: {
    searchWorkerAvailable?: boolean;
    exportWorkerAvailable?: boolean;
  };
  recent: PerfMetricEvent[];
};

type PerfSummaryState = {
  buckets: Record<string, PerfSummaryBucket>;
  counters: Record<string, number>;
  workers: PerfDiagnosticsSummary['workers'];
};

let longTaskObserverStarted = false;

function getGlobalRecord(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `perf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readEventsMutable(): PerfMetricEvent[] {
  const g = getGlobalRecord();
  if (!Array.isArray(g[PERF_BUFFER_KEY])) {
    g[PERF_BUFFER_KEY] = [];
  }
  return g[PERF_BUFFER_KEY] as PerfMetricEvent[];
}

function readSummaryMutable(): PerfSummaryState {
  const g = getGlobalRecord();
  const current = g[PERF_SUMMARY_KEY];
  if (!current || typeof current !== 'object') {
    const next: PerfSummaryState = { buckets: {}, counters: {}, workers: {} };
    g[PERF_SUMMARY_KEY] = next;
    return next;
  }
  const state = current as PerfSummaryState;
  state.buckets ||= {};
  state.counters ||= {};
  state.workers ||= {};
  return state;
}

function bucketKey(kind: PerfEventKind, name: string): string {
  return `${kind}:${name}`;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Number(sorted[index]?.toFixed(2) || 0);
}

function sanitizeTags(tags: PerfMetricEvent['tags']): PerfMetricEvent['tags'] {
  if (!tags) return undefined;
  const out: NonNullable<PerfMetricEvent['tags']> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      out[key] = value.length > 160 ? `${value.slice(0, 160)}...` : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function recordPerfMetric(args: {
  name: string;
  kind: PerfEventKind;
  durationMs?: number;
  value?: number;
  tags?: PerfMetricEvent['tags'];
}): PerfMetricEvent {
  const event: PerfMetricEvent = {
    schema: 'twe.perf.event.v1',
    id: createId(),
    name: args.name,
    kind: args.kind,
    atMs: Date.now(),
    durationMs: Number.isFinite(args.durationMs) ? Number(args.durationMs) : undefined,
    value: Number.isFinite(args.value) ? Number(args.value) : undefined,
    tags: sanitizeTags(args.tags),
  };

  const events = readEventsMutable();
  events.push(event);
  if (events.length > PERF_BUFFER_LIMIT) {
    events.splice(0, events.length - PERF_BUFFER_LIMIT);
  }

  const summary = readSummaryMutable();
  summary.counters[`${event.kind}:${event.name}:count`] =
    (summary.counters[`${event.kind}:${event.name}:count`] || 0) + 1;
  if (typeof event.value === 'number') {
    summary.counters[`${event.kind}:${event.name}:value`] = event.value;
  }
  if (typeof event.durationMs === 'number') {
    const key = bucketKey(event.kind, event.name);
    const bucket = summary.buckets[key] || { count: 0, totalMs: 0, maxMs: 0, values: [] };
    bucket.count += 1;
    bucket.totalMs += event.durationMs;
    bucket.maxMs = Math.max(bucket.maxMs, event.durationMs);
    bucket.values.push(event.durationMs);
    if (bucket.values.length > 300) {
      bucket.values.splice(0, bucket.values.length - 300);
    }
    summary.buckets[key] = bucket;
  }

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(PERF_EVENT_NAME, { detail: event }));
    } catch {
      // ignore dispatch failures
    }
  }

  return event;
}

export function incrementPerfCounter(name: string, value = 1): void {
  const summary = readSummaryMutable();
  summary.counters[name] = (summary.counters[name] || 0) + value;
}

export function setWorkerAvailability(worker: 'search' | 'export', available: boolean): void {
  const summary = readSummaryMutable();
  if (worker === 'search') {
    summary.workers.searchWorkerAvailable = available;
  } else {
    summary.workers.exportWorkerAvailable = available;
  }
  recordPerfMetric({
    kind: 'worker',
    name: `${worker}-availability`,
    value: available ? 1 : 0,
  });
}

export function readPerfDiagnostics(): PerfDiagnosticsSummary {
  const events = [...readEventsMutable()];
  const summary = readSummaryMutable();
  const buckets: PerfDiagnosticsSummary['buckets'] = {};
  for (const [key, bucket] of Object.entries(summary.buckets)) {
    buckets[key] = {
      count: bucket.count,
      p50Ms: percentile(bucket.values, 0.5),
      p95Ms: percentile(bucket.values, 0.95),
      maxMs: Number(bucket.maxMs.toFixed(2)),
      avgMs: bucket.count ? Number((bucket.totalMs / bucket.count).toFixed(2)) : 0,
    };
  }

  return {
    schema: 'twe.perf.diagnostics.v1',
    generatedAtMs: Date.now(),
    eventsBuffered: events.length,
    buckets,
    counters: { ...summary.counters },
    workers: { ...summary.workers },
    recent: events.slice(-100),
  };
}

export function clearPerfMetrics(): void {
  const g = getGlobalRecord();
  g[PERF_BUFFER_KEY] = [];
  g[PERF_SUMMARY_KEY] = { buckets: {}, counters: {}, workers: {} } satisfies PerfSummaryState;
}

export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function initializePerformanceMonitoring(): void {
  if (longTaskObserverStarted) return;
  longTaskObserverStarted = true;

  try {
    const ObserverCtor = (
      globalThis as unknown as { PerformanceObserver?: typeof PerformanceObserver }
    ).PerformanceObserver;
    if (!ObserverCtor) return;
    const supported = (
      ObserverCtor as typeof PerformanceObserver & { supportedEntryTypes?: string[] }
    ).supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes('longtask')) return;

    const observer = new ObserverCtor((list) => {
      for (const entry of list.getEntries()) {
        recordPerfMetric({
          kind: 'longtask',
          name: 'main-thread-longtask',
          durationMs: entry.duration,
          tags: { entryType: entry.entryType },
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Long Task API is unavailable in some browsers/contexts.
  }
}

export const perfMetricKeys = {
  eventName: PERF_EVENT_NAME,
  bufferKey: PERF_BUFFER_KEY,
  summaryKey: PERF_SUMMARY_KEY,
};
