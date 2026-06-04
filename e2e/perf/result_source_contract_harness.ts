import fs from 'node:fs';
import path from 'node:path';
import {
  clearResultSourceDiagnostics,
  readResultSourceDiagnostics,
} from '@/core/database/result-source-diagnostics';
import {
  createExplicitSelectionResultSource,
  createSearchResultSourceAdapter,
} from '@/core/database/id-result-sources';

const [, , outPathArg = 'e2e/perf/out/result-source-contract.json'] = process.argv;
const outPath = path.resolve(outPathArg);

type Row = {
  id: string;
  value: number;
};

const rows = Array.from({ length: 20 }, (_, index) => ({
  id: `row-${String(index).padStart(2, '0')}`,
  value: index,
}));
const rowsById = new Map(rows.map((row) => [row.id, row]));
const hydrateCalls: string[][] = [];
const hydrateByIds = async (ids: string[]) => {
  hydrateCalls.push([...ids]);
  return ids.map((id) => rowsById.get(id)).filter((row): row is Row => Boolean(row));
};

clearResultSourceDiagnostics();

const explicitIds = rows.slice(3, 11).map((row) => row.id);
const explicitSource = createExplicitSelectionResultSource<Row>({
  extensionName: 'BookmarksModule',
  entityType: 'tweet',
  ids: explicitIds,
  hydrateByIds,
});
const explicitFirst = await explicitSource.getWindow({ startIndex: 0, limit: 3 });
const explicitSecond = await explicitSource.getWindow({
  limit: 3,
  after: explicitFirst.cursorAfter,
});
const explicitStreamed: Row[] = [];
for await (const row of explicitSource.streamRows({ batchSize: 4 })) {
  explicitStreamed.push(row);
}

const searchIds = rows
  .filter((row) => row.value % 2 === 0)
  .map((row) => row.id)
  .reverse();
const searchSource = createSearchResultSourceAdapter<Row>({
  extensionName: 'BookmarksModule',
  entityType: 'tweet',
  query: 'even rows',
  ids: searchIds,
  totalCount: searchIds.length,
  folderIds: ['folder-a'],
  hydrateByIds,
});
const searchMiddle = await searchSource.getWindow({ startIndex: 2, limit: 4 });
const searchBack = await searchSource.getWindow({
  limit: 2,
  before: searchMiddle.cursorBefore,
});

const abortController = new AbortController();
const abortedRows: Row[] = [];
for await (const row of searchSource.streamRows({ batchSize: 2, signal: abortController.signal })) {
  abortedRows.push(row);
  if (abortedRows.length === 3) {
    abortController.abort();
  }
}

const diagnostics = readResultSourceDiagnostics();

const checks = [
  {
    name: 'explicit source descriptor is serializable and selection-scoped',
    ok:
      explicitSource.descriptor.kind === 'explicit-selection' &&
      JSON.stringify(explicitSource.descriptor).includes('BookmarksModule') &&
      explicitSource.descriptor.ids.length === explicitIds.length,
    details: explicitSource.descriptor,
  },
  {
    name: 'explicit source hydrates only requested first window IDs',
    ok:
      explicitFirst.rowIds.join(',') === explicitIds.slice(0, 3).join(',') &&
      explicitFirst.rows.map((row) => row.id).join(',') === explicitIds.slice(0, 3).join(','),
    details: { rowIds: explicitFirst.rowIds, rows: explicitFirst.rows.map((row) => row.id) },
  },
  {
    name: 'explicit source cursor continues in stable order',
    ok: explicitSecond.rowIds.join(',') === explicitIds.slice(3, 6).join(','),
    details: { rowIds: explicitSecond.rowIds },
  },
  {
    name: 'explicit source stream yields all selected IDs in order',
    ok: explicitStreamed.map((row) => row.id).join(',') === explicitIds.join(','),
    details: { streamed: explicitStreamed.map((row) => row.id) },
  },
  {
    name: 'search adapter descriptor records query, folder, and worker engine',
    ok:
      searchSource.descriptor.kind === 'search' &&
      searchSource.descriptor.query === 'even rows' &&
      searchSource.descriptor.searchEngine === 'worker-corpus' &&
      searchSource.descriptor.folderIds?.[0] === 'folder-a',
    details: searchSource.descriptor,
  },
  {
    name: 'search adapter windows preserve ranked ID order',
    ok: searchMiddle.rowIds.join(',') === searchIds.slice(2, 6).join(','),
    details: { rowIds: searchMiddle.rowIds },
  },
  {
    name: 'search adapter before-cursor paging moves backward',
    ok: searchBack.rowIds.join(',') === searchIds.slice(0, 2).join(','),
    details: { rowIds: searchBack.rowIds },
  },
  {
    name: 'streaming respects abort signal between yielded rows',
    ok: abortedRows.length === 3,
    details: { abortedRows: abortedRows.map((row) => row.id) },
  },
  {
    name: 'hydration calls are bounded to requested page sizes',
    ok: hydrateCalls.every((ids) => ids.length <= 4),
    details: { hydrateCalls },
  },
  {
    name: 'source diagnostics records explicit/search source fetches',
    ok:
      diagnostics.some((entry) => entry.mode === 'explicit-selection') &&
      diagnostics.some((entry) => entry.mode === 'search') &&
      diagnostics.every((entry) => entry.cachedRows === 0),
    details: diagnostics,
  },
];

const payload = {
  ok: checks.every((check) => check.ok),
  checks,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
