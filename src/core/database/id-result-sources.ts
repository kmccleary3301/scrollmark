import {
  serializeResultSourceDescriptor,
  type ExplicitSelectionResultSourceDescriptor,
  type ResultEntityType,
  type ResultSource,
  type ResultSourceDescriptor,
  type ResultWindow,
  type ResultWindowRequest,
  type SearchResultSourceDescriptor,
} from './result-source';
import { recordResultSourceDiagnostics } from './result-source-diagnostics';

const DEFAULT_ID_SOURCE_PAGE_SIZE = 160;

export type IdResultCursor = {
  index: number;
  id: string;
};

type IdBackedSourceArgs<Row> = {
  descriptor: ResultSourceDescriptor;
  ids: string[];
  totalCount?: number;
  hydrateByIds: (ids: string[]) => Promise<Row[]>;
};

function makeCursor(ids: string[], index: number): IdResultCursor | undefined {
  const id = ids[index];
  if (index < 0 || !id) return undefined;
  return { index, id };
}

function resolveWindowStart(
  ids: string[],
  request: ResultWindowRequest<IdResultCursor>,
  limit: number,
): number {
  if (request.after) {
    const found = ids[request.after.index] === request.after.id ? request.after.index : -1;
    const fallback = ids.indexOf(request.after.id);
    return Math.max(0, (found >= 0 ? found : fallback) + 1);
  }
  if (request.before) {
    const found = ids[request.before.index] === request.before.id ? request.before.index : -1;
    const fallback = ids.indexOf(request.before.id);
    return Math.max(0, (found >= 0 ? found : fallback) - limit);
  }
  return Math.max(0, Math.floor(Number(request.startIndex) || 0));
}

function createIdBackedResultSource<Row>(
  args: IdBackedSourceArgs<Row>,
): ResultSource<Row, IdResultCursor> {
  const ids = [...args.ids];
  const key = serializeResultSourceDescriptor(args.descriptor);
  const total = args.totalCount ?? ids.length;

  const getWindow = async (
    request: ResultWindowRequest<IdResultCursor>,
  ): Promise<ResultWindow<Row, IdResultCursor>> => {
    const startedAt = performance.now();
    const limit = Math.max(1, Math.min(1000, Number(request.limit) || DEFAULT_ID_SOURCE_PAGE_SIZE));
    const startIndex = resolveWindowStart(ids, request, limit);
    const pageIds = ids.slice(startIndex, startIndex + limit);
    const rows = await args.hydrateByIds(pageIds);
    const window: ResultWindow<Row, IdResultCursor> = {
      source: args.descriptor,
      totalCount: total,
      startIndex,
      rows,
      rowIds: pageIds,
      hasBefore: startIndex > 0,
      hasAfter: startIndex + pageIds.length < total,
      cursorBefore: makeCursor(ids, startIndex),
      cursorAfter: makeCursor(ids, startIndex + pageIds.length - 1),
    };
    recordResultSourceDiagnostics({
      sourceKey: key,
      descriptor: args.descriptor,
      totalCount: total,
      cachedPages: 0,
      cachedRows: 0,
      lastFetchDurationMs: performance.now() - startedAt,
      lastWindowRows: rows.length,
      lastWindowStartIndex: startIndex,
      lastCacheHit: false,
    });
    return window;
  };

  return {
    key,
    descriptor: args.descriptor,
    totalCount: async () => total,
    getWindow,
    getByIds: args.hydrateByIds,
    streamRows: async function* streamRows(streamArgs = {}) {
      let startIndex = 0;
      if (streamArgs.cursor) {
        startIndex = Math.max(0, streamArgs.cursor.index + 1);
      }
      const batchSize = Math.max(
        1,
        Math.min(1000, Number(streamArgs.batchSize) || DEFAULT_ID_SOURCE_PAGE_SIZE),
      );
      while (startIndex < total && !streamArgs.signal?.aborted) {
        const page = await getWindow({ startIndex, limit: batchSize });
        for (const row of page.rows) {
          if (streamArgs.signal?.aborted) return;
          yield row;
        }
        if (!page.rowIds.length || !page.hasAfter) return;
        startIndex += page.rowIds.length;
      }
    },
  };
}

export function createExplicitSelectionResultSource<Row>(args: {
  extensionName?: string;
  entityType: ResultEntityType;
  ids: string[];
  source?: ResultSourceDescriptor;
  hydrateByIds: (ids: string[]) => Promise<Row[]>;
}): ResultSource<Row, IdResultCursor> {
  const descriptor: ExplicitSelectionResultSourceDescriptor = {
    schema: 'scrollmark.result_source.v1',
    kind: 'explicit-selection',
    extensionName: args.extensionName,
    entityType: args.entityType,
    ids: [...args.ids],
    source: args.source,
  };
  return createIdBackedResultSource({
    descriptor,
    ids: args.ids,
    hydrateByIds: args.hydrateByIds,
  });
}

export function createSearchResultSourceAdapter<Row>(args: {
  extensionName: string;
  entityType: ResultEntityType;
  query: string;
  ids: string[];
  totalCount?: number;
  folderIds?: string[];
  hydrateByIds: (ids: string[]) => Promise<Row[]>;
  searchEngine?: SearchResultSourceDescriptor['searchEngine'];
}): ResultSource<Row, IdResultCursor> {
  const descriptor: SearchResultSourceDescriptor = {
    schema: 'scrollmark.result_source.v1',
    kind: 'search',
    extensionName: args.extensionName,
    entityType: args.entityType,
    query: args.query,
    folderIds: args.folderIds,
    searchEngine: args.searchEngine ?? 'worker-corpus',
    sort: { kind: 'search_rank', direction: 'desc' },
  };
  return createIdBackedResultSource({
    descriptor,
    ids: args.ids,
    totalCount: args.totalCount,
    hydrateByIds: args.hydrateByIds,
  });
}
