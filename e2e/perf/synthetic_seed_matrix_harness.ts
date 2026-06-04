import fs from 'node:fs';
import path from 'node:path';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

const [, , outPathArg = 'e2e/perf/out/synthetic-seed-matrix.json'] = process.argv;
const outPath = path.resolve(outPathArg);

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
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
  __META_DATA__: { userId: 'synthetic-seed-matrix-harness' },
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
const {
  SYNTHETIC_SEED_PRESETS,
  clearSyntheticDatabase,
  getSyntheticSeedPlan,
  seedSyntheticBookmarks,
} = await import('@/core/database/synthetic-fixtures');

type Check = {
  name: string;
  ok: boolean;
  details?: unknown;
};

type TweetLike = {
  legacy?: {
    full_text?: string;
    entities?: {
      media?: unknown[];
    };
  };
};

const checks: Check[] = [];

function record(name: string, ok: boolean, details?: unknown): void {
  checks.push({ name, ok, details });
}

function planFor(options: Parameters<typeof getSyntheticSeedPlan>[0]) {
  return getSyntheticSeedPlan(options);
}

async function seedAndCount(options: Parameters<typeof seedSyntheticBookmarks>[0]) {
  const summary = await seedSyntheticBookmarks({ clearFirst: true, ...options });
  const counts = await manager.count();
  const captureCount = await manager.extGetCaptureCount(summary.extensionName, ExtensionType.TWEET);
  const searchDocumentTweetCount = await manager.extGetSearchDocumentCount(summary.extensionName, {
    type: ExtensionType.TWEET,
  });
  return { summary, counts, captureCount, searchDocumentTweetCount };
}

const manager = getDatabaseManager();
await manager.whenReady();
await manager.clear();

for (const [name, expectedCount] of [
  ['1k', 1_000],
  ['10k', 10_000],
  ['50k', 50_000],
  ['100k', 100_000],
  ['250k', 250_000],
] as const) {
  const preset = SYNTHETIC_SEED_PRESETS[name];
  const plan = planFor(preset);
  record(`preset ${name} has expected count`, plan.tweetCount === expectedCount, plan);
  record(
    `preset ${name} includes captures, users, and search documents`,
    plan.captureCount === plan.tweetCount + plan.userCount &&
      plan.searchDocumentCount === plan.tweetCount + plan.userCount &&
      plan.storedTweetCount === plan.tweetCount,
    plan,
  );
}

const sourceWindow250k = planFor({
  count: 250_000,
  folderDistribution: 'none',
  rawRecordMode: 'source-window',
});
record(
  '250k source-window plan keeps full source index but bounded raw tweets',
  sourceWindow250k.tweetCount === 250_000 &&
    sourceWindow250k.searchDocumentCount === 250_000 + sourceWindow250k.userCount &&
    sourceWindow250k.storedTweetCount === 1_000,
  sourceWindow250k,
);

const captureScroll100k = planFor(SYNTHETIC_SEED_PRESETS.captureScroll100k);
record(
  'capture-scroll preset skips search documents while keeping complete raw captures',
  captureScroll100k.tweetCount === 100_000 &&
    captureScroll100k.storedTweetCount === 100_000 &&
    captureScroll100k.searchDocumentCount === 0,
  captureScroll100k,
);

const hugeSourceWindow = planFor({
  count: 100_000,
  folderDistribution: 'one-huge',
  rawRecordMode: 'source-window',
});
record(
  'one-huge source-window plan retains multiple hydration bands',
  hugeSourceWindow.storedTweetCount > 1_000 && hugeSourceWindow.storedTweetCount < 100_000,
  hugeSourceWindow,
);

const noneSeed = await seedAndCount({ count: 64, userCount: 4, folderDistribution: 'none' });
const noneFacets = await manager.extGetSearchDocumentFolderFacets(noneSeed.summary.extensionName, {
  type: ExtensionType.TWEET,
});
record(
  'none folder distribution writes unfiled tweet documents',
  noneSeed.summary.tweetCount === 64 &&
    noneSeed.captureCount === 64 &&
    noneSeed.searchDocumentTweetCount === 64 &&
    noneFacets.facets.length === 0 &&
    noneFacets.statusCounts.none === 64,
  { seed: noneSeed, facets: noneFacets },
);

const hugeSeed = await seedAndCount({ count: 64, userCount: 4, folderDistribution: 'one-huge' });
const hugeFacets = await manager.extGetSearchDocumentFolderFacets(hugeSeed.summary.extensionName, {
  type: ExtensionType.TWEET,
});
record(
  'one-huge folder distribution writes one large named folder',
  hugeFacets.facets.length === 1 &&
    hugeFacets.facets[0]?.folderId === 'synthetic-folder-huge' &&
    hugeFacets.facets[0]?.count === 64 &&
    hugeFacets.statusCounts['api-name'] === 64,
  hugeFacets,
);

