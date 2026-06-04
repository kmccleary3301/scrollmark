import type { ResultSourceDescriptor } from './result-source';

const RESULT_SOURCE_DIAGNOSTICS_KEY = '__scrollmark_result_source_diagnostics_v1';
const RESULT_SOURCE_DIAGNOSTICS_LIMIT = 24;

export type ResultSourceDiagnosticsEntry = {
  schema: 'scrollmark.result_source.diagnostics.v1';
  sourceKey: string;
  descriptor: ResultSourceDescriptor;
  mode: ResultSourceDescriptor['kind'];
  updatedAtMs: number;
  totalCount?: number;
  cachedPages: number;
  cachedRows: number;
  lastFetchDurationMs?: number;
  lastWindowRows?: number;
  lastWindowStartIndex?: number;
  lastCacheHit?: boolean;
  lastError?: string;
};

function readMutableDiagnostics(): Map<string, ResultSourceDiagnosticsEntry> {
  const root = globalThis as unknown as Record<string, unknown>;
  const current = root[RESULT_SOURCE_DIAGNOSTICS_KEY];
  if (current instanceof Map) return current as Map<string, ResultSourceDiagnosticsEntry>;
  const next = new Map<string, ResultSourceDiagnosticsEntry>();
  root[RESULT_SOURCE_DIAGNOSTICS_KEY] = next;
  return next;
}

export function recordResultSourceDiagnostics(
  entry: Omit<ResultSourceDiagnosticsEntry, 'schema' | 'updatedAtMs' | 'mode'> & {
    updatedAtMs?: number;
  },
): void {
  const map = readMutableDiagnostics();
  map.set(entry.sourceKey, {
    schema: 'scrollmark.result_source.diagnostics.v1',
    mode: entry.descriptor.kind,
    updatedAtMs: entry.updatedAtMs ?? Date.now(),
    ...entry,
  });
  while (map.size > RESULT_SOURCE_DIAGNOSTICS_LIMIT) {
    const oldest = [...map.entries()].sort(
      (left, right) => left[1].updatedAtMs - right[1].updatedAtMs,
    )[0];
    if (!oldest) break;
    map.delete(oldest[0]);
  }
}

export function readResultSourceDiagnostics(): ResultSourceDiagnosticsEntry[] {
  return [...readMutableDiagnostics().values()].sort((left, right) => {
    return right.updatedAtMs - left.updatedAtMs;
  });
}

export function clearResultSourceDiagnostics(): void {
  readMutableDiagnostics().clear();
}
