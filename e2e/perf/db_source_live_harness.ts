import fs from 'node:fs';
import path from 'node:path';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

const [, , outPathArg = 'e2e/perf/out/db-source-live.json'] = process.argv;
const outPath = path.resolve(outPathArg);

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

const localStorage = new MemoryStorage();
const windowMock = {
  localStorage,
  setTimeout,
  clearTimeout,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  __META_DATA__: { userId: 'db-source-live-harness' },
};

Object.assign(globalThis, {
  indexedDB,
  IDBKeyRange,
  localStorage,
  self: globalThis,
  window: windowMock,
  unsafeWindow: windowMock,
});

const { ExtensionType } = await import('@/core/extensions/extension');
const { getDatabaseManager } = await import('@/core/database');
const { clearResultSourceDiagnostics, readResultSourceDiagnostics } =
  await import('@/core/database/result-source-diagnostics');
const { createFolderResultSource, createLiveCapturesResultSource, createMediaResultSource } =
  await import('@/core/database/result-sources');
const { serializeResultSourceDescriptor } = await import('@/core/database/result-source');

type TweetRecord = {
  __typename: 'Tweet';
  rest_id: string;
  legacy: {
    id_str: string;
    created_at: string;
    full_text: string;
    favorite_count: number;
    retweet_count: number;
    reply_count: number;
    bookmark_count: number;
    lang: string;
    entities?: {
      media?: Array<{
        id_str: string;
        media_key: string;
        type: string;
        media_url_https: string;
        indices: [number, number];
      }>;
    };
  };
  core: {
    user_results: {
      result: {
        rest_id: string;
        core: {
          screen_name: string;
        };
      };
    };
  };
  __bookmark_folder_id?: string;
  __bookmark_folder_name?: string;
  __bookmark_folder_name_source?: string;
};

function makeTweet(index: number): TweetRecord {
  const id = `tweet-${String(index).padStart(4, '0')}`;
  const folderId =
    index < 70 ? 'folder-alpha' : index < 100 ? 'folder-beta' : index < 110 ? 'folder-gamma' : '';
  const folderName =
    folderId === 'folder-alpha'
      ? 'Alpha Folder'
      : folderId === 'folder-gamma' && index >= 105
        ? 'Gamma Folder'
        : '';
  const tweet: TweetRecord = {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      created_at: 'Thu Sep 28 11:07:25 +0000 2023',
      full_text: `Synthetic bookmark ${index} ${folderName || folderId || 'unfiled'}`,
      favorite_count: index,
      retweet_count: index % 7,
      reply_count: index % 5,
      bookmark_count: index % 11,
      lang: 'en',
      entities:
        index % 11 === 0
          ? {
              media: [
                {
                  id_str: `media-${id}`,
                  media_key: `3_${id}`,
                  type: 'photo',
                  media_url_https: `https://example.invalid/${id}.jpg`,
                  indices: [0, 10],
                },
              ],
            }
          : undefined,
    },
    core: {
      user_results: {
        result: {
          rest_id: `user-${index % 9}`,
          core: {
            screen_name: `author_${index % 9}`,
          },
        },
      },
    },
  };

  if (folderId) {
    tweet.__bookmark_folder_id = folderId;
    tweet.__bookmark_folder_name_source = folderName ? 'api' : 'id-only';
  }
  if (folderName) {
    tweet.__bookmark_folder_name = folderName;
  }
  return tweet;
}

function makeFolderIndexTweet(index: number): TweetRecord {
  const id = `folder-index-tweet-${String(index).padStart(5, '0')}`;
  const folderId = index % 2 === 0 ? 'folder-index-a' : 'folder-index-b';
  const folderName = index % 2 === 0 ? 'Folder Index A' : 'Folder Index B';
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      created_at: 'Thu Sep 28 11:07:25 +0000 2023',
      full_text: `Large folder index synthetic bookmark ${index}`,
      favorite_count: index,
      retweet_count: index % 7,
      reply_count: index % 5,
      bookmark_count: index % 11,
      lang: 'en',
    },
    core: {
      user_results: {
        result: {
          rest_id: `folder-index-user-${index % 17}`,
          core: {
            screen_name: `folder_index_author_${index % 17}`,
          },
        },
      },
    },
    __bookmark_folder_id: folderId,
    __bookmark_folder_name: folderName,
    __bookmark_folder_name_source: 'api',
  };
}

function makeFolderIndexSearchDocument(extensionName: string, tweet: TweetRecord, index: number) {
  const observedAt = 20_000_000 - index;
  return {
    id: `live:${extensionName}:tweet:${tweet.rest_id}`,
    source_key: `live:${extensionName}:tweet`,
    source_kind: 'live',
    entity_type: 'tweet',
    entity_id: tweet.rest_id,
    extension_name: extensionName,
    updated_at_ms: observedAt,
    created_at_ms: observedAt,
    observed_at_ms: observedAt,
    primary_text: tweet.legacy.full_text,
    author_screen_name: tweet.core.user_results.result.core.screen_name,
    author_id: tweet.core.user_results.result.rest_id,
    folder_id: tweet.__bookmark_folder_id,
    folder_name: tweet.__bookmark_folder_name,
    exact_json: {
      folder: [tweet.__bookmark_folder_id, tweet.__bookmark_folder_name].filter(Boolean),
    },
    raw_ref_table: 'tweets',
    raw_ref_key: tweet.rest_id,
    doc_hash: `folder-index-${index}`,
  };
}