const manySmallSeed = await seedAndCount({
  count: 512,
  userCount: 8,
  folderDistribution: 'many-small',
});
const manySmallFacets = await manager.extGetSearchDocumentFolderFacets(
  manySmallSeed.summary.extensionName,
  { type: ExtensionType.TWEET },
);
record(
  'many-small folder distribution writes many named folder facets',
  manySmallFacets.facets.length === 512 &&
    manySmallFacets.statusCounts['api-name'] === 512 &&
    manySmallFacets.facets.every((facet) => facet.count === 1),
  { facetCount: manySmallFacets.facets.length, statusCounts: manySmallFacets.statusCounts },
);

const mixedSeed = await seedAndCount({ count: 210, userCount: 8, folderDistribution: 'mixed' });
const mixedFacets = await manager.extGetSearchDocumentFolderFacets(
  mixedSeed.summary.extensionName,
  {
    type: ExtensionType.TWEET,
  },
);
record(
  'mixed folder distribution includes unfiled, id-only, and api-name folder states',
  mixedFacets.statusCounts.none > 0 &&
    mixedFacets.statusCounts['id-only'] > 0 &&
    mixedFacets.statusCounts['api-name'] > 0,
  mixedFacets.statusCounts,
);

const variableSeed = await seedAndCount({
  count: 90,
  userCount: 6,
  folderDistribution: 'mixed',
  contentProfile: 'variable-heights',
});
const variableTweet = (await manager.extGetTweetsByIds(['8000000000000']))[0] as TweetLike;
record(
  'variable-height content profile writes long text and media rows',
  variableSeed.summary.contentProfile === 'variable-heights' &&
    String(variableTweet?.legacy?.full_text || '').includes('force wrapped table content') &&
    Number(variableTweet?.legacy?.entities?.media?.length || 0) > 0,
  { seed: variableSeed.summary, tweet: variableTweet?.legacy },
);

await seedAndCount({
  count: 1_000,
  userCount: 8,
  folderDistribution: 'mixed',
  contentProfile: 'sparse-media',
});
const sparseTweets = (await manager.extGetTweetsByIds([
  '8000000000000',
  '8000000000997',
])) as TweetLike[];
record(
  'sparse-media profile writes sparse media checkpoints',
  sparseTweets.length === 2 &&
    sparseTweets.every((tweet) => Number(tweet?.legacy?.entities?.media?.length || 0) > 0),
  sparseTweets.map((tweet) => tweet?.legacy?.entities?.media?.length || 0),
);

const denseSourceSeed = await seedAndCount({
  count: 96,
  userCount: 8,
  folderDistribution: 'mixed',
  rawRecordMode: 'source-window',
  contentProfile: 'dense-media',
});
record(
  'dense-media source-window mode stores every raw tweet needed for media hydration',
  denseSourceSeed.summary.rawRecordMode === 'source-window' &&
    denseSourceSeed.summary.contentProfile === 'dense-media' &&
    denseSourceSeed.summary.storedTweetCount === 96 &&
    denseSourceSeed.counts?.tweets === 96,
  denseSourceSeed,
);

const sourceWindowSeed = await seedAndCount({
  count: 2_500,
  userCount: 25,
  folderDistribution: 'none',
  rawRecordMode: 'source-window',
});
record(
  'source-window raw mode writes full capture/search indexes with bounded raw records',
  sourceWindowSeed.summary.storedTweetCount === 1_000 &&
    sourceWindowSeed.counts?.tweets === 1_000 &&
    sourceWindowSeed.captureCount === 2_500 &&
    sourceWindowSeed.searchDocumentTweetCount === 2_500,
  sourceWindowSeed,
);

const noSearchSeed = await seedAndCount({
  count: 128,
  userCount: 8,
  folderDistribution: 'none',
  includeSearchDocuments: false,
});
record(
  'includeSearchDocuments false skips tweet and user search documents',
  noSearchSeed.summary.searchDocumentCount === 0 &&
    noSearchSeed.searchDocumentTweetCount === 0 &&
    noSearchSeed.counts?.search_documents === 0,
  noSearchSeed,
);

await clearSyntheticDatabase();
const clearedCounts = await manager.count();
record(
  'clearSyntheticDatabase clears synthetic rows',
  Boolean(
    clearedCounts &&
    clearedCounts.tweets === 0 &&
    clearedCounts.users === 0 &&
    clearedCounts.captures === 0 &&
    clearedCounts.search_documents === 0,
  ),
  clearedCounts,
);

const report = {
  ok: checks.every((check) => check.ok),
  checks,
  generatedAt: new Date().toISOString(),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
