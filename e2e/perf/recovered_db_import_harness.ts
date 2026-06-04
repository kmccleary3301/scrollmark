import fs from 'node:fs';
import path from 'node:path';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

const DEFAULT_EXPORT_PATH =
  '/home/skra/projects/twitter_scraping/misc/round_019/twitter-web-exporter-1779916291277.json';
const [, , outPathArg = 'e2e/perf/out/recovered-db-import.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const exportPath = path.resolve(process.env.SCROLLMARK_RECOVERED_DB_EXPORT || DEFAULT_EXPORT_PATH);
const LARGE_EXPORT_BYTES = 100 * 1024 * 1024;
const LARGE_EXPORT_FOLDER_SCAN_LIMIT = 5000;

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

class BlobFileReader {
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;
  onabort: ((event: { target: BlobFileReader }) => void) | null = null;
  onerror: ((event: { target: BlobFileReader }) => void) | null = null;
  onload: ((event: { target: BlobFileReader }) => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob
      .arrayBuffer()
      .then((result) => {
        this.result = result;
        this.onload?.({ target: this });
      })
      .catch((error) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onerror?.({ target: this });
      });
  }

  readAsText(blob: Blob): void {
    void blob
      .text()
      .then((result) => {
        this.result = result;
        this.onload?.({ target: this });
      })
      .catch((error) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onerror?.({ target: this });
      });
  }
}

const localStorage = new MemoryStorage();
const windowMock = {
  localStorage,
  setTimeout,
  clearTimeout,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  __META_DATA__: { userId: 'recovered-db-import-harness' },
};

Object.assign(globalThis, {
  indexedDB,
  IDBKeyRange,
  FileReader: BlobFileReader,
  localStorage,
  self: globalThis,
  window: windowMock,
  unsafeWindow: windowMock,
});

const { ExtensionType } = await import('@/core/extensions/extension');
const { getDatabaseManager } = await import('@/core/database');
const { createFolderResultSource, createLiveCapturesResultSource } =
  await import('@/core/database/result-sources');
const { serializeResultSourceDescriptor } = await import('@/core/database/result-source');
const { readResultSourceDiagnostics } = await import('@/core/database/result-source-diagnostics');

function readExportHeader(filePath: string) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, length).toString('utf8');
    const databaseVersion = Number(head.match(/"databaseVersion":(\d+)/)?.[1] || 0);
    const rowCounts = new Map<string, number>();
    for (const match of head.matchAll(/"name":"([^"]+)","schema":"[^"]*","rowCount":(\d+)/g)) {
      rowCounts.set(match[1]!, Number(match[2] || 0));
    }
    return {
      databaseVersion,
      rowCounts: Object.fromEntries(rowCounts),
    };
  } finally {
    fs.closeSync(fd);
  }
}

async function poll<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T | null> {
  let last: T | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
    if (accept(last)) return last;
  }
  return last;
}

const startedAt = performance.now();
const exportStats = fs.statSync(exportPath);
const boundedLargeExportProbe =
  process.env.SCROLLMARK_RECOVERED_DB_BOUNDED_LARGE_PROBE === '1' ||
  exportStats.size >= LARGE_EXPORT_BYTES;
const exportHeader = readExportHeader(exportPath);
const expectedTweets = Number(exportHeader.rowCounts.tweets || 0);
const expectedCaptures = Number(exportHeader.rowCounts.captures || 0);
const expectedSearchDocuments = Number(exportHeader.rowCounts.search_documents || 0);
const expectedTotalRows = Object.values(exportHeader.rowCounts).reduce(
  (sum, value) => sum + Number(value || 0),
  0,
);
const manager = getDatabaseManager();
await manager.whenReady();
await manager.clear();

function logPhase(phase: string): void {
  console.log(
    `[recovered-db-import] phase=${phase} elapsedMs=${Math.round(performance.now() - startedAt)}`,
  );
}