function makeLegacyMediaTweet(id: string, index: number): TweetRecord {
  const tweet = makeTweet(index);
  tweet.rest_id = id;
  tweet.legacy.id_str = id;
  tweet.legacy.full_text = `Legacy media bookmark ${id}`;
  tweet.legacy.entities = {
    media: [
      {
        id_str: `legacy-media-${id}`,
        media_key: `3_legacy_${id}`,
        type: 'photo',
        media_url_https: `https://example.invalid/legacy/${id}.jpg`,
        indices: [0, 10],
      },
    ],
  };
  return tweet;
}

function makeLegacyMediaSearchDocument(extensionName: string, tweet: TweetRecord, index: number) {
  const observedAt = 30_000_000 - index;
  return {
    id: `live:${extensionName}:tweet:${tweet.rest_id}`,
    source_key: `live:${extensionName}:tweet`,
    source_kind: 'live',
    entity_type: 'tweet',
    entity_id: tweet.rest_id,
    extension_name: extensionName,
    updated_at_ms: observedAt,
    created_at_ms: observedAt,
    observed_at_ms: observedAt,
    primary_text: tweet.legacy.full_text,
    author_screen_name: tweet.core.user_results.result.core.screen_name,
    author_id: tweet.core.user_results.result.rest_id,
    flags_json: { has_media: true },
    exact_json: {},
    numeric_json: {},
    raw_ref_table: 'tweets',
    raw_ref_key: tweet.rest_id,
    doc_hash: `legacy-media-${index}`,
  };
}

function ids(rows: Array<{ rest_id?: string }>): string[] {
  return rows.map((row) => String(row.rest_id || ''));
}

function isNewestFirst(rows: Array<{ observed_at_ms?: number; id: string }>): boolean {
  return rows.every((row, index) => {
    const previous = rows[index - 1];
    if (!previous) return true;
    const previousObserved = Number(previous.observed_at_ms || 0);
    const observed = Number(row.observed_at_ms || 0);
    if (previousObserved !== observed) return previousObserved >= observed;
    return previous.id >= row.id;
  });
}

const manager = getDatabaseManager();
await manager.whenReady();
await manager.clear();

const extensionName = 'BookmarksModule';
const tweets = Array.from({ length: 120 }, (_, index) => makeTweet(index));
await manager.extAddTweets(extensionName, tweets as never);

clearResultSourceDiagnostics();

const counts = await manager.count();
const captureCount = await manager.extGetCaptureCount(extensionName, ExtensionType.TWEET);
const searchDocumentCount = await manager.extGetSearchDocumentCount(extensionName, {
  type: ExtensionType.TWEET,
});
const folderAlphaCount = await manager.extGetSearchDocumentCount(extensionName, {
  type: ExtensionType.TWEET,
  folderId: 'folder-alpha',
});
const folderBetaCount = await manager.extGetSearchDocumentCount(extensionName, {
  type: ExtensionType.TWEET,
  folderId: 'folder-beta',
});

const captureFirst = await manager.extGetCaptureIdsCursorPage(extensionName, {
  type: ExtensionType.TWEET,
  limit: 25,
});
const captureSecond = await manager.extGetCaptureIdsCursorPage(extensionName, {
  type: ExtensionType.TWEET,
  after: captureFirst.cursorAfter,
  limit: 25,
});
const offsetCaptureIds = await manager.extGetCaptureIdsPage(extensionName, {
  type: ExtensionType.TWEET,
  offset: 40,
  limit: 10,
});
const captureIndexBuild = await manager.extBuildCaptureIndexPages(extensionName, {
  type: ExtensionType.TWEET,
  sourceCount: captureCount,
});
const indexedCaptureIds = await manager.extGetCaptureIdsIndexedPage(extensionName, {
  type: ExtensionType.TWEET,
  sourceCount: captureCount,
  offset: 40,
  limit: 10,
});

const facets = await manager.extGetSearchDocumentFolderFacets(extensionName, {
  type: ExtensionType.TWEET,
});
const folderAlphaFacet = facets.facets.find((facet) => facet.folderId === 'folder-alpha');
const folderBetaFacet = facets.facets.find((facet) => facet.folderId === 'folder-beta');
const folderGammaFacet = facets.facets.find((facet) => facet.folderId === 'folder-gamma');
const betaBackfill = await manager.extBackfillRecentBookmarkFolderName(
  extensionName,
  'folder-beta',
  'Beta Folder',
  {
    candidateLimit: 30,
    candidateTweetIds: tweets
      .filter((tweet) => tweet.__bookmark_folder_id === 'folder-beta')
      .map((tweet) => tweet.rest_id),
  },
);
const betaBackfilledTweet = (await manager.extGetTweetsByIds(['tweet-0099']))?.[0] as
  | TweetRecord
  | undefined;
