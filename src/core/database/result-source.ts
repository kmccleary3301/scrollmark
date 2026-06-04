import type { ExtensionType } from '@/core/extensions/extension';

export type ResultEntityType = 'tweet' | 'user' | 'bundle_item';

export type ResultSortDescriptor =
  | { kind: 'observed_at'; direction: 'asc' | 'desc' }
  | { kind: 'created_at'; direction: 'asc' | 'desc' }
  | { kind: 'projected'; key: string; direction: 'asc' | 'desc' }
  | { kind: 'search_rank'; direction: 'desc' };

export type CaptureResultCursor = {
  createdAt: number;
  captureId: string;
};

export type SearchDocumentResultCursor = {
  observedAtMs: number;
  documentId: string;
};

export type CaptureResultSourceDescriptor = {
  schema: 'scrollmark.result_source.v1';
  kind: 'captures';
  extensionName: string;
  extensionType: ExtensionType;
  sort: ResultSortDescriptor;
};

export type FolderResultSourceDescriptor = {
  schema: 'scrollmark.result_source.v1';
  kind: 'folder';
  extensionName: string;
  entityType: ResultEntityType;
  folderIds: string[];
  sort: ResultSortDescriptor;
};

export type SearchResultSourceDescriptor = {
  schema: 'scrollmark.result_source.v1';
  kind: 'search';
  extensionName: string;
  entityType: ResultEntityType;
  query: string;
  folderIds?: string[];
  searchEngine: 'worker-corpus' | 'indexed-db-inverted-index';
  sort: ResultSortDescriptor;
};

export type MediaResultSourceDescriptor = {
  schema: 'scrollmark.result_source.v1';
  kind: 'media';
  extensionName: string;
  entityType: 'tweet';
  folderIds?: string[];
  sort: ResultSortDescriptor;
};

export type ExplicitSelectionResultSourceDescriptor = {
  schema: 'scrollmark.result_source.v1';
  kind: 'explicit-selection';
  extensionName?: string;
  entityType: ResultEntityType;
  ids: string[];
  source?: ResultSourceDescriptor;
};

export type BundleResultSourceDescriptor = {
  schema: 'scrollmark.result_source.v1';
  kind: 'bundle';
  bundleId: string;
  entityType?: ResultEntityType;
  sort: ResultSortDescriptor;
};

export type ResultSourceDescriptor =
  | CaptureResultSourceDescriptor
  | FolderResultSourceDescriptor
  | SearchResultSourceDescriptor
  | MediaResultSourceDescriptor
  | ExplicitSelectionResultSourceDescriptor
  | BundleResultSourceDescriptor;

export type ResultWindowRequest<Cursor = unknown> = {
  startIndex?: number;
  limit: number;
  after?: Cursor;
  before?: Cursor;
  direction?: 'forward' | 'backward';
};

export type ResultWindow<Row, Cursor = unknown> = {
  source: ResultSourceDescriptor;
  totalCount: number;
  startIndex?: number;
  rows: Row[];
  rowIds: string[];
  hasBefore: boolean;
  hasAfter: boolean;
  cursorBefore?: Cursor;
  cursorAfter?: Cursor;
};

export type StreamRowsArgs<Cursor = unknown> = {
  signal?: AbortSignal;
  batchSize?: number;
  cursor?: Cursor;
};

export type ResultSource<Row, Cursor = unknown> = {
  key: string;
  descriptor: ResultSourceDescriptor;
  totalCount: () => Promise<number>;
  getWindow: (request: ResultWindowRequest<Cursor>) => Promise<ResultWindow<Row, Cursor>>;
  getByIds: (ids: string[]) => Promise<Row[]>;
  streamRows: (args?: StreamRowsArgs<Cursor>) => AsyncIterable<Row>;
};

export function createCaptureResultSourceDescriptor(args: {
  extensionName: string;
  extensionType: ExtensionType;
  direction?: 'asc' | 'desc';
}): CaptureResultSourceDescriptor {
  return {
    schema: 'scrollmark.result_source.v1',
    kind: 'captures',
    extensionName: args.extensionName,
    extensionType: args.extensionType,
    sort: { kind: 'observed_at', direction: args.direction ?? 'desc' },
  };
}

export function createFolderResultSourceDescriptor(args: {
  extensionName: string;
  entityType: ResultEntityType;
  folderIds: string[];
  direction?: 'asc' | 'desc';
}): FolderResultSourceDescriptor {
  return {
    schema: 'scrollmark.result_source.v1',
    kind: 'folder',
    extensionName: args.extensionName,
    entityType: args.entityType,
    folderIds: [...args.folderIds],
    sort: { kind: 'observed_at', direction: args.direction ?? 'desc' },
  };
}

export function createMediaResultSourceDescriptor(args: {
  extensionName: string;
  folderIds?: string[];
  direction?: 'asc' | 'desc';
}): MediaResultSourceDescriptor {
  return {
    schema: 'scrollmark.result_source.v1',
    kind: 'media',
    extensionName: args.extensionName,
    entityType: 'tweet',
    folderIds: args.folderIds?.length ? [...args.folderIds] : undefined,
    sort: { kind: 'observed_at', direction: args.direction ?? 'desc' },
  };
}

export function serializeResultSourceDescriptor(descriptor: ResultSourceDescriptor): string {
  return JSON.stringify(descriptor);
}