const importStartedAt = performance.now();
const exportBlob = new Blob([fs.readFileSync(exportPath)], { type: 'application/json' });
let lastImportProgressLog = 0;
let lastImportProgress = {
  completedRows: 0,
  totalRows: 0,
  completedTables: 0,
  totalTables: 0,
  done: false,
};
const importResult = await manager.import(exportBlob, {
  progressCallback: (progress) => {
    lastImportProgress = {
      completedRows: Number(progress.completedRows || 0),
      totalRows: Number(progress.totalRows || 0),
      completedTables: Number(progress.completedTables || 0),
      totalTables: Number(progress.totalTables || 0),
      done: Boolean(progress.done),
    };
    if (
      progress.done ||
      progress.completedRows - lastImportProgressLog >= 2500 ||
      lastImportProgressLog === 0
    ) {
      lastImportProgressLog = progress.completedRows;
      console.log(
        `[recovered-db-import] rows=${progress.completedRows}/${progress.totalRows ?? '?'} tables=${progress.completedTables}/${progress.totalTables} elapsedMs=${Math.round(
          performance.now() - importStartedAt,
        )}`,
      );
    }
    return true;
  },
});
const importDurationMs = performance.now() - importStartedAt;

logPhase('counts');
const counts = boundedLargeExportProbe
  ? {
      tweets: expectedTweets,
      captures: expectedCaptures,
      search_documents: expectedSearchDocuments,
      folder_source_index_pages: -1,
    }
  : await manager.count();
logPhase('counts:table-counts-ready');
const dbRows = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
logPhase('counts:indexeddb-databases-ready');
const activeDb = dbRows.find((row) => row.name === 'twitter-web-exporter');
const bookmarkCaptureCount = await manager.extGetCaptureCount(
  'BookmarksModule',
  ExtensionType.TWEET,
);
logPhase('counts:bookmark-captures-ready');
const bookmarkSearchDocumentCount = boundedLargeExportProbe
  ? expectedSearchDocuments
  : await manager.extGetSearchDocumentCount('BookmarksModule', {
      entityType: 'tweet',
    });
logPhase('counts:bookmark-search-documents-ready');
logPhase('folder-scope');
const facets = boundedLargeExportProbe
  ? null
  : await manager.extGetSearchDocumentFolderFacets('BookmarksModule', {
      entityType: 'tweet',
    });
const boundedFolderIds = new Set<string>();
if (boundedLargeExportProbe) {
  for (
    let offset = 0;
    offset < Math.min(bookmarkSearchDocumentCount, LARGE_EXPORT_FOLDER_SCAN_LIMIT) &&
    boundedFolderIds.size < 6;
  ) {
    const page = await manager.extGetSearchDocumentPage('BookmarksModule', {
      entityType: 'tweet',
      offset,
      limit: 1000,
    });
    for (const document of page.documents) {
      const folderId = String(document.folder_id || '').trim();
      if (folderId) boundedFolderIds.add(folderId);
      if (boundedFolderIds.size >= 6) break;
    }
    if (!page.documents.length || !page.hasAfter) break;
    offset += page.documents.length;
  }
}
const selectedFacets = boundedLargeExportProbe
  ? await Promise.all(
      [...boundedFolderIds].map(async (folderId) => ({
        folderId,
        label: `Folder ${folderId}`,
        count: await manager.extGetSearchDocumentCount('BookmarksModule', {
          entityType: 'tweet',
          folderId,
        }),
        status: 'id-only' as const,
      })),
    )
  : (facets?.facets ?? [])
      .filter((facet) => facet.count > 0)
      .slice()
      .sort((left, right) => right.count - left.count);
const folderScope = boundedLargeExportProbe
  ? selectedFacets
      .filter((facet) => facet.count >= 16)
      .sort((left, right) => right.count - left.count)
      .slice(0, 1)
  : selectedFacets.slice(0, 6);
const folderIds = folderScope.map((facet) => facet.folderId);
const folderScopeCount = folderScope.reduce((sum, facet) => sum + facet.count, 0);

logPhase('capture-source');
const captureSource = createLiveCapturesResultSource({
  extensionName: 'BookmarksModule',
  extensionType: ExtensionType.TWEET,
  cachePages: 2,
});
const captureWindow = await captureSource.getWindow({ startIndex: 0, limit: 8 });
const captureIndexBuild = await manager.extBuildCaptureIndexPages('BookmarksModule', {
  type: ExtensionType.TWEET,
  sourceCount: bookmarkCaptureCount,
});
const captureIndexOffset = Math.max(0, Math.min(512, bookmarkCaptureCount - 8));
const captureIndexedIds = await manager.extGetCaptureIdsIndexedPage('BookmarksModule', {
  type: ExtensionType.TWEET,
  sourceCount: bookmarkCaptureCount,
  offset: captureIndexOffset,
  limit: 8,
});
const captureFallbackIds = await manager.extGetCaptureIdsPage('BookmarksModule', {
  type: ExtensionType.TWEET,
  offset: captureIndexOffset,
  limit: 8,
});