const betaBackfilledPage = await manager.extGetSearchDocumentFolderCursorPage(extensionName, {
  type: ExtensionType.TWEET,
  folderId: 'folder-beta',
  limit: 1,
});
const backfilledFacets = await manager.extGetSearchDocumentFolderFacets(extensionName, {
  type: ExtensionType.TWEET,
});
const backfilledBetaFacet = backfilledFacets.facets.find(
  (facet) => facet.folderId === 'folder-beta',
);

const folderFirst = await manager.extGetSearchDocumentFolderCursorPage(extensionName, {
  type: ExtensionType.TWEET,
  folderId: 'folder-alpha',
  limit: 20,
});
const folderSecond = await manager.extGetSearchDocumentFolderCursorPage(extensionName, {
  type: ExtensionType.TWEET,
  folderId: 'folder-alpha',
  after: folderFirst.cursorAfter,
  limit: 20,
});
const folderOffset = await manager.extGetSearchDocumentFolderPage(extensionName, {
  type: ExtensionType.TWEET,
  folderId: 'folder-alpha',
  offset: 40,
  limit: 10,
});
const mediaDocumentCount = await manager.extGetSearchDocumentMediaCount(extensionName, {
  entityType: 'tweet',
});
const mediaDocumentFirst = await manager.extGetSearchDocumentMediaCursorPage(extensionName, {
  entityType: 'tweet',
  limit: 5,
});
const mediaDocumentSecond = await manager.extGetSearchDocumentMediaCursorPage(extensionName, {
  entityType: 'tweet',
  after: mediaDocumentFirst.cursorAfter,
  limit: 5,
});

let captureOffsetFallbackCalls = 0;
let folderOffsetFallbackCalls = 0;
let folderCountCalls = 0;
const originalCaptureIdsPage = manager.extGetCaptureIdsPage.bind(manager);
const originalSearchDocumentFolderPage = manager.extGetSearchDocumentFolderPage.bind(manager);
const originalSearchDocumentCount = manager.extGetSearchDocumentCount.bind(manager);
manager.extGetCaptureIdsPage = ((...args: Parameters<typeof manager.extGetCaptureIdsPage>) => {
  captureOffsetFallbackCalls += 1;
  return originalCaptureIdsPage(...args);
}) as typeof manager.extGetCaptureIdsPage;
manager.extGetSearchDocumentFolderPage = ((
  ...args: Parameters<typeof manager.extGetSearchDocumentFolderPage>
) => {
  folderOffsetFallbackCalls += 1;
  return originalSearchDocumentFolderPage(...args);
}) as typeof manager.extGetSearchDocumentFolderPage;
manager.extGetSearchDocumentCount = ((
  ...args: Parameters<typeof manager.extGetSearchDocumentCount>
) => {
  if (args[1]?.folderId) {
    folderCountCalls += 1;
  }
  return originalSearchDocumentCount(...args);
}) as typeof manager.extGetSearchDocumentCount;

const liveSource = createLiveCapturesResultSource({
  extensionName,
  extensionType: ExtensionType.TWEET,
  cachePages: 3,
});
const liveWindow = await liveSource.getWindow({ startIndex: 50, limit: 30 });
const liveWindowCached = await liveSource.getWindow({ startIndex: 50, limit: 30 });

const knownTotalFolderSource = createFolderResultSource({
  extensionName,
  entityType: 'tweet',
  folderId: 'folder-alpha',
  knownTotalCount: folderAlphaFacet?.count,
  cachePages: 3,
});
const knownTotalFolderWindow = await knownTotalFolderSource.getWindow({ startIndex: 0, limit: 16 });
const knownTotalFolderCountCalls = folderCountCalls;
folderCountCalls = 0;

const folderSource = createFolderResultSource({
  extensionName,
  entityType: 'tweet',
  folderId: 'folder-alpha',
  cachePages: 3,
});
const multiFolderSource = createFolderResultSource({
  extensionName,
  entityType: 'tweet',
  folderIds: ['folder-alpha', 'folder-beta'],
  cachePages: 3,
});
const mediaSource = createMediaResultSource({
  extensionName,
  cachePages: 3,
});
const folderWindow = await folderSource.getWindow({ startIndex: 0, limit: 16 });
const folderWindowOffset = await folderSource.getWindow({ startIndex: 30, limit: 12 });
const multiFolderWindow = await multiFolderSource.getWindow({ startIndex: 0, limit: 24 });
const multiFolderOffsetWindow = await multiFolderSource.getWindow({ startIndex: 80, limit: 12 });
const mediaWindow = await mediaSource.getWindow({ startIndex: 0, limit: 6 });
const mediaOffsetWindow = await mediaSource.getWindow({ startIndex: 6, limit: 6 });
const mediaStreamed: TweetRecord[] = [];
for await (const row of mediaSource.streamRows({ batchSize: 4 })) {
  mediaStreamed.push(row as TweetRecord);
}
const mediaFirstIds = mediaDocumentFirst.documents.map((row) => row.entity_id);
const mediaSecondIds = mediaDocumentSecond.documents.map((row) => row.entity_id);
const mediaWindowIds = ids(mediaWindow.rows as TweetRecord[]);
const mediaOffsetWindowIds = ids(mediaOffsetWindow.rows as TweetRecord[]);
const mediaStreamedIds = ids(mediaStreamed);

