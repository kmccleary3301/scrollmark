import { ColumnDef } from '@tanstack/table-core';
import { parseTwitterDateTime } from '@/utils/common';

function getAccessorPathValue(record: unknown, path: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const parts = path.split('.');
  let current: unknown = record;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizeSortValue(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return String(value).toLowerCase();
}

export function compareSortValues(left: unknown, right: unknown): number {
  const a = normalizeSortValue(left);
  const b = normalizeSortValue(right);
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function flattenLeafColumns<T>(columns: ColumnDef<T>[]): ColumnDef<T>[] {
  const out: ColumnDef<T>[] = [];
  for (const column of columns) {
    if ('columns' in column && Array.isArray(column.columns)) {
      out.push(...flattenLeafColumns(column.columns as ColumnDef<T>[]));
      continue;
    }
    out.push(column);
  }
  return out;
}

export function resolveColumnId<T>(column: ColumnDef<T>): string {
  if ('id' in column && typeof column.id === 'string' && column.id) {
    return column.id;
  }
  if ('accessorKey' in column && typeof column.accessorKey === 'string') {
    return column.accessorKey;
  }
  return '';
}

export function resolveColumnValue<T>(column: ColumnDef<T>, record: T, rowIndex: number): unknown {
  if ('accessorFn' in column && typeof column.accessorFn === 'function') {
    return column.accessorFn(record, rowIndex);
  }
  if ('accessorKey' in column) {
    if (typeof column.accessorKey === 'string') {
      return getAccessorPathValue(record, column.accessorKey);
    }
    if (typeof column.accessorKey === 'number' && Array.isArray(record)) {
      return record[column.accessorKey];
    }
  }
  return undefined;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = asFiniteNumber(value);
  if (numeric !== null) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  if (typeof value === 'string') {
    const parsedTwitter = Number(parseTwitterDateTime(value) || 0);
    if (Number.isFinite(parsedTwitter) && parsedTwitter > 0) return parsedTwitter;
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return null;
}

export function resolveRecordRecency(record: unknown): number {
  if (!record || typeof record !== 'object') return 0;
  const candidatePaths = [
    'twe_private_fields.created_at',
    'created_at',
    'legacy.created_at',
    'core.created_at',
    'article.published_at',
    '__seen_at',
  ];

  for (const path of candidatePaths) {
    const value = getAccessorPathValue(record, path);
    const ts = asTimestamp(value);
    if (ts !== null && ts > 0) return ts;
  }

  return 0;
}