let folderWindow: Awaited<ReturnType<typeof createFolderResultSource>['getWindow']> | null = null;
let folderIndexedProbe: Awaited<ReturnType<typeof manager.extGetFolderSourceIndexedPage>> = null;
let folderIndexedWindow: typeof folderWindow = null;
let folderOffset = 0;
let boundedFolderPage: Awaited<ReturnType<typeof manager.extGetSearchDocumentFolderPage>> | null =
  null;
let boundedFolderHydratedRows = 0;

if (folderIds.length && folderScopeCount >= 16) {
  const folderSource = createFolderResultSource({
    extensionName: 'BookmarksModule',
    entityType: 'tweet',
    folderIds,
    knownTotalCount: folderScopeCount,
    cachePages: 2,
  });
  folderOffset = Math.max(0, Math.min(512, folderScopeCount - 8));
  if (boundedLargeExportProbe) {
    const pageStart = Math.floor(folderOffset / 256) * 256;
    boundedFolderPage = await manager.extGetSearchDocumentFolderPage('BookmarksModule', {
      entityType: 'tweet',
      folderId: folderIds[0] || '',
      offset: pageStart,
      limit: Math.min(256, folderScopeCount - pageStart),
    });
    const rowIds = boundedFolderPage.documents
      .map((document) => document.raw_ref_key || document.entity_id)
      .filter(Boolean);
    boundedFolderHydratedRows = (
      await manager.extGetTweetsByIds(
        rowIds.slice(folderOffset - pageStart, folderOffset - pageStart + 8),
      )
    ).length;
    await manager.extPutFolderSourceIndexPages({
      sourceKey: serializeResultSourceDescriptor(folderSource.descriptor),
      extensionName: 'BookmarksModule',
      entityType: 'tweet',
      folderIds,
      sourceCount: folderScopeCount,
      sourceRevision: manager.readFolderSourceIndexRevision('BookmarksModule'),
      pages: [
        {
          pageStart,
          rowIds,
          cursorAfter: boundedFolderPage.cursorAfter,
        },
      ],
    });
    folderIndexedProbe = await manager.extGetFolderSourceIndexedPage({
      sourceKey: serializeResultSourceDescriptor(folderSource.descriptor),
      extensionName: 'BookmarksModule',
      entityType: 'tweet',
      folderIds,
      sourceCount: folderScopeCount,
      offset: folderOffset,
      limit: 8,
    });
  } else if (folderScopeCount < 1000) {
    folderWindow = await folderSource.getWindow({ startIndex: 0, limit: 8 });
    const pageStart = Math.floor(folderOffset / 256) * 256;
    const pageWindow = await folderSource.getWindow({
      startIndex: pageStart,
      limit: Math.min(256, folderScopeCount - pageStart),
    });
    await manager.extPutFolderSourceIndexPages({
      sourceKey: serializeResultSourceDescriptor(folderSource.descriptor),
      extensionName: 'BookmarksModule',
      entityType: 'tweet',
      folderIds,
      sourceCount: folderScopeCount,
      sourceRevision: manager.readFolderSourceIndexRevision('BookmarksModule'),
      pages: [
        {
          pageStart,
          rowIds: pageWindow.rowIds,
          cursorAfter: pageWindow.cursorAfter,
        },
      ],
    });
    folderIndexedProbe = await manager.extGetFolderSourceIndexedPage({
      sourceKey: serializeResultSourceDescriptor(folderSource.descriptor),
      extensionName: 'BookmarksModule',
      entityType: 'tweet',
      folderIds,
      sourceCount: folderScopeCount,
      offset: folderOffset,
      limit: 8,
    });
    folderIndexedWindow = await folderSource.getWindow({ startIndex: folderOffset, limit: 8 });
  } else {
    folderWindow = await folderSource.getWindow({ startIndex: 0, limit: 8 });
    folderIndexedProbe = await poll(
      () =>
        manager.extGetFolderSourceIndexedPage({
          sourceKey: serializeResultSourceDescriptor(folderSource.descriptor),
          extensionName: 'BookmarksModule',
          entityType: 'tweet',
          folderIds,
          sourceCount: folderScopeCount,
          offset: folderOffset,
          limit: 8,
        }),
      (value) => Boolean(value?.rowIds.length),
    );
    folderIndexedWindow = await folderSource.getWindow({ startIndex: folderOffset, limit: 8 });
  }
}