const legacyMediaExtensionName = 'LegacyMediaModule';
const legacyMediaTweets = [
  makeLegacyMediaTweet('legacy-media-tweet-0001', 0),
  makeLegacyMediaTweet('legacy-media-tweet-0002', 11),
];
await manager.putSyntheticSeedRows({
  tweets: legacyMediaTweets as never,
  searchDocuments: legacyMediaTweets.map((tweet, index) => ({
    ...makeLegacyMediaSearchDocument(legacyMediaExtensionName, tweet, index),
    ...(index === 0
      ? {
          media_flag: 1,
          numeric_json: { media_count: 1 },
        }
      : {}),
  })) as never,
});
const legacyMediaDocumentCount = await manager.extGetSearchDocumentMediaCount(
  legacyMediaExtensionName,
  {
    entityType: 'tweet',
  },
);
const legacyMediaFirst = await manager.extGetSearchDocumentMediaCursorPage(
  legacyMediaExtensionName,
  {
    entityType: 'tweet',
    limit: 1,
  },
);
const legacyMediaSecond = await manager.extGetSearchDocumentMediaCursorPage(
  legacyMediaExtensionName,
  {
    entityType: 'tweet',
    after: legacyMediaFirst.cursorAfter,
    limit: 1,
  },
);
const legacyMediaSource = createMediaResultSource({
  extensionName: legacyMediaExtensionName,
  cachePages: 2,
});
const legacyMediaWindow = await legacyMediaSource.getWindow({ startIndex: 0, limit: 2 });
const legacyMediaStreamed: TweetRecord[] = [];
for await (const row of legacyMediaSource.streamRows({ batchSize: 1 })) {
  legacyMediaStreamed.push(row as TweetRecord);
}
const legacyMediaFirstIds = legacyMediaFirst.documents.map((row) => row.entity_id);
const legacyMediaSecondIds = legacyMediaSecond.documents.map((row) => row.entity_id);
const legacyMediaWindowIds = ids(legacyMediaWindow.rows as TweetRecord[]);
const legacyMediaStreamedIds = ids(legacyMediaStreamed);
const multiFolderStreamed: TweetRecord[] = [];
for await (const row of multiFolderSource.streamRows({ batchSize: 17 })) {
  multiFolderStreamed.push(row as TweetRecord);
  if (multiFolderStreamed.length >= 41) break;
}
const abortController = new AbortController();
const streamedFolderRows: TweetRecord[] = [];
for await (const row of folderSource.streamRows({
  batchSize: 13,
  signal: abortController.signal,
})) {
  streamedFolderRows.push(row as TweetRecord);
  if (streamedFolderRows.length === 27) {
    abortController.abort();
  }
}
const smallFolderOffsetFallbackCalls = folderOffsetFallbackCalls;
const lruCacheExtensionName = 'LruCacheModule';
await manager.upsertCaptures(
  Array.from({ length: 40 }, (_, index) => ({
    id: `${lruCacheExtensionName}-tweet-${String(index).padStart(4, '0')}`,
    extension: lruCacheExtensionName,
    type: ExtensionType.TWEET,
    data_key: `tweet-${String(index).padStart(4, '0')}`,
    created_at: 1_500_000 + index,
  })),
);
const lruCacheSource = createLiveCapturesResultSource({
  extensionName: lruCacheExtensionName,
  extensionType: ExtensionType.TWEET,
  cachePages: 2,
});
const lruCacheKey = serializeResultSourceDescriptor(lruCacheSource.descriptor);
await lruCacheSource.getWindow({ startIndex: 0, limit: 5 });
await new Promise((resolve) => setTimeout(resolve, 2));
await lruCacheSource.getWindow({ startIndex: 5, limit: 5 });
await new Promise((resolve) => setTimeout(resolve, 2));
await lruCacheSource.getWindow({ startIndex: 0, limit: 5 });
const lruHitDiagnostics = readResultSourceDiagnostics().find(
  (entry) => entry.sourceKey === lruCacheKey,
);
await new Promise((resolve) => setTimeout(resolve, 2));
await lruCacheSource.getWindow({ startIndex: 10, limit: 5 });
await new Promise((resolve) => setTimeout(resolve, 2));
await lruCacheSource.getWindow({ startIndex: 5, limit: 5 });
const lruEvictionDiagnostics = readResultSourceDiagnostics().find(
  (entry) => entry.sourceKey === lruCacheKey,
);
await manager.upsertCaptures([
  {
    id: `${extensionName}-stale-index-probe`,
    extension: extensionName,
    type: ExtensionType.TWEET,
    data_key: 'tweet-0000',
    created_at: Date.now() + 1,
  },
]);
const staleIndexedCaptureIds = await manager.extGetCaptureIdsIndexedPage(extensionName, {
  type: ExtensionType.TWEET,
  sourceCount: captureCount,
  offset: 40,
  limit: 10,
});
const backgroundIndexExtensionName = 'BackgroundIndexModule';
const backgroundCaptureCount = 1000;
await manager.upsertCaptures(
  Array.from({ length: backgroundCaptureCount }, (_, index) => ({
    id: `${backgroundIndexExtensionName}-tweet-${String(index).padStart(4, '0')}`,
    extension: backgroundIndexExtensionName,
    type: ExtensionType.TWEET,
    data_key: `tweet-${String(index).padStart(4, '0')}`,
    created_at: 2_000_000 + index,
  })),
);
const backgroundIndexedBeforeBuild = await manager.extGetCaptureIdsIndexedPage(
  backgroundIndexExtensionName,
  {
    type: ExtensionType.TWEET,
    sourceCount: backgroundCaptureCount,
    offset: 512,
    limit: 8,
  },
);
let backgroundIndexedAfterBuild: string[] | null = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  backgroundIndexedAfterBuild = await manager.extGetCaptureIdsIndexedPage(
    backgroundIndexExtensionName,
    {
      type: ExtensionType.TWEET,
      sourceCount: backgroundCaptureCount,
      offset: 512,
      limit: 8,
    },
  );
  if (backgroundIndexedAfterBuild) break;
}

