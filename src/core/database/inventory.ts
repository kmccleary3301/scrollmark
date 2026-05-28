const ACTIVE_DB_NAME_KEY = '__twe_active_db_name_v1';
const BOOKMARKS_EXTENSION_NAME = 'BookmarksModule';
const KNOWN_DB_NAME_PARTS = ['twitter-web-exporter', 'scrollmark'];
const TABLES = [
  'captures',
  'tweets',
  'users',
  'social_edges',
  'search_documents',
  'imported_bundles',
  'imported_entity_snapshots',
] as const;

export type IndexedDbInventoryRow = {
  name: string;
  active: boolean;
  tables: Partial<Record<(typeof TABLES)[number], number>>;
  captures_by_extension?: Record<string, number>;
  bookmark_tweet_captures?: number;
  error?: string;
};

export type IndexedDbInventory = {
  active_db_name: string | null;
  databases: IndexedDbInventoryRow[];
};

function isKnownDatabaseName(name: string): boolean {
  return KNOWN_DB_NAME_PARTS.some((part) => name.includes(part));
}

export function readActiveDatabaseName(): string | null {
  const readCandidate = (source: unknown): string | null => {
    if (!source || typeof source !== 'object') return null;
    const value = (source as Record<string, unknown>)[ACTIVE_DB_NAME_KEY];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };

  try {
    const direct = readCandidate(globalThis);
    if (direct) return direct;
  } catch {
    // ignore
  }

  try {
    if (typeof window !== 'undefined') {
      const direct = readCandidate(window);
      if (direct) return direct;
    }
  } catch {
    // ignore
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(ACTIVE_DB_NAME_KEY);
      if (stored?.trim()) return stored.trim();
    }
  } catch {
    // ignore
  }

  return null;
}

export async function listKnownIndexedDbNames(): Promise<string[]> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    return [];
  }

  try {
    const rows = await indexedDB.databases();
    return Array.from(
      new Set(
        (rows || [])
          .map((row) => row?.name)
          .filter((name): name is string => typeof name === 'string' && isKnownDatabaseName(name)),
      ),
    ).sort();
  } catch {
    return [];
  }
}

function countRequest(req: IDBRequest<number>): Promise<number> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(Number(req.result) || 0);
    req.onerror = () => resolve(0);
  });
}

async function readDatabaseInventory(
  dbName: string,
  activeDbName: string | null,
): Promise<IndexedDbInventoryRow> {
  return await new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);

    openReq.onerror = () => {
      resolve({
        name: dbName,
        active: dbName === activeDbName,
        tables: {},
        error: openReq.error?.message || 'open failed',
      });
    };

    openReq.onsuccess = () => {
      const opened = openReq.result;
      void (async () => {
        try {
          const existingTables = TABLES.filter((table) => opened.objectStoreNames.contains(table));
          if (!existingTables.length) {
            opened.close();
            resolve({ name: dbName, active: dbName === activeDbName, tables: {} });
            return;
          }

          const tables: IndexedDbInventoryRow['tables'] = {};
          const tx = opened.transaction(existingTables, 'readonly');
          tx.onerror = () => {
            opened.close();
            resolve({
              name: dbName,
              active: dbName === activeDbName,
              tables,
              error: tx.error?.message || 'transaction failed',
            });
          };

          const capturesByExtension: Record<string, number> = {};
          let bookmarkTweetCaptures: number | undefined;

          const tableCounts = existingTables.map(async (table) => {
            tables[table] = await countRequest(tx.objectStore(table).count());
          });

          const captureCounts: Array<Promise<void>> = [];
          if (existingTables.includes('captures')) {
            const captures = tx.objectStore('captures');
            if (captures.indexNames.contains('extension')) {
              captureCounts.push(
                countRequest(captures.index('extension').count(BOOKMARKS_EXTENSION_NAME)).then(
                  (count) => {
                    capturesByExtension[BOOKMARKS_EXTENSION_NAME] = count;
                  },
                ),
              );
            }
            if (captures.indexNames.contains('[extension+type]')) {
              captureCounts.push(
                countRequest(
                  captures.index('[extension+type]').count([BOOKMARKS_EXTENSION_NAME, 'tweet']),
                ).then((count) => {
                  bookmarkTweetCaptures = count;
                }),
              );
            }
          }

          await Promise.all([...tableCounts, ...captureCounts]);
          opened.close();
          resolve({
            name: dbName,
            active: dbName === activeDbName,
            tables,
            captures_by_extension: Object.keys(capturesByExtension).length
              ? capturesByExtension
              : undefined,
            bookmark_tweet_captures: bookmarkTweetCaptures,
          });
        } catch (error) {
          opened.close();
          resolve({
            name: dbName,
            active: dbName === activeDbName,
            tables: {},
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    };
  });
}

export async function collectIndexedDbInventory(): Promise<IndexedDbInventory> {
  const activeDbName = readActiveDatabaseName();
  const names = await listKnownIndexedDbNames();
  if (activeDbName && isKnownDatabaseName(activeDbName) && !names.includes(activeDbName)) {
    names.push(activeDbName);
    names.sort();
  }

  if (typeof indexedDB === 'undefined') {
    return { active_db_name: activeDbName, databases: [] };
  }

  return {
    active_db_name: activeDbName,
    databases: await Promise.all(names.map((name) => readDatabaseInventory(name, activeDbName))),
  };
}