logPhase('diagnostics');
const diagnostics = readResultSourceDiagnostics();
const checks = [
  {
    name: boundedLargeExportProbe
      ? 'large recovered v6 export imports with bounded post-import probes'
      : 'recovered v6 export imports into the current fake IndexedDB schema',
    ok:
      exportHeader.databaseVersion === 6 &&
      activeDb?.version === 100 &&
      (boundedLargeExportProbe
        ? lastImportProgress.done === true &&
          lastImportProgress.completedRows === expectedTotalRows &&
          expectedTweets > 0 &&
          expectedCaptures > 0 &&
          expectedSearchDocuments > 0 &&
          bookmarkCaptureCount > 0 &&
          bookmarkSearchDocumentCount > 0
        : counts.tweets === expectedTweets &&
          counts.captures === expectedCaptures &&
          counts.search_documents === expectedSearchDocuments &&
          typeof counts.folder_source_index_pages === 'number'),
    details: {
      exportHeader,
      activeDb,
      counts,
      importResult,
      lastImportProgress,
      boundedLargeExportProbe,
    },
  },
  {
    name: 'recovered BookmarksModule capture source hydrates bounded windows',
    ok:
      bookmarkCaptureCount >= 8 &&
      captureWindow.rows.length === 8 &&
      captureWindow.rowIds.length === 8 &&
      captureWindow.totalCount === bookmarkCaptureCount,
    details: {
      bookmarkCaptureCount,
      captureWindow: {
        totalCount: captureWindow.totalCount,
        rowIds: captureWindow.rowIds,
        rows: captureWindow.rows.length,
      },
    },
  },
  {
    name: 'recovered capture index pages build and serve random windows',
    ok:
      captureIndexBuild === true &&
      captureIndexedIds?.length === 8 &&
      captureIndexedIds.join(',') === captureFallbackIds.join(','),
    details: { captureIndexBuild, captureIndexOffset, captureIndexedIds, captureFallbackIds },
  },
  {
    name: 'recovered bookmark folder facets expose a usable source scope',
    ok:
      bookmarkSearchDocumentCount >= 8 &&
      folderIds.length > 0 &&
      folderScopeCount >= Math.min(16, bookmarkSearchDocumentCount),
    details: {
      bookmarkSearchDocumentCount,
      totalFolderDocuments: facets?.totalDocuments,
      boundedLargeExportProbe,
      selectedFacets: folderScope,
      folderScopeCount,
    },
  },
  {
    name: boundedLargeExportProbe
      ? 'large recovered folder scope serves a bounded persisted index page'
      : 'recovered folder source serves persisted index pages',
    ok:
      folderIndexedProbe?.rowIds.length === 8 &&
      (boundedLargeExportProbe
        ? boundedFolderPage?.documents.length === 256 && boundedFolderHydratedRows > 0
        : folderWindow?.rowIds.length === 8 &&
          folderIndexedWindow?.rowIds.length === 8 &&
          folderIndexedWindow.rowIds.join(',') === folderIndexedProbe.rowIds.join(',')),
    details: {
      boundedLargeExportProbe,
      folderIds,
      folderScopeCount,
      folderOffset,
      boundedFolderPage: boundedFolderPage
        ? {
            documents: boundedFolderPage.documents.length,
            cursorAfter: boundedFolderPage.cursorAfter,
          }
        : null,
      boundedFolderHydratedRows,
      folderWindow: folderWindow
        ? { totalCount: folderWindow.totalCount, rowIds: folderWindow.rowIds }
        : null,
      folderIndexedProbe,
      folderIndexedWindow: folderIndexedWindow
        ? { startIndex: folderIndexedWindow.startIndex, rowIds: folderIndexedWindow.rowIds }
        : null,
    },
  },
];

const payload = {
  ok: checks.every((check) => check.ok),
  generatedAt: new Date().toISOString(),
  exportPath,
  exportBytes: exportStats.size,
  importDurationMs,
  totalDurationMs: performance.now() - startedAt,
  checks,
  diagnostics,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