const backgroundFolderIndexExtensionName = 'BackgroundFolderIndexModule';
const backgroundFolderIndexCount = 1000;
const backgroundFolderIndexTweets = Array.from({ length: backgroundFolderIndexCount }, (_, index) =>
  makeFolderIndexTweet(index),
);
await manager.putSyntheticSeedRows({
  tweets: backgroundFolderIndexTweets as never,
  searchDocuments: backgroundFolderIndexTweets.map((tweet, index) =>
    makeFolderIndexSearchDocument(backgroundFolderIndexExtensionName, tweet, index),
  ) as never,
});
const backgroundFolderIndexSource = createFolderResultSource({
  extensionName: backgroundFolderIndexExtensionName,
  entityType: 'tweet',
  folderIds: ['folder-index-a', 'folder-index-b'],
  knownTotalCount: backgroundFolderIndexCount,
  cachePages: 2,
});
folderOffsetFallbackCalls = 0;
const backgroundFolderWindowBeforeIndex = await backgroundFolderIndexSource.getWindow({
  startIndex: 0,
  limit: 8,
});
const backgroundFolderOffsetFallbackBeforeIndex = folderOffsetFallbackCalls;
let backgroundFolderIndexedProbe: Awaited<
  ReturnType<typeof manager.extGetFolderSourceIndexedPage>
> | null = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  backgroundFolderIndexedProbe = await manager.extGetFolderSourceIndexedPage({
    sourceKey: serializeResultSourceDescriptor(backgroundFolderIndexSource.descriptor),
    extensionName: backgroundFolderIndexExtensionName,
    entityType: 'tweet',
    folderIds: ['folder-index-a', 'folder-index-b'],
    sourceCount: backgroundFolderIndexCount,
    offset: 512,
    limit: 8,
  });
  if (backgroundFolderIndexedProbe) break;
}
folderOffsetFallbackCalls = 0;
const backgroundFolderWindowAfterIndex = await backgroundFolderIndexSource.getWindow({
  startIndex: 512,
  limit: 8,
});
const backgroundFolderOffsetFallbackAfterIndex = folderOffsetFallbackCalls;

const deepFolderIndexExtensionName = 'DeepFolderIndexModule';
const deepFolderIndexCount = 5016;
const deepFolderIndexTweets = Array.from({ length: deepFolderIndexCount }, (_, index) =>
  makeFolderIndexTweet(index),
);
await manager.putSyntheticSeedRows({
  tweets: deepFolderIndexTweets as never,
  searchDocuments: deepFolderIndexTweets.map((tweet, index) =>
    makeFolderIndexSearchDocument(deepFolderIndexExtensionName, tweet, index),
  ) as never,
});
const deepFolderIndexSource = createFolderResultSource({
  extensionName: deepFolderIndexExtensionName,
  entityType: 'tweet',
  folderIds: ['folder-index-a', 'folder-index-b'],
  knownTotalCount: deepFolderIndexCount,
  cachePages: 2,
});
const deepFolderIndexPageStart = 4864;
await manager.extPutFolderSourceIndexPages({
  sourceKey: serializeResultSourceDescriptor(deepFolderIndexSource.descriptor),
  extensionName: deepFolderIndexExtensionName,
  entityType: 'tweet',
  folderIds: ['folder-index-a', 'folder-index-b'],
  sourceCount: deepFolderIndexCount,
  sourceRevision: manager.readFolderSourceIndexRevision(deepFolderIndexExtensionName),
  pages: [
    {
      pageStart: deepFolderIndexPageStart,
      rowIds: deepFolderIndexTweets.slice(deepFolderIndexPageStart).map((tweet) => tweet.rest_id),
    },
  ],
});
folderOffsetFallbackCalls = 0;
const deepFolderWindowFromIndex = await deepFolderIndexSource.getWindow({
  startIndex: 5008,
  limit: 8,
});
const deepFolderOffsetFallbackAfterIndex = folderOffsetFallbackCalls;

