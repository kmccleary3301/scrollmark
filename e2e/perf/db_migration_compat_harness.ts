import fs from 'node:fs';
import path from 'node:path';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import type Dexie from 'dexie';

const [, , outPathArg = 'e2e/perf/out/db-migration-compat.json'] = process.argv;
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
localStorage.setItem('scrollmark', JSON.stringify({ dedicatedDbForAccounts: true }));

const windowMock = {
  localStorage,
  setTimeout,
  clearTimeout,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  __META_DATA__: { userId: 'migration-empty' },
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
const { default: DexieRuntime } = await import('dexie');

function setUserId(userId: string): void {
  windowMock.__META_DATA__.userId = userId;
}

function closeManager(manager: InstanceType<typeof DatabaseManager>): void {
  (manager as unknown as { db: Dexie }).db.close();
}

async function readDbInfo(name: string): Promise<{ name: string; version?: number } | undefined> {
  const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
  return databases.find((row) => row.name === name);
}

async function createSyntheticV6Db(name: string): Promise<void> {
  await indexedDB.deleteDatabase(name);
  const db = new DexieRuntime(name);
  db.version(6).stores({
    tweets: 'rest_id,legacy.created_at,core.user_results.result.rest_id',
    users: 'rest_id,core.screen_name',
    captures: 'id,extension,type,created_at,[extension+type],[extension+type+created_at]',
    search_documents:
      'id,source_key,source_kind,entity_type,entity_id,extension_name,bundle_id,bundle_item_id,updated_at_ms,created_at_ms,observed_at_ms,author_screen_name,author_id,folder_id,[source_key+entity_type],[extension_name+entity_type],[bundle_id+entity_type],[entity_type+entity_id]',
  });
  await db.open();
  await db.table('captures').bulkPut([
    {
      id: 'old-capture-1',
      extension: 'BookmarksModule',
      type: 'tweet',
      data_key: 'old-tweet-1',
      created_at: 1710000000000,
    },
    {
      id: 'old-capture-2',
      extension: 'BookmarksModule',
      type: 'tweet',
      data_key: 'old-tweet-2',
      created_at: 1710000001000,
    },
  ]);
  await db.table('search_documents').bulkPut([
    {
      id: 'live:BookmarksModule:tweet:old-tweet-1',
      source_key: 'BookmarksModule',
      source_kind: 'live',
      entity_type: 'tweet',
      entity_id: 'old-tweet-1',
      extension_name: 'BookmarksModule',
      updated_at_ms: 1710000000000,
      created_at_ms: 1710000000000,
      observed_at_ms: 1710000000000,
      author_screen_name: 'migration_author',
      author_id: 'author-1',
      folder_id: 'folder-a',
      folder_name: 'Migration Folder',
      title: 'Synthetic migration row one',
      text: 'Synthetic migration row one',
      url: 'https://x.com/migration/status/old-tweet-1',
      media: [],
      metrics: {},
      doc_hash: 'old-doc-1',
    },
    {
      id: 'live:BookmarksModule:tweet:old-tweet-2',
      source_key: 'BookmarksModule',
      source_kind: 'live',
      entity_type: 'tweet',
      entity_id: 'old-tweet-2',
      extension_name: 'BookmarksModule',
      updated_at_ms: 1710000001000,
      created_at_ms: 1710000001000,
      observed_at_ms: 1710000001000,
      author_screen_name: 'migration_author',
      author_id: 'author-1',
      folder_id: 'folder-a',
      folder_name: 'Migration Folder',
      title: 'Synthetic migration row two',
      text: 'Synthetic migration row two',
      url: 'https://x.com/migration/status/old-tweet-2',
      media: [],
      metrics: {},
      doc_hash: 'old-doc-2',
    },
  ]);
  db.close();
}

async function openCurrentManager(userId: string): Promise<InstanceType<typeof DatabaseManager>> {
  setUserId(userId);
  const manager = new DatabaseManager();
  await manager.whenReady();
  return manager;
}

const checks: Array<{ name: string; ok: boolean; details: unknown }> = [];

const emptyDbName = 'twitter-web-exporter_migration-empty';
await indexedDB.deleteDatabase(emptyDbName);
const emptyManager = await openCurrentManager('migration-empty');
const emptyInfo = await readDbInfo(emptyDbName);
const emptyCounts = await emptyManager.count();
checks.push({
  name: 'empty database opens on current schema',
  ok:
    emptyInfo?.version === 100 &&
    emptyCounts.captures === 0 &&
    emptyCounts.tweets === 0 &&
    emptyCounts.users === 0 &&
    emptyCounts.search_documents === 0 &&
    emptyCounts.folder_source_index_pages === 0,
  details: { emptyInfo, emptyCounts },
});
closeManager(emptyManager);

const oldDbName = 'twitter-web-exporter_migration-v6';
await createSyntheticV6Db(oldDbName);
const oldInfoBefore = await readDbInfo(oldDbName);
const oldManager = await openCurrentManager('migration-v6');
const oldInfoAfter = await readDbInfo(oldDbName);
const oldCounts = await oldManager.count();
const oldCaptureCount = await oldManager.extGetCaptureCount('BookmarksModule', ExtensionType.TWEET);
const oldCaptureIds = await oldManager.extGetCaptureIdsPage('BookmarksModule', {
  type: ExtensionType.TWEET,
  offset: 0,
  limit: 10,
});
const oldFolderFacets = await oldManager.extGetSearchDocumentFolderFacets('BookmarksModule', {
  entityType: 'tweet',
});
const oldCaptureIndexBuild = await oldManager.extBuildCaptureIndexPages('BookmarksModule', {
  type: ExtensionType.TWEET,
  sourceCount: oldCaptureCount,
});
const oldIndexedCaptureIds = await oldManager.extGetCaptureIdsIndexedPage('BookmarksModule', {
  type: ExtensionType.TWEET,
  sourceCount: oldCaptureCount,
  offset: 0,
  limit: 10,
});
checks.push({
  name: 'synthetic v6 database upgrades to current schema without losing source rows',
  ok:
    oldInfoBefore?.version === 60 &&
    oldInfoAfter?.version === 100 &&
    oldCounts.captures === 2 &&
    oldCounts.search_documents === 2 &&
    oldCaptureCount === 2 &&
    oldCaptureIds.join(',') === 'old-tweet-2,old-tweet-1' &&
    oldFolderFacets.facets[0]?.folderId === 'folder-a' &&
    oldFolderFacets.facets[0]?.count === 2 &&
    oldCaptureIndexBuild === true &&
    oldIndexedCaptureIds?.join(',') === oldCaptureIds.join(',') &&
    typeof oldCounts.folder_source_index_pages === 'number',
  details: {
    oldInfoBefore,
    oldInfoAfter,
    oldCounts,
    oldCaptureCount,
    oldCaptureIds,
    oldFolderFacets,
    oldCaptureIndexBuild,
    oldIndexedCaptureIds,
  },
});
closeManager(oldManager);

const payload = {
  ok: checks.every((check) => check.ok),
  generatedAt: new Date().toISOString(),
  checks,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
