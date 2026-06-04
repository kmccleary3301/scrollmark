import fs from 'node:fs';
import path from 'node:path';
import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import type { Tweet, User } from '@/types';

const [, , outPathArg = 'e2e/perf/out/write-indexing-regression.json'] = process.argv;
const outPath = path.resolve(outPathArg);
const ROW_COUNT = Number(process.env.SCROLLMARK_WRITE_INDEXING_ROWS || 1505);
const EXTENSION_NAME = 'BookmarksModule';
const ID_ONLY_CAPTURE_COUNT = 1;

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
localStorage.setItem('scrollmark', JSON.stringify({ dedicatedDbForAccounts: true }));

const windowMock = {
  localStorage,
  setTimeout,
  clearTimeout,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  __META_DATA__: { userId: 'write-indexing-regression' },
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
const { DatabaseManager } = await import('@/core/database/manager');

function makeUser(index: number, now: number): User {
  const id = String(7000000000000 + index);
  return {
    __typename: 'User',
    id,
    rest_id: id,
    affiliates_highlighted_label: {},
    has_graduated_access: true,
    is_blue_verified: false,
    profile_image_shape: 'Circle',
    legacy: {
      default_profile: false,
      default_profile_image: false,
      description: `Write regression author ${index}`,
      entities: { description: { urls: [] }, url: { urls: [] } },
      fast_followers_count: 0,
      favourites_count: 0,
      followers_count: 0,
      friends_count: 0,
      has_custom_timelines: false,
      is_translator: false,
      listed_count: 0,
      media_count: 0,
      normal_followers_count: 0,
      pinned_tweet_ids_str: [],
      possibly_sensitive: false,
      profile_interstitial_type: '',
      statuses_count: 0,
      translator_type: 'none',
      want_retweets: true,
      withheld_in_countries: [],
    },
    avatar: { image_url: `https://example.invalid/write-author-${index}.jpg` },
    core: {
      created_at: new Date(now - index * 60_000).toUTCString(),
      name: `Write Regression Author ${index}`,
      screen_name: `write_author_${index}`,
    },
    dm_permissions: { can_dm: false },
    location: { location: '' },
    media_permissions: { can_media_tag: false },
    privacy: { protected: false },
    verification: { verified: false },
    relationship_perspectives: { following: false, followed_by: false },
    twe_private_fields: { created_at: now - index * 60_000, updated_at: now },
  } as User;
}

function makeTweet(index: number, author: User, now: number): Tweet {
  const id = String(6000000000000 + index);
  const createdAt = now - index * 1000;
  const folderIndex = index % 7;
  const tweet = {
    __typename: 'Tweet',
    rest_id: id,
    core: { user_results: { result: author } },
    edit_control: {
      edit_tweet_ids: [id],
      editable_until_msecs: String(createdAt + 3_600_000),
      is_edit_eligible: false,
      edits_remaining: '0',
    },
    is_translatable: false,
    views: { count: String(index), state: 'EnabledWithCount' },
    source: 'Scrollmark write regression harness',
    legacy: {
      bookmark_count: index % 17,
      bookmarked: true,
      created_at: new Date(createdAt).toUTCString(),
      conversation_id_str: id,
      display_text_range: [0, 120],
      entities: { hashtags: [], symbols: [], timestamps: [], urls: [], user_mentions: [] },
      favorite_count: index % 101,
      favorited: false,
      full_text: `Write indexing regression row ${index} folder ${folderIndex}`,
      id_str: id,
      is_quote_status: false,
      lang: 'en',
      possibly_sensitive: false,
      possibly_sensitive_editable: false,
      quote_count: 0,
      reply_count: index % 5,
      retweet_count: index % 11,
      retweeted: false,
      user_id_str: author.rest_id,
    },
    twe_private_fields: {
      created_at: createdAt,
      updated_at: now,
      media_count: 0,
    },
    __bookmark_folder_id: `write-folder-${folderIndex}`,
    __bookmark_folder_name: `Write Folder ${folderIndex}`,
    __bookmark_folder_name_source: 'api',
  };
  return tweet as unknown as Tweet;
}

const dbName = 'twitter-web-exporter_write-indexing-regression';
await indexedDB.deleteDatabase(dbName);

const startedAt = performance.now();
const manager = new DatabaseManager();
await manager.whenReady();
await manager.clear();

const now = Date.now();
const authors = Array.from({ length: 8 }, (_, index) => makeUser(index, now));
const tweets = Array.from({ length: ROW_COUNT }, (_, index) =>
  makeTweet(index, authors[index % authors.length]!, now),
);

const firstWrite = manager.extAddTweets(EXTENSION_NAME, tweets);
const queuedCaptureRewrite = manager.extAddTweetCaptureIds(
  EXTENSION_NAME,
  tweets
    .slice(0, 750)
    .map((tweet) => tweet.rest_id)
    .concat('missing-write-row'),
);
await Promise.all([firstWrite, queuedCaptureRewrite]);

const countsAfterFirstWrite = await manager.count();
const captureCountAfterFirstWrite = await manager.extGetCaptureCount(
  EXTENSION_NAME,
  ExtensionType.TWEET,
);
const searchCountAfterFirstWrite = await manager.extGetSearchDocumentCount(EXTENSION_NAME, {
  entityType: 'tweet',
});
const facetsAfterFirstWrite = await manager.extGetSearchDocumentFolderFacets(EXTENSION_NAME, {
  entityType: 'tweet',
});

const firstIndexBuild = await manager.extBuildCaptureIndexPages(EXTENSION_NAME, {
  type: ExtensionType.TWEET,
  sourceCount: captureCountAfterFirstWrite,
});
const firstIndexedPage = await manager.extGetCaptureIdsIndexedPage(EXTENSION_NAME, {
  type: ExtensionType.TWEET,
  sourceCount: captureCountAfterFirstWrite,
  offset: 512,
  limit: 16,
});
const firstFallbackPage = await manager.extGetCaptureIdsPage(EXTENSION_NAME, {
  type: ExtensionType.TWEET,
  offset: 512,
  limit: 16,
});

const extraTweets = Array.from({ length: 37 }, (_, index) =>
  makeTweet(ROW_COUNT + index, authors[index % authors.length]!, now),
);
await manager.extAddTweets(EXTENSION_NAME, extraTweets);
const finalCount = ROW_COUNT + extraTweets.length;
const countsAfterSecondWrite = await manager.count();
const captureCountAfterSecondWrite = await manager.extGetCaptureCount(
  EXTENSION_NAME,
  ExtensionType.TWEET,
);
const staleIndexedPage = await manager.extGetCaptureIdsIndexedPage(EXTENSION_NAME, {
  type: ExtensionType.TWEET,
  sourceCount: captureCountAfterFirstWrite,
  offset: 512,
  limit: 16,
});
const secondIndexBuild = await manager.extBuildCaptureIndexPages(EXTENSION_NAME, {
  type: ExtensionType.TWEET,
  sourceCount: captureCountAfterSecondWrite,
});
const secondIndexedPage = await manager.extGetCaptureIdsIndexedPage(EXTENSION_NAME, {
  type: ExtensionType.TWEET,
  sourceCount: captureCountAfterSecondWrite,
  offset: 512,
  limit: 16,
});
const secondFallbackPage = await manager.extGetCaptureIdsPage(EXTENSION_NAME, {
  type: ExtensionType.TWEET,
  offset: 512,
  limit: 16,
});

const checks = [
  {
    name: 'chunked normal tweet indexing writes all captures and search documents',
    ok:
      countsAfterFirstWrite.tweets === ROW_COUNT &&
      countsAfterFirstWrite.captures === ROW_COUNT + ID_ONLY_CAPTURE_COUNT &&
      countsAfterFirstWrite.search_documents === ROW_COUNT &&
      captureCountAfterFirstWrite === ROW_COUNT + ID_ONLY_CAPTURE_COUNT &&
      searchCountAfterFirstWrite === ROW_COUNT &&
      facetsAfterFirstWrite.facets.length === 7 &&
      facetsAfterFirstWrite.facets.reduce((sum, facet) => sum + facet.count, 0) === ROW_COUNT,
    details: {
      rowCount: ROW_COUNT,
      countsAfterFirstWrite,
      captureCountAfterFirstWrite,
      searchCountAfterFirstWrite,
      facetsAfterFirstWrite,
    },
  },
  {
    name: 'queued capture rewrite waits for the initial large write and preserves indexed rows',
    ok:
      countsAfterFirstWrite.captures === ROW_COUNT + ID_ONLY_CAPTURE_COUNT &&
      countsAfterFirstWrite.tweets === ROW_COUNT &&
      countsAfterFirstWrite.search_documents === ROW_COUNT,
    details: { countsAfterFirstWrite },
  },
  {
    name: 'capture index pages match fallback after large chunked write',
    ok:
      firstIndexBuild === true &&
      firstIndexedPage?.length === 16 &&
      firstIndexedPage.join(',') === firstFallbackPage.join(','),
    details: { firstIndexBuild, firstIndexedPage, firstFallbackPage },
  },
  {
    name: 'later writes invalidate stale capture index pages and rebuild fresh pages',
    ok:
      countsAfterSecondWrite.tweets === finalCount &&
      countsAfterSecondWrite.captures === finalCount + ID_ONLY_CAPTURE_COUNT &&
      countsAfterSecondWrite.search_documents === finalCount &&
      captureCountAfterSecondWrite === finalCount + ID_ONLY_CAPTURE_COUNT &&
      staleIndexedPage === null &&
      secondIndexBuild === true &&
      secondIndexedPage?.length === 16 &&
      secondIndexedPage.join(',') === secondFallbackPage.join(','),
    details: {
      finalCount,
      countsAfterSecondWrite,
      captureCountAfterSecondWrite,
      staleIndexedPage,
      secondIndexBuild,
      secondIndexedPage,
      secondFallbackPage,
    },
  },
];

const payload = {
  ok: checks.every((check) => check.ok),
  generatedAt: new Date().toISOString(),
  rowCount: ROW_COUNT,
  elapsedMs: performance.now() - startedAt,
  checks,
};

(manager as unknown as { db: Dexie }).db.close();

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
