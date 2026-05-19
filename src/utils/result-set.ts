import { SortingState } from '@tanstack/table-core';

export type ResultSetSnapshot = {
  resultSetId: string;
  scope: 'table';
  engine: 'local-sync';
  generatedAtMs: number;
  queryText: string;
  sort: string;
  totalMatches: number;
  ids: string[];
  warnings: string[];
};

function createResultSetId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function extractStableRecordId(record: unknown, index: number): string {
  if (!record || typeof record !== 'object') {
    return `row-${index}`;
  }

  const row = record as Record<string, unknown>;
  const normalizeScalar = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    return '';
  };
  const firstScalar = (...values: unknown[]) => {
    for (const value of values) {
      const normalized = normalizeScalar(value);
      if (normalized) return normalized;
    }
    return '';
  };

  const baseId = firstScalar(
    row.id,
    row.rest_id,
    row.id_str,
    (row.legacy as Record<string, unknown> | undefined)?.id_str,
    (row.core as Record<string, unknown> | undefined)?.screen_name,
    row.screen_name,
  );
  const contextParts = [
    row.__bookmark_folder_id,
    row.__twe_imported_bundle_id,
    row.__twe_imported_snapshot_id,
    row.entryId,
    row.conversationId,
    row.conversation_id,
    row.dm_conversation_id,
  ]
    .map(normalizeScalar)
    .filter(Boolean);
  const id = baseId && contextParts.length ? `${baseId}::${contextParts.join('::')}` : baseId;

  return id || `row-${index}`;
}

function readRecordPath(record: unknown, path: string): unknown {
  let current = record;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizeLookupId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

export function collectRecordLookupIds(record: unknown, fallbackIndex: number): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeLookupId(value);
    if (normalized) ids.add(normalized);
  };

  add(extractStableRecordId(record, fallbackIndex));

  if (record && typeof record === 'object') {
    const row = record as Record<string, unknown>;
    add(row.id);
    add(row.rest_id);
    add(row.id_str);
    add(readRecordPath(row, 'legacy.id_str'));
    add(readRecordPath(row, 'legacy.id'));
    add(readRecordPath(row, 'core.user_results.result.rest_id'));
    add(readRecordPath(row, 'core.screen_name'));
    add(row.__twe_imported_snapshot_id);
    add(row.__twe_imported_source_id);
  }

  return [...ids];
}

export function resolveOrderedAvailableRecords<T>(
  ids: string[],
  recordById: ReadonlyMap<string, T>,
  attemptedIds: ReadonlySet<string> = new Set(),
): T[] {
  const records: T[] = [];

  for (const id of ids) {
    const record = recordById.get(id);
    if (record) {
      records.push(record);
      continue;
    }

    if (attemptedIds.has(id)) {
      continue;
    }

    break;
  }

  return records;
}

export function serializeSortingState(sorting: SortingState | undefined): string {
  if (!sorting?.length) return 'default';
  return sorting.map((entry) => `${entry.id}:${entry.desc ? 'desc' : 'asc'}`).join(',');
}

export function createResultSetSnapshot(args: {
  queryText: string;
  sort: string;
  ids: string[];
  totalMatches: number;
  warnings: string[];
}): ResultSetSnapshot {
  return {
    resultSetId: createResultSetId(),
    scope: 'table',
    engine: 'local-sync',
    generatedAtMs: Date.now(),
    queryText: args.queryText,
    sort: args.sort,
    totalMatches: args.totalMatches,
    ids: [...args.ids],
    warnings: [...args.warnings],
  };
}