const diagnostics = readResultSourceDiagnostics();
const liveDiagnostics = diagnostics.find(
  (entry) => entry.sourceKey === serializeResultSourceDescriptor(liveSource.descriptor),
);
const folderDiagnostics = diagnostics.find(
  (entry) => entry.sourceKey === serializeResultSourceDescriptor(folderSource.descriptor),
);
const mediaDiagnostics = diagnostics.find(
  (entry) => entry.sourceKey === serializeResultSourceDescriptor(mediaSource.descriptor),
);

const checks = [
  {
    name: 'Dexie schema stores captures, tweets, and search documents at seeded scale',
    ok:
      counts?.tweets === 120 &&
      counts?.captures === 120 &&
      counts?.search_documents === 120 &&
      captureCount === 120 &&
      searchDocumentCount === 120,
    details: { counts, captureCount, searchDocumentCount },
  },
  {
    name: 'search document folder counts stay in IndexedDB and match seeded folders',
    ok: folderAlphaCount === 70 && folderBetaCount === 30,
    details: { folderAlphaCount, folderBetaCount },
  },
  {
    name: 'capture cursor pages advance without overlap and expose continuation state',
    ok:
      captureFirst.ids.length === 25 &&
      captureSecond.ids.length === 25 &&
      captureFirst.hasAfter &&
      captureSecond.hasBefore &&
      captureFirst.ids.every((id) => !captureSecond.ids.includes(id)),
    details: {
      firstHead: captureFirst.ids.slice(0, 3),
      firstTail: captureFirst.ids.slice(-3),
      secondHead: captureSecond.ids.slice(0, 3),
      secondTail: captureSecond.ids.slice(-3),
    },
  },
  {
    name: 'offset capture fallback still returns bounded windows for deep jumps',
    ok: offsetCaptureIds.length === 10,
    details: { offsetCaptureIds },
  },
  {
    name: 'capture index pages serve random-access windows when built',
    ok:
      captureIndexBuild === true &&
      indexedCaptureIds?.length === 10 &&
      indexedCaptureIds.join(',') === offsetCaptureIds.join(','),
    details: { captureIndexBuild, indexedCaptureIds },
  },
  {
    name: 'folder facets preserve labels, id-only status, and unfiled counts',
    ok:
      facets.totalDocuments === 120 &&
      facets.statusCounts['api-name'] === 75 &&
      facets.statusCounts['id-only'] === 35 &&
      facets.statusCounts.none === 10 &&
      folderAlphaFacet?.count === 70 &&
      folderAlphaFacet?.label === 'Alpha Folder' &&
      folderBetaFacet?.count === 30 &&
      folderBetaFacet?.status === 'id-only' &&
      folderGammaFacet?.count === 10 &&
      folderGammaFacet?.label === 'Gamma Folder' &&
      folderGammaFacet?.status === 'api-name',
    details: { facets },
  },
  {
    name: 'folder name backfill updates raw tweets, search documents, and facets',
    ok:
      betaBackfill.candidates === 30 &&
      betaBackfill.inspected === 30 &&
      betaBackfill.updated === 30 &&
      betaBackfilledTweet?.__bookmark_folder_name === 'Beta Folder' &&
      betaBackfilledTweet?.__bookmark_folder_name_source === 'api' &&
      betaBackfilledPage.documents[0]?.folder_name === 'Beta Folder' &&
      backfilledFacets.statusCounts['api-name'] === 105 &&
      backfilledFacets.statusCounts['id-only'] === 5 &&
      backfilledFacets.statusCounts.none === 10 &&
      backfilledBetaFacet?.label === 'Beta Folder' &&
      backfilledBetaFacet?.status === 'api-name',
    details: {
      betaBackfill,
      betaBackfilledTweet,
      betaBackfilledDocument: betaBackfilledPage.documents[0],
      backfilledFacets,
    },
  },
  {
    name: 'folder cursor pages use compound folder indexes and continue in folder scope',
    ok:
      folderFirst.documents.length === 20 &&
      folderSecond.documents.length === 20 &&
      folderFirst.hasAfter &&
      folderSecond.hasBefore &&
      folderFirst.documents.every((row) => row.folder_id === 'folder-alpha') &&
      folderSecond.documents.every((row) => row.folder_id === 'folder-alpha') &&
      folderFirst.documents.every(
        (row) => !folderSecond.documents.some((next) => next.id === row.id),
      ),
    details: {
      firstIds: folderFirst.documents.slice(0, 3).map((row) => row.id),
      secondIds: folderSecond.documents.slice(0, 3).map((row) => row.id),
    },
  },
  {
    name: 'folder offset fallback returns bounded windows for virtual index jumps',
    ok:
      folderOffset.documents.length === 10 &&
      folderOffset.hasBefore &&
      folderOffset.hasAfter &&
      folderOffset.documents.every((row) => row.folder_id === 'folder-alpha'),
    details: {
      ids: folderOffset.documents.map((row) => row.id),
    },
  },
  {
    name: 'media search document pages use DB media index without hydrating text-only rows',
    ok:
      mediaDocumentCount === 11 &&
      mediaDocumentFirst.documents.length === 5 &&
      mediaDocumentSecond.documents.length === 5 &&
      mediaDocumentFirst.documents.every(
        (row) => row.entity_type === 'tweet' && row.media_flag === 1,
      ) &&
      mediaDocumentSecond.documents.every(
        (row) =>
          row.entity_type === 'tweet' &&
          row.media_flag === 1 &&
          !mediaDocumentFirst.documents.some((previous) => previous.id === row.id),
      ) &&
      isNewestFirst(mediaDocumentFirst.documents) &&
      isNewestFirst(
        [mediaDocumentFirst.documents.at(-1), mediaDocumentSecond.documents[0]].filter(
          (row): row is (typeof mediaDocumentFirst.documents)[number] => Boolean(row),
        ),
      ),
    details: {
      mediaDocumentCount,
      firstIds: mediaFirstIds,
      secondIds: mediaSecondIds,
    },
  },
  {
    name: 'live result source hydrates only the requested DB window',
    ok:
      liveWindow.totalCount === 120 &&
      liveWindow.rows.length === 30 &&
      liveWindow.rowIds.length === 30 &&
      ids(liveWindow.rows as TweetRecord[]).join(',') === liveWindow.rowIds.join(','),
    details: {
      totalCount: liveWindow.totalCount,
      rowIds: liveWindow.rowIds.slice(0, 5),
      rows: ids(liveWindow.rows as TweetRecord[]).slice(0, 5),
    },
  },
  {
    name: 'live result source uses sparse cursor checkpoints instead of offset fallback',
    ok: captureOffsetFallbackCalls === 0,
    details: { captureOffsetFallbackCalls },
  },
  {
    name: 'live result source records bounded cache diagnostics and cache hits',
    ok:
      liveWindowCached.rows.length === 30 &&
      liveDiagnostics?.cachedPages === 1 &&
      liveDiagnostics?.cachedRows === 30 &&
      liveDiagnostics?.lastCacheHit === true,
    details: { liveDiagnostics },
  },
  {
    name: 'live result source LRU page cache evicts the least-recently-used window',
    ok:
      lruHitDiagnostics?.lastCacheHit === true &&
      lruEvictionDiagnostics?.lastCacheHit === false &&
      lruEvictionDiagnostics?.cachedPages === 2 &&
      lruEvictionDiagnostics?.cachedRows === 10,
    details: { lruHitDiagnostics, lruEvictionDiagnostics },
  },
  {
    name: 'folder result source uses known facet totals without redundant count queries',
    ok:
      knownTotalFolderWindow.totalCount === 70 &&
      knownTotalFolderWindow.rows.length === 16 &&
      knownTotalFolderCountCalls === 0,
    details: {
      totalCount: knownTotalFolderWindow.totalCount,
      rowIds: knownTotalFolderWindow.rowIds,
      knownTotalFolderCountCalls,
    },
  },
  {
    name: 'folder result source hydrates rows through search-document cursor pages',
    ok:
      folderWindow.totalCount === 70 &&
      folderWindow.rows.length === 16 &&
      folderWindow.rowIds.every((id) => id.startsWith('tweet-')),
    details: {
      totalCount: folderWindow.totalCount,
      rowIds: folderWindow.rowIds,
    },
  },
  {
    name: 'folder result source honors startIndex windows for virtual browsing',
    ok:
      folderWindowOffset.startIndex === 30 &&
      folderWindowOffset.rows.length === 12 &&
      folderWindowOffset.rowIds.join(',') !== folderWindow.rowIds.slice(0, 12).join(','),
    details: {
      startIndex: folderWindowOffset.startIndex,
      rowIds: folderWindowOffset.rowIds,
    },
  },
  {
    name: 'folder result sources use sparse cursor checkpoints instead of offset fallback',
    ok: smallFolderOffsetFallbackCalls === 0,
    details: { folderOffsetFallbackCalls: smallFolderOffsetFallbackCalls },
  },
  {
    name: 'multi-folder result source merges folder windows without full document hydration',
    ok:
      multiFolderWindow.totalCount === 100 &&
      multiFolderWindow.rows.length === 24 &&
      multiFolderWindow.rowIds.length === 24 &&
      multiFolderWindow.source.kind === 'folder' &&
      multiFolderWindow.source.folderIds.length === 2,
    details: {
      totalCount: multiFolderWindow.totalCount,
      rowIds: multiFolderWindow.rowIds,
      descriptor: multiFolderWindow.source,
    },
  },
  {
    name: 'multi-folder result source honors startIndex checkpoint windows',
    ok:
      multiFolderOffsetWindow.startIndex === 80 &&
      multiFolderOffsetWindow.rows.length === 12 &&
      multiFolderOffsetWindow.rowIds.every((id) => id.startsWith('tweet-')) &&
      multiFolderOffsetWindow.rowIds.join(',') !== multiFolderWindow.rowIds.slice(0, 12).join(','),
    details: {
      startIndex: multiFolderOffsetWindow.startIndex,
      rowIds: multiFolderOffsetWindow.rowIds,
    },
  },
  {
    name: 'media result source hydrates and streams only DB-indexed media tweets',
    ok:
      mediaWindow.totalCount === 11 &&
      mediaWindow.rows.length === 6 &&
      mediaOffsetWindow.rows.length === 5 &&
      mediaWindowIds.join(',') === mediaFirstIds.concat(mediaSecondIds[0]).join(',') &&
      mediaOffsetWindowIds.join(',') === mediaSecondIds.slice(1).concat('tweet-0000').join(',') &&
      mediaStreamed.length === 11 &&
      mediaStreamedIds.join(',') === mediaWindowIds.concat(mediaOffsetWindowIds).join(',') &&
      mediaDiagnostics !== undefined &&
      Number(mediaDiagnostics.cachedRows) <= 17,
    details: {
      totalCount: mediaWindow.totalCount,
      firstWindow: mediaWindowIds,
      offsetWindow: mediaOffsetWindowIds,
      streamed: mediaStreamedIds,
      mediaDiagnostics,
    },
  },
  {
    name: 'media result source merges mixed indexed and legacy media search documents',
    ok:
      legacyMediaDocumentCount === 2 &&
      legacyMediaFirst.documents.length === 1 &&
      legacyMediaSecond.documents.length === 1 &&
      legacyMediaFirstIds.join(',') === 'legacy-media-tweet-0001' &&
      legacyMediaSecondIds.join(',') === 'legacy-media-tweet-0002' &&
      legacyMediaWindow.totalCount === 2 &&
      legacyMediaWindowIds.join(',') === 'legacy-media-tweet-0001,legacy-media-tweet-0002' &&
      legacyMediaStreamedIds.join(',') === legacyMediaWindowIds.join(','),
    details: {
      legacyMediaDocumentCount,
      firstIds: legacyMediaFirstIds,
      secondIds: legacyMediaSecondIds,
      windowIds: legacyMediaWindowIds,
      streamedIds: legacyMediaStreamedIds,
    },
  },
  {
    name: 'multi-folder stream advances across merged folder cursor pages',
    ok: multiFolderStreamed.length === 41,
    details: {
      streamed: ids(multiFolderStreamed),
    },
  },
  {
    name: 'folder source stream respects abort without materializing all rows',
    ok:
      streamedFolderRows.length === 27 &&
      folderDiagnostics !== undefined &&
      Number(folderDiagnostics.cachedRows) <= 55,
    details: {
      streamed: ids(streamedFolderRows),
      folderDiagnostics,
    },
  },
  {
    name: 'capture index pages are invalidated after capture writes',
    ok: staleIndexedCaptureIds === null,
    details: { staleIndexedCaptureIds },
  },
  {
    name: 'missing capture index pages schedule a non-blocking background build',
    ok:
      backgroundIndexedBeforeBuild === null &&
      backgroundIndexedAfterBuild?.length === 8 &&
      backgroundIndexedAfterBuild[0] === 'tweet-0487',
    details: { backgroundIndexedBeforeBuild, backgroundIndexedAfterBuild },
  },
  {
    name: 'folder source index pages warm in the background without offset fallback',
    ok:
      backgroundFolderWindowBeforeIndex.rows.length === 8 &&
      backgroundFolderOffsetFallbackBeforeIndex === 0 &&
      backgroundFolderIndexedProbe?.rowIds.length === 8 &&
      backgroundFolderWindowAfterIndex.rows.length === 8 &&
      backgroundFolderWindowAfterIndex.rowIds[0] === 'folder-index-tweet-00512' &&
      backgroundFolderOffsetFallbackAfterIndex === 0,
    details: {
      beforeRowIds: backgroundFolderWindowBeforeIndex.rowIds,
      backgroundFolderOffsetFallbackBeforeIndex,
      probe: backgroundFolderIndexedProbe,
      afterRowIds: backgroundFolderWindowAfterIndex.rowIds,
      backgroundFolderOffsetFallbackAfterIndex,
    },
  },
  {
    name: 'folder source index pages serve cold deep windows beyond checkpoint range',
    ok:
      deepFolderWindowFromIndex.rows.length === 8 &&
      deepFolderWindowFromIndex.rowIds[0] === 'folder-index-tweet-05008' &&
      deepFolderOffsetFallbackAfterIndex === 0,
    details: {
      rowIds: deepFolderWindowFromIndex.rowIds,
      deepFolderOffsetFallbackAfterIndex,
    },
  },
];

const payload = {
  ok: checks.every((check) => check.ok),
  checks,
  diagnostics,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
