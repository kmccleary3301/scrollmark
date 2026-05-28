import type { DataType } from './exporter';

export type ExportMetadataMode = 'none' | 'all' | 'custom';

export const DEFAULT_METADATA_FIELDS = [
  'rest_id',
  'legacy.created_at',
  'legacy.full_text',
  'legacy.lang',
  'legacy.entities',
  'legacy.extended_entities',
  'core.user_results.result.rest_id',
  'core.user_results.result.legacy.screen_name',
  'core.user_results.result.legacy.name',
  'core.user_results.result.is_blue_verified',
  'twe_private_fields.created_at',
  'twe_private_fields.updated_at',
  '__bookmark_folder_id',
  '__bookmark_folder_name',
  '__bookmark_folder_url',
] as const;

export function cloneSnapshotValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON cloning.
    }
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export function getAccessorPathValue(record: unknown, path: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const parts = path.split('.');
  let current: unknown = record;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function normalizeMetadataFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function buildCustomMetadata(recordSource: unknown, fields: string[]): DataType {
  const metadata: DataType = {};
  for (const field of fields) {
    const value = getAccessorPathValue(recordSource, field);
    if (value !== undefined) {
      metadata[field] = cloneSnapshotValue(value);
    }
  }
  return metadata;
}

export function applyMetadataToRecord(
  record: DataType,
  original: unknown,
  mode: ExportMetadataMode,
  fields: string[],
) {
  if (mode === 'all') {
    record.metadata = cloneSnapshotValue(original);
    return;
  }

  if (mode === 'custom') {
    record.metadata = buildCustomMetadata(original, fields);
  }
}
